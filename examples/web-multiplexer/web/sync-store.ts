// examples/web-multiplexer/web/sync-store.ts
//
// SyncScrollStore — the IO boundary for "synchronized scrollback across linked
// panes". It captures the same way the .9 time machine does (seed every pane with
// a `capture-pane -e` snapshot at record-start, THEN record the forward firehose),
// and adds the .13 axis: ONE shared scrub cursor drives N linked panes in
// lockstep, every one reconstructed at the same recorded instant.
//
// WHAT DIVERGES FROM .9 (why this is its own store, not a base class — the
// SHOWCASE warns against forcing one shape over genuinely different demos
// [LAW:no-mode-explosion]): .9 scrubs ONE pane on a unified history+time axis;
// .13 scrubs N panes on a LIVE-ONLY shared axis. Scrollback rows are
// untimestamped, so there is no shared scrollback position across panes — the sync
// cursor is recorded time and only recorded time. The identical capture pieces
// (`captureSeeds`, the caps, `now`) are imported from `recording-capture`, not
// re-stated. [LAW:one-source-of-truth]
//
// [LAW:no-ambient-temporal-coupling] ORDERING IS OWNED: the seed capture must
//   COMPLETE before firehose buffering opens, or a forward byte would be counted
//   twice (baked into a seed AND streamed). `startRecording` awaits every
//   `capture-pane`, then flips `phase` and stamps `captureStartedAt`.
// [LAW:effects-at-boundaries] The firehose subscription, the wall clock and the
//   playback ticker live here. The byte math the view paints — `paintAt`,
//   `forwardDelta`, `syncFrame` — is pure and unit-tested in `sync-engine`.

import { makeAutoObservable, runInAction } from "mobx";
import type { TmuxBridge } from "./bridge.ts";
import {
  EMPTY_RECORDING,
  buildRecording,
  type PaneGeometry,
  type Recording,
  type RecordedChunk,
} from "./session-recording-engine.ts";
import type { ScrollbackSnapshot } from "./scrollback-engine.ts";
import {
  type SyncGroup,
  cursorMs,
  groupDuration,
  linkablePanes,
} from "./sync-engine.ts";
import { MAX_RECORDING_BYTES, captureSeeds, now } from "./recording-capture.ts";

/** Playback ticker cadence — ~30fps is smooth for a scrubbing terminal. */
const TICK_INTERVAL_MS = 33;

/** Discrete lifecycle. [LAW:no-mode-explosion] three states, no flags. */
export type RecorderPhase = "idle" | "recording" | "review";

/** Available playback speeds. */
export const PLAYBACK_RATES = [0.5, 1, 2, 4] as const;
export type PlaybackRate = (typeof PLAYBACK_RATES)[number];

export class SyncScrollStore {
  phase: RecorderPhase = "idle";
  /** True while the firehose taps are open (the mode is active). */
  active = false;

  /** The frozen forward artifact, available in `review`. */
  recording: Recording = EMPTY_RECORDING;
  /** Per-pane seed snapshots captured at record-start; empty until `review`. */
  snapshots: ReadonlyMap<number, ScrollbackSnapshot> = new Map();
  /**
   * Which seeded panes are linked into lockstep playback. A MobX-observable Set —
   * membership IS the value, so toggling never mutates an object key (no
   * `delete`). [LAW:dataflow-not-control-flow]
   */
  linked = new Set<number>();

  /** Elapsed capture time, ticked live so the UI can show a duration counter. */
  liveDurationMs = 0;
  /** Set when a recording auto-stopped at the byte cap. */
  limitHit = false;
  /** Set when more panes existed than the seed cap and some were skipped. */
  seedTruncated = false;
  /** True while the seed `capture-pane` burst is in flight (record is arming). */
  seeding = false;

  /** The one shared scrub position on the `[0,1]` recorded-time axis. */
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
   * open forward buffering. The await between the two halves guarantees no forward
   * byte is both seeded and streamed. A double Record is ignored while seeding or
   * recording.
   */
  startRecording(): void {
    if (this.phase === "recording" || this.seeding) return;
    runInAction(() => {
      this.seeding = true;
      this.limitHit = false;
      this.seedTruncated = false;
      this.recording = EMPTY_RECORDING;
      this.snapshots = new Map();
      this.linked = new Set();
      this.playing = false;
      this.pos = 0;
      this.liveDurationMs = 0;
    });
    void captureSeeds(this.bridge, "sync scrollback").then(
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

  /** Freeze the forward buffer + seeds into the review artifacts; link every pane. */
  stopRecording(): void {
    if (this.phase !== "recording") return;
    const rec = buildRecording(this.buffer, this.geometry);
    const seeds = this.pendingSeeds;
    runInAction(() => {
      this.recording = rec;
      this.snapshots = seeds;
      // Default: link every seeded pane — you recorded them all, so the
      // synchronized view shows them all; the user can unlink to declutter.
      this.linked = new Set(linkablePanes({ recording: rec, snapshots: seeds, linked: new Set() }));
      this.phase = "review";
      this.playing = false;
      // Open at the end (the latest moment) so the first drag rewinds every pane
      // together — the synchronized-rewind story is visible immediately.
      this.pos = 1;
    });
  }

  /** Discard the current recording and return to idle (armed). */
  reset(): void {
    runInAction(() => {
      this.phase = "idle";
      this.recording = EMPTY_RECORDING;
      this.snapshots = new Map();
      this.linked = new Set();
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
  // Review: the synchronized group + shared cursor
  // -------------------------------------------------------------------------

  /** The synchronized group the engine projects — recording + seeds + linked set. */
  get group(): SyncGroup {
    return {
      recording: this.recording,
      snapshots: this.snapshots,
      linked: this.linked,
    };
  }

  /** The shared recorded instant the cursor currently addresses. */
  get cursorMs(): number {
    return cursorMs(this.pos, groupDuration(this.group));
  }

  /** Toggle one seeded pane in or out of the synchronized group. */
  toggleLinked(paneId: number): void {
    if (this.linked.has(paneId)) this.linked.delete(paneId);
    else this.linked.add(paneId);
  }

  linkAll(): void {
    this.linked = new Set(linkablePanes(this.group));
  }

  linkNone(): void {
    this.linked = new Set();
  }

  // -------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------

  togglePlay(): void {
    if (this.playing) this.pause();
    else this.play();
  }

  play(): void {
    if (groupDuration(this.group) <= 0) return;
    // Restart from the beginning when parked at the end — standard transport UX.
    if (this.pos >= 1) this.pos = 0;
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
   * while playing it advances the ONE shared `pos` by real elapsed time × rate
   * and parks at the end. Every linked pane reads this same `pos`, so they move in
   * lockstep by construction. [LAW:no-ambient-temporal-coupling] one owner for the
   * playhead, one playhead for all panes.
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
    const dur = groupDuration(this.group);
    if (dur <= 0) {
      this.playing = false;
      return;
    }
    runInAction(() => {
      const next = this.pos + (dt * this.rate) / dur;
      if (next >= 1) {
        this.pos = 1;
        this.playing = false;
      } else {
        this.pos = next;
      }
    });
  }
}
