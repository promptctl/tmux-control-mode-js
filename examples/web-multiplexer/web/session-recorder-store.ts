// examples/web-multiplexer/web/session-recorder-store.ts
//
// SessionRecorderStore — the IO boundary for record/replay. It captures the
// live firehose of EVERY pane (the same all-sessions byte stream the regex and
// image demos tap) into a timestamped log, freezes that log into an immutable
// `Recording`, and then drives a single playback clock that the view turns into
// a scrubbable terminal. The reconstruction math is the pure
// `session-recording-engine`; this store owns only the clocks and the tmux IO.
//
// Why the firehose and not the attached `%output`: `%output` only flows for the
// window a control client is viewing, and is tmux-emulated. The firehose taps
// `pipe-pane` — raw pty bytes from every pane regardless of focus — which is the
// asciinema model: record the bytes the program wrote, replay them into a fresh
// emulator. So recording is view-independent: no `select-window`, no scratch
// pane. (Contrast the escape playground, which DOES render a live pane and must
// hijack the client's view.)
//
// [LAW:effects-at-boundaries] All IO lives here: the firehose subscription, the
//   wall clock that stamps capture time, the geometry queries, the playback
//   ticker. The byte reconstruction it feeds — `bytesUpTo` / `bytesBetween` —
//   is pure and unit-tested in `session-recording-engine.test.ts`.
// [LAW:no-ambient-temporal-coupling] Two clocks, one owner each: the capture
//   epoch (`captureStartedAt`) stamps incoming chunks; the single ticker is the
//   sole authority that advances `scrubMs` during playback. The view never runs
//   its own clock — it reacts to `scrubMs`. Nothing depends on call ordering.
// [LAW:one-source-of-truth] The frozen `Recording` is the single artifact;
//   `panes`, `durationMs`, and the activity histogram are DERIVED from it by the
//   engine, never tracked as parallel state.

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

/** Playback ticker cadence — ~30fps is smooth for a scrubbing terminal. */
const TICK_INTERVAL_MS = 33;

/**
 * Soft cap on a single recording's captured bytes. A recording is meant to be a
 * short clip you scrub, not an unbounded session log; past this the store
 * auto-stops and says so rather than growing memory without bound.
 * [LAW:no-silent-failure] the stop is surfaced (`limitHit`), not silent.
 */
const MAX_RECORDING_BYTES = 16 * 1024 * 1024;

/** Discrete recorder lifecycle. [LAW:no-mode-explosion] three states, no flags. */
export type RecorderPhase = "idle" | "recording" | "review";

/** Available playback speeds. */
export const PLAYBACK_RATES = [0.5, 1, 2, 4] as const;
export type PlaybackRate = (typeof PLAYBACK_RATES)[number];

/** Parse a `#{pane_width};#{pane_height}` reply (e.g. `80;24`). */
function parseGeometry(line: string | undefined): PaneGeometry | null {
  if (line === undefined) return null;
  const m = /^(\d+);(\d+)/.exec(line.trim());
  if (m === null) return null;
  const cols = Number(m[1]);
  const rows = Number(m[2]);
  if (cols <= 0 || rows <= 0) return null;
  return { cols, rows };
}

/** Monotonic wall clock for capture + playback timing. */
function now(): number {
  return performance.now();
}

export class SessionRecorderStore {
  phase: RecorderPhase = "idle";
  /** True while the firehose taps are open (record mode is active). */
  active = false;

  /** The frozen artifact, available in the `review` phase. */
  recording: Recording = EMPTY_RECORDING;

  /** Elapsed capture time, ticked live so the UI can show a duration counter. */
  liveDurationMs = 0;
  /** Set when a recording auto-stopped at the byte cap. */
  limitHit = false;

  /** Which recorded pane the replay surface renders. */
  selectedPaneId: number | null = null;

  /** Playback position (ms into the recording) — what the terminal reconstructs. */
  scrubMs = 0;
  playing = false;
  rate: PlaybackRate = 1;

  // --- capture buffer (non-observable; frozen into `recording` on stop) ---
  private buffer: RecordedChunk[] = [];
  private capturedBytes = 0;
  private captureStartedAt = 0;
  private readonly geometry = new Map<number, PaneGeometry>();
  private readonly geometryRequested = new Set<number>();

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
      | "geometry"
      | "geometryRequested"
      | "lastTickAt"
      | "ticker"
      | "disposeOnFirehose"
      | "disposeOnState"
    >(this, {
      bridge: false,
      buffer: false,
      capturedBytes: false,
      captureStartedAt: false,
      geometry: false,
      geometryRequested: false,
      lastTickAt: false,
      ticker: false,
      disposeOnFirehose: false,
      disposeOnState: false,
    });

    this.disposeOnFirehose = bridge.onFirehose((paneId, data) =>
      this.onFirehoseBytes(paneId, data),
    );

    // A reconnect drops the previous server's taps; re-open the firehose if the
    // mode is still active so a new recording can capture the new server.
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

  /** Open the firehose taps. Idempotent. Called on entering record mode. */
  start(): void {
    if (this.active) return;
    this.active = true;
    this.bridge.startFirehose();
  }

  /**
   * Close the firehose taps. Called on leaving record mode — idle panes
   * shouldn't keep paying the pipe-pane cost. A finished recording (review
   * state) is kept so re-entering the tab still shows it; an in-progress
   * recording is frozen first so bytes aren't lost.
   */
  stop(): void {
    if (!this.active) return;
    if (this.phase === "recording") this.stopRecording();
    this.active = false;
    this.bridge.stopFirehose();
  }

  // -------------------------------------------------------------------------
  // Recording lifecycle
  // -------------------------------------------------------------------------

  /** Begin capturing the firehose into a fresh timestamped buffer. */
  startRecording(): void {
    if (this.phase === "recording") return;
    this.buffer = [];
    this.capturedBytes = 0;
    this.geometry.clear();
    this.geometryRequested.clear();
    this.captureStartedAt = now();
    runInAction(() => {
      this.phase = "recording";
      this.liveDurationMs = 0;
      this.limitHit = false;
      this.recording = EMPTY_RECORDING;
      this.selectedPaneId = null;
      this.playing = false;
      this.scrubMs = 0;
    });
  }

  /** Freeze the capture buffer into an immutable `Recording` and open review. */
  stopRecording(): void {
    if (this.phase !== "recording") return;
    const rec = buildRecording(this.buffer, this.geometry);
    runInAction(() => {
      this.recording = rec;
      this.phase = "review";
      this.playing = false;
      this.selectedPaneId = busiestPane(rec);
      // Open on the final frame so the capture is visibly non-empty; the user
      // scrubs back from there or hits play to replay from the start.
      this.scrubMs = rec.durationMs;
    });
  }

  /** Discard the current recording and return to the idle (armed) state. */
  reset(): void {
    runInAction(() => {
      this.phase = "idle";
      this.recording = EMPTY_RECORDING;
      this.selectedPaneId = null;
      this.playing = false;
      this.scrubMs = 0;
      this.liveDurationMs = 0;
      this.limitHit = false;
    });
  }

  private onFirehoseBytes(paneId: number, data: Uint8Array): void {
    if (this.phase !== "recording") return;
    // Own the bytes immutably — the transport may reuse its backing buffer.
    const bytes = data.slice();
    this.buffer.push({ paneId, tMs: now() - this.captureStartedAt, bytes });
    this.capturedBytes += bytes.length;
    this.requestGeometry(paneId);
    if (this.capturedBytes >= MAX_RECORDING_BYTES) {
      runInAction(() => {
        this.limitHit = true;
      });
      this.stopRecording();
    }
  }

  /**
   * Query a pane's geometry once, the first time it appears in a recording, so
   * replay can size the terminal faithfully. Best-effort: a pane that vanishes
   * before the reply just gets null geometry (replay falls back to a default).
   * [LAW:no-silent-failure] a failed query is logged, not swallowed into a
   * wrong-but-plausible size.
   */
  private requestGeometry(paneId: number): void {
    if (this.geometryRequested.has(paneId)) return;
    this.geometryRequested.add(paneId);
    void this.bridge
      .execute(`display-message -p -t %${paneId} '#{pane_width};#{pane_height}'`)
      .then((r) => {
        const geo = parseGeometry(r.output[0]);
        if (geo !== null) this.geometry.set(paneId, geo);
      })
      .catch((err: unknown) =>
        console.warn(`recorder: geometry query for %${paneId} failed`, err),
      );
  }

  // -------------------------------------------------------------------------
  // Playback
  // -------------------------------------------------------------------------

  selectPane(paneId: number): void {
    this.selectedPaneId = paneId;
  }

  togglePlay(): void {
    if (this.playing) this.pause();
    else this.play();
  }

  play(): void {
    if (this.phase !== "review" || this.recording.durationMs <= 0) return;
    // Pressing play at the end restarts from the top — standard transport UX.
    if (this.scrubMs >= this.recording.durationMs) this.scrubMs = 0;
    this.lastTickAt = now();
    this.playing = true;
  }

  pause(): void {
    this.playing = false;
  }

  /** Scrub to an absolute position (ms), clamped. Dragging does not pause. */
  seek(ms: number): void {
    const clamped = Math.max(0, Math.min(this.recording.durationMs, ms));
    this.scrubMs = clamped;
  }

  setRate(rate: PlaybackRate): void {
    this.rate = rate;
  }

  /**
   * The single timing authority. Runs every tick for the store's whole life;
   * what it does is a function of the current phase (data), not a started/
   * stopped timer per phase. While recording it advances the live counter;
   * while playing it advances `scrubMs` by real elapsed time × rate and pauses
   * at the end. `lastTickAt` updates every tick so a resume never jumps.
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
    runInAction(() => {
      const next = this.scrubMs + dt * this.rate;
      if (next >= this.recording.durationMs) {
        this.scrubMs = this.recording.durationMs;
        this.playing = false;
      } else {
        this.scrubMs = next;
      }
    });
  }
}
