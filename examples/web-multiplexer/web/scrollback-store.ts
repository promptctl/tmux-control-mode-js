// examples/web-multiplexer/web/scrollback-store.ts
//
// ScrollbackTimeMachineStore — the IO boundary for the bidirectional time
// machine. It does what the .5 recorder does (capture the all-pane firehose with
// timing, freeze it, drive one scrub clock) and adds the .9 axis: at the instant
// recording begins it takes a `capture-pane -e -p -S - -E -` SEED of every pane —
// each pane's full scrollback PLUS visible screen, re-encoded by tmux as
// SGR-bearing rows. The seed is the pre-record history the browser never attached
// to; the firehose is the forward stream. The pure `scrollback-engine` binds them
// into one scrubbable timeline. This store owns only the clocks and the tmux IO.
//
// [LAW:no-ambient-temporal-coupling] ORDERING IS OWNED, NOT INCIDENTAL: the seed
//   capture must COMPLETE before firehose buffering opens, or a forward byte
//   would be counted twice (once baked into a later seed, once in the stream).
//   `startRecording` awaits every `capture-pane`, THEN flips `phase` to
//   "recording" and stamps `captureStartedAt`; only from that flip does
//   `onFirehoseBytes` buffer. The cost is a sub-frame gap between the capture
//   instant and the first buffered byte — surfaced here, not hidden.
// [LAW:effects-at-boundaries] The firehose subscription, the wall clock, and the
//   playback ticker live here. The seed capture (list-panes + capture-pane) is
//   shared IO lifted to `recording-capture`; the byte math it feeds —
//   `momentBytes` / `bytesUpTo` — is pure and unit-tested.
// [LAW:one-source-of-truth] The frozen `Recording` + the per-pane snapshot map
//   are the two artifacts; everything the view shows is DERIVED from them by the
//   engine, never tracked as parallel state. The verbatim-identical capture
//   pieces shared with the .10 moment diff (`captureSeeds`, `parsePaneList`, the
//   caps, `firstKey`, `now`) are imported from `recording-capture`, not re-stated.

import { makeAutoObservable, runInAction } from "mobx";
import type { TmuxBridge } from "./bridge.ts";
import {
  EMPTY_RECORDING,
  buildRecording,
  busiestPane,
  type PaneGeometry,
  type Recording,
  type RecordedChunk,
} from "./session-recording-engine.ts";
import {
  splitFraction,
  type ScrollbackSnapshot,
  type Timeline,
} from "./scrollback-engine.ts";
import {
  MAX_RECORDING_BYTES,
  captureSeeds,
  firstKey,
  now,
} from "./recording-capture.ts";

/** Playback ticker cadence — ~30fps is smooth for a scrubbing terminal. */
const TICK_INTERVAL_MS = 33;

/** Discrete lifecycle. [LAW:no-mode-explosion] three states, no flags. */
export type RecorderPhase = "idle" | "recording" | "review";

/** Available playback speeds. */
export const PLAYBACK_RATES = [0.5, 1, 2, 4] as const;
export type PlaybackRate = (typeof PLAYBACK_RATES)[number];

export class ScrollbackTimeMachineStore {
  phase: RecorderPhase = "idle";
  /** True while the firehose taps are open (the mode is active). */
  active = false;

  /** The frozen forward artifact, available in `review`. */
  recording: Recording = EMPTY_RECORDING;
  /** Per-pane seed snapshots captured at record-start; empty until `review`. */
  snapshots: ReadonlyMap<number, ScrollbackSnapshot> = new Map();

  /** Elapsed capture time, ticked live so the UI can show a duration counter. */
  liveDurationMs = 0;
  /** Set when a recording auto-stopped at the byte cap. */
  limitHit = false;
  /** Set when more panes existed than `MAX_SEEDED_PANES` and some were skipped. */
  seedTruncated = false;
  /** True while the seed `capture-pane` burst is in flight (record is arming). */
  seeding = false;

  /** Which recorded pane the time machine renders. */
  selectedPaneId: number | null = null;

  /** Scrub position on the unified `[0,1]` history→time axis. */
  pos = 0;
  playing = false;
  rate: PlaybackRate = 1;

  // --- capture buffer (non-observable; frozen into `recording` on stop) ---
  private buffer: RecordedChunk[] = [];
  private capturedBytes = 0;
  private captureStartedAt = 0;
  private pendingSeeds = new Map<number, ScrollbackSnapshot>();
  private readonly geometry = new Map<number, PaneGeometry>();

  // --- playback clock ---
  private lastTickAt = 0;
  private readonly ticker: ReturnType<typeof setInterval>;

  private readonly disposeOnFirehose: () => void;
  private readonly disposeOnState: () => void;

  constructor(private readonly bridge: TmuxBridge) {
    makeAutoObservable<
      this,
      | "bridge"
      | "buffer"
      | "capturedBytes"
      | "captureStartedAt"
      | "pendingSeeds"
      | "geometry"
      | "lastTickAt"
      | "ticker"
      | "disposeOnFirehose"
      | "disposeOnState"
    >(this, {
      bridge: false,
      buffer: false,
      capturedBytes: false,
      captureStartedAt: false,
      pendingSeeds: false,
      geometry: false,
      lastTickAt: false,
      ticker: false,
      disposeOnFirehose: false,
      disposeOnState: false,
    });

    this.disposeOnFirehose = bridge.onFirehose((paneId, data) =>
      this.onFirehoseBytes(paneId, data),
    );

    // A reconnect drops the previous server's taps; re-open if the mode is still
    // active so a new recording can capture the new server.
    this.disposeOnState = bridge.onState((state) => {
      if (state === "ready" && this.active) this.bridge.startFirehose();
    });

    this.lastTickAt = now();
    this.ticker = setInterval(() => this.tick(), TICK_INTERVAL_MS);
  }

  dispose(): void {
    this.disposeOnFirehose();
    this.disposeOnState();
    clearInterval(this.ticker);
    if (this.active) this.bridge.stopFirehose();
  }

  // -------------------------------------------------------------------------
  // Firehose lifecycle (mode active)
  // -------------------------------------------------------------------------

  /** Open the firehose taps. Idempotent. Called on entering the mode. */
  start(): void {
    if (this.active) return;
    this.active = true;
    this.bridge.startFirehose();
  }

  /** Close the firehose taps on leaving the mode; freeze any in-progress capture. */
  stop(): void {
    if (!this.active) return;
    if (this.phase === "recording") this.stopRecording();
    this.active = false;
    this.bridge.stopFirehose();
  }

  // -------------------------------------------------------------------------
  // Recording lifecycle
  // -------------------------------------------------------------------------

  /**
   * Arm and begin recording: FIRST capture every pane's scrollback seed, THEN
   * open forward buffering. The await between the two halves is the whole point —
   * it guarantees no forward byte is both seeded and streamed. A double Record is
   * ignored while seeding or recording.
   */
  startRecording(): void {
    if (this.phase === "recording" || this.seeding) return;
    runInAction(() => {
      this.seeding = true;
      this.limitHit = false;
      this.seedTruncated = false;
      this.recording = EMPTY_RECORDING;
      this.snapshots = new Map();
      this.selectedPaneId = null;
      this.playing = false;
      this.pos = 0;
      this.liveDurationMs = 0;
    });
    void captureSeeds(this.bridge, "time machine").then(
      ({ seeds, truncated }) => {
        // The mode may have been left while seeds were in flight — abandon if so.
        if (!this.active) {
          runInAction(() => {
            this.seeding = false;
          });
          return;
        }
        this.pendingSeeds = seeds;
        this.geometry.clear();
        for (const [paneId, snap] of seeds)
          this.geometry.set(paneId, snap.geometry);
        this.buffer = [];
        this.capturedBytes = 0;
        this.captureStartedAt = now();
        runInAction(() => {
          this.seeding = false;
          this.seedTruncated = truncated;
          this.phase = "recording";
        });
      },
    );
  }

  /** Freeze the forward buffer + seeds into the review artifacts. */
  stopRecording(): void {
    if (this.phase !== "recording") return;
    const rec = buildRecording(this.buffer, this.geometry);
    const seeds = this.pendingSeeds;
    // The replayable panes are the SEEDED ones; prefer the busiest among them so
    // review opens on the most interesting pane that can actually be scrubbed.
    const busiest = busiestPane(rec);
    const selected =
      busiest !== null && seeds.has(busiest) ? busiest : firstKey(seeds);
    runInAction(() => {
      this.recording = rec;
      this.snapshots = seeds;
      this.phase = "review";
      this.playing = false;
      this.selectedPaneId = selected;
      // Open at the "now" boundary (t=0) when there is history to scrub back
      // into — both directions are then one drag away. A pure-forward recording
      // opens at its end, like the .5 recorder.
      const tl = selected === null ? null : this.timelineFor(selected);
      this.pos = tl === null ? 0 : openingPos(tl);
    });
  }

  /** Discard the current recording and return to idle (armed). */
  reset(): void {
    runInAction(() => {
      this.phase = "idle";
      this.recording = EMPTY_RECORDING;
      this.snapshots = new Map();
      this.selectedPaneId = null;
      this.playing = false;
      this.pos = 0;
      this.liveDurationMs = 0;
      this.limitHit = false;
      this.seedTruncated = false;
    });
  }

  private onFirehoseBytes(paneId: number, data: Uint8Array): void {
    if (this.phase !== "recording") return;
    // Own the bytes immutably — the transport may reuse its backing buffer.
    const bytes = data.slice();
    this.buffer.push({ paneId, tMs: now() - this.captureStartedAt, bytes });
    this.capturedBytes += bytes.length;
    if (this.capturedBytes >= MAX_RECORDING_BYTES) {
      runInAction(() => {
        this.limitHit = true;
      });
      this.stopRecording();
    }
  }

  // -------------------------------------------------------------------------
  // Review / playback
  // -------------------------------------------------------------------------

  /** Build the per-pane timeline the engine renders. Null if the pane has no seed. */
  timelineFor(paneId: number): Timeline | null {
    const snapshot = this.snapshots.get(paneId);
    if (snapshot === undefined) return null;
    return {
      snapshot,
      recording: this.recording,
      paneId,
      durationMs: this.recording.durationMs,
    };
  }

  /** The selected pane's timeline, or null if none is renderable. */
  get timeline(): Timeline | null {
    return this.selectedPaneId === null
      ? null
      : this.timelineFor(this.selectedPaneId);
  }

  selectPane(paneId: number): void {
    this.selectedPaneId = paneId;
    this.playing = false;
    const tl = this.timelineFor(paneId);
    this.pos = tl === null ? 0 : openingPos(tl);
  }

  togglePlay(): void {
    if (this.playing) this.pause();
    else this.play();
  }

  play(): void {
    const tl = this.timeline;
    if (tl === null || tl.durationMs <= 0) return;
    // Pressing play restarts forward from the "now" boundary when parked at the
    // end — standard transport UX.
    if (this.pos >= 1) this.pos = splitFraction(tl);
    this.lastTickAt = now();
    this.playing = true;
  }

  pause(): void {
    this.playing = false;
  }

  /** Scrub to an absolute fraction `[0,1]`, clamped. Dragging does not pause. */
  seek(frac: number): void {
    this.pos = Math.max(0, Math.min(1, frac));
  }

  setRate(rate: PlaybackRate): void {
    this.rate = rate;
  }

  /**
   * The single timing authority. While recording it advances the live counter;
   * while playing it advances `pos` through the LIVE region only (history is
   * spatial, not temporal) by real elapsed time × rate, snapping into the live
   * region first if play began from a scrollback position, and parking at the end.
   * [LAW:no-ambient-temporal-coupling] one owner for the playhead.
   */
  private tick(): void {
    const t = now();
    const dt = t - this.lastTickAt;
    this.lastTickAt = t;
    if (this.phase === "recording") {
      runInAction(() => {
        this.liveDurationMs = t - this.captureStartedAt;
      });
      return;
    }
    if (!this.playing) return;
    const tl = this.timeline;
    if (tl === null || tl.durationMs <= 0) {
      this.playing = false;
      return;
    }
    const split = splitFraction(tl);
    const span = 1 - split;
    runInAction(() => {
      // Entering playback from history starts the clock at t=0.
      const from = this.pos < split ? split : this.pos;
      const dPos = span <= 0 ? 0 : ((dt * this.rate) / tl.durationMs) * span;
      const next = from + dPos;
      if (next >= 1) {
        this.pos = 1;
        this.playing = false;
      } else {
        this.pos = next;
      }
    });
  }
}

/**
 * Where to park the scrub head when review opens: the "now" boundary when there
 * is scrollback to walk back into (so both directions are one drag away),
 * otherwise the end of the recording (a pure-forward clip, like the .5 recorder).
 */
function openingPos(tl: Timeline): number {
  const split = splitFraction(tl);
  return split > 0 && split < 1 ? split : 1;
}
