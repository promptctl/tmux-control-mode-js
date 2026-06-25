// examples/web-multiplexer/web/moment-diff-store.ts
//
// MomentDiffStore — the IO boundary for "diff two moments in pane history". It
// captures a session exactly as the .9 time machine does — seed every pane with
// a `capture-pane -e -p -S - -E -` snapshot, THEN record the forward firehose —
// and in review exposes TWO playheads (A and B) over recorded time. The pure
// `moment-diff-engine` reconstructs the pane's screen at each, seeded from the
// SAME snapshot, and reports cell-by-cell + cursor what changed. There is no
// playback clock: a diff is static, not animated.
//
// [LAW:no-ambient-temporal-coupling] ORDERING IS OWNED, NOT INCIDENTAL: the seed
//   capture must COMPLETE before firehose buffering opens, or a forward byte
//   would be counted twice (once baked into a later seed, once in the stream).
//   `startRecording` awaits every `capture-pane`, THEN flips `phase` to
//   "recording"; only from that flip does `onFirehoseBytes` buffer.
// [LAW:effects-at-boundaries] All IO lives here: list-panes, capture-pane, the
//   firehose subscription, the wall clock. The diff math it feeds —
//   `diffMoments` — is pure and unit-tested.
// [LAW:one-source-of-truth] The frozen `Recording` + the per-pane snapshot map
//   are the artifacts; the `diff` getter DERIVES everything the view shows from
//   them via the engine, never tracked as parallel state.
// [LAW:carrying-cost] This capture-then-record orchestration is shared in shape
//   with the .5 recorder, .8 attribution, and .9 time-machine stores — each a
//   thin IO boundary over the same `TmuxBridge` seam (onFirehose / startFirehose
//   / execute), differing only in what they do with the frozen artifacts. The
//   genuinely load-bearing logic (the byte math) is reused from the pure engines;
//   when a 5th consumer lands, the capture shell is the natural thing to lift
//   into one owned `RecordingSession` rather than copy a 5th time.

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
  parseCaptureReply,
  type ScrollbackSnapshot,
  type Timeline,
} from "./scrollback-engine.ts";
import { diffMoments, type MomentDiff } from "./moment-diff-engine.ts";

/** Cadence of the live elapsed-time counter shown while recording. */
const TICK_INTERVAL_MS = 100;

/**
 * Soft cap on a single recording's captured forward bytes. Past this the store
 * auto-stops and surfaces it (`limitHit`). [LAW:no-silent-failure]
 */
const MAX_RECORDING_BYTES = 16 * 1024 * 1024;

/**
 * Cap on how many panes get seeded at record-start. Seeding is an O(panes ×
 * scrollback) burst of `capture-pane` calls; the truncation is reported
 * (`seedTruncated`), not silent. [LAW:no-silent-failure]
 */
const MAX_SEEDED_PANES = 24;

/** Discrete lifecycle. [LAW:no-mode-explosion] three states, no flags. */
export type DiffPhase = "idle" | "recording" | "review";

/** One pane as reported by `list-panes -a`: id + the geometry to seed it on. */
interface PaneInfo {
  readonly paneId: number;
  readonly geometry: PaneGeometry;
}

/** Monotonic wall clock for capture timing. */
function now(): number {
  return performance.now();
}

/** Parse `%<id> <cols> <rows>` rows from `list-panes -a -F`. */
function parsePaneList(lines: readonly string[]): PaneInfo[] {
  const out: PaneInfo[] = [];
  for (const line of lines) {
    const m = /^%?(\d+)\s+(\d+)\s+(\d+)/.exec(line.trim());
    if (m === null) continue;
    const paneId = Number(m[1]);
    const cols = Number(m[2]);
    const rows = Number(m[3]);
    if (cols > 0 && rows > 0) out.push({ paneId, geometry: { cols, rows } });
  }
  return out;
}

export class MomentDiffStore {
  phase: DiffPhase = "idle";
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

  /** Which recorded pane the diff renders. */
  selectedPaneId: number | null = null;

  /**
   * The two playheads as fractions `[0,1]` of recorded time (A = before, B =
   * after). A diff operates purely on recorded time — both moments share the one
   * seed — so there is no history-scroll region to map, unlike the .9 axis.
   * Defaults span the whole clip: "what changed from start to end".
   */
  posA = 0;
  posB = 1;

  // --- capture buffer (non-observable; frozen into `recording` on stop) ---
  private buffer: RecordedChunk[] = [];
  private capturedBytes = 0;
  private captureStartedAt = 0;
  private pendingSeeds = new Map<number, ScrollbackSnapshot>();
  private readonly geometry = new Map<number, PaneGeometry>();

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
      this.liveDurationMs = 0;
    });
    void this.captureSeeds().then((seeds) => {
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
        this.phase = "recording";
      });
    });
  }

  /** Freeze the forward buffer + seeds into the review artifacts. */
  stopRecording(): void {
    if (this.phase !== "recording") return;
    const rec = buildRecording(this.buffer, this.geometry);
    const seeds = this.pendingSeeds;
    // The diffable panes are the SEEDED ones; prefer the busiest among them so
    // review opens on the most interesting pane that can actually be diffed.
    const busiest = busiestPane(rec);
    const selected =
      busiest !== null && seeds.has(busiest) ? busiest : firstKey(seeds);
    runInAction(() => {
      this.recording = rec;
      this.snapshots = seeds;
      this.phase = "review";
      this.selectedPaneId = selected;
      // Open spanning the whole clip: A at the start, B at the end.
      this.posA = 0;
      this.posB = 1;
    });
  }

  /** Discard the current recording and return to idle (armed). */
  reset(): void {
    runInAction(() => {
      this.phase = "idle";
      this.recording = EMPTY_RECORDING;
      this.snapshots = new Map();
      this.selectedPaneId = null;
      this.posA = 0;
      this.posB = 1;
      this.liveDurationMs = 0;
      this.limitHit = false;
      this.seedTruncated = false;
    });
  }

  /**
   * Capture every pane's scrollback seed in parallel. Best-effort per pane: a
   * pane that vanishes or errors is skipped (logged, not swallowed into a wrong
   * seed). [LAW:no-silent-failure]
   */
  private async captureSeeds(): Promise<Map<number, ScrollbackSnapshot>> {
    const seeds = new Map<number, ScrollbackSnapshot>();
    let panes: PaneInfo[];
    try {
      const list = await this.bridge.execute(
        "list-panes -a -F '#{pane_id} #{pane_width} #{pane_height}'",
      );
      panes = parsePaneList(list.output);
    } catch (err: unknown) {
      console.warn("moment diff: list-panes failed", err);
      return seeds;
    }
    if (panes.length > MAX_SEEDED_PANES) {
      runInAction(() => {
        this.seedTruncated = true;
      });
      panes = panes.slice(0, MAX_SEEDED_PANES);
    }
    await Promise.all(
      panes.map(async (p) => {
        try {
          const r = await this.bridge.execute(
            `capture-pane -e -p -S - -E - -t %${p.paneId}`,
          );
          seeds.set(
            p.paneId,
            parseCaptureReply(r.output, p.geometry, p.paneId),
          );
        } catch (err: unknown) {
          console.warn(`moment diff: capture-pane %${p.paneId} failed`, err);
        }
      }),
    );
    return seeds;
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
  // Review
  // -------------------------------------------------------------------------

  /** Build the per-pane timeline the engine diffs. Null if the pane has no seed. */
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

  /** The selected pane's timeline, or null if none is diffable. */
  get timeline(): Timeline | null {
    return this.selectedPaneId === null
      ? null
      : this.timelineFor(this.selectedPaneId);
  }

  /** Recorded time (ms) of playhead A. */
  get tAMs(): number {
    const tl = this.timeline;
    return tl === null ? 0 : this.posA * tl.durationMs;
  }

  /** Recorded time (ms) of playhead B. */
  get tBMs(): number {
    const tl = this.timeline;
    return tl === null ? 0 : this.posB * tl.durationMs;
  }

  /**
   * The diff the view renders — derived from the two playheads against the
   * selected pane's timeline. Null when no pane is diffable. [LAW:one-source-of-
   * truth] the single place "what changed" is computed.
   */
  get diff(): MomentDiff | null {
    const tl = this.timeline;
    if (tl === null) return null;
    return diffMoments(tl, this.tAMs, this.tBMs);
  }

  selectPane(paneId: number): void {
    this.selectedPaneId = paneId;
    this.posA = 0;
    this.posB = 1;
  }

  /** Scrub playhead A to an absolute fraction `[0,1]`, clamped. */
  seekA(frac: number): void {
    this.posA = Math.max(0, Math.min(1, frac));
  }

  /** Scrub playhead B to an absolute fraction `[0,1]`, clamped. */
  seekB(frac: number): void {
    this.posB = Math.max(0, Math.min(1, frac));
  }

  /**
   * The single timing authority: while recording, advance the live elapsed
   * counter. A diff is static, so the ticker does nothing outside recording.
   * [LAW:no-ambient-temporal-coupling] one owner for the only clock this store has.
   */
  private tick(): void {
    const t = now();
    this.lastTickAt = t;
    if (this.phase !== "recording") return;
    runInAction(() => {
      this.liveDurationMs = t - this.captureStartedAt;
    });
  }
}

/** First key of a map in insertion order, or null when empty. */
function firstKey(m: ReadonlyMap<number, unknown>): number | null {
  for (const k of m.keys()) return k;
  return null;
}
