// examples/web-multiplexer/web/bisect-store.ts
//
// BisectStore — the IO boundary for "bisect a TUI bug in a recorded session". It
// captures a session exactly as the .9 time machine and .10 moment diff do —
// seed every pane with a `capture-pane -e -p -S - -E -` snapshot, THEN record the
// forward firehose — and in review runs git-bisect over the selected pane's
// recorded byte stream. The user is the oracle: at each step the store
// reconstructs the screen at the probe offset and the user judges "bug present?".
// Each verdict halves the search until it pins the offending byte, which the pure
// engine names back to its escape sequence.
//
// [LAW:no-ambient-temporal-coupling] ORDERING IS OWNED, NOT INCIDENTAL: the seed
//   capture must COMPLETE before firehose buffering opens, or a forward byte
//   would be counted twice (baked into a later seed AND in the stream).
//   `startRecording` awaits every `capture-pane`, THEN flips `phase` to
//   "recording"; only from that flip does `onFirehoseBytes` buffer. Identical to
//   the .10 store — the verbatim-identical capture pieces are imported from
//   `recording-capture`, not re-stated. [LAW:one-source-of-truth]
// [LAW:effects-at-boundaries] The firehose subscription + buffering + the wall
//   clock live here; the bisect math (reducer, reconstruction, culprit naming) is
//   the pure `bisect-engine`. The store holds the bisect STATE and reconstructs
//   the probe screen; it owns no search logic of its own.
// [LAW:dataflow-not-control-flow] The oracle's verdict is a value the user
//   supplies via `markPresent`/`markAbsent`; the reducer is blind to its source,
//   so this store and the engine's `autoBisect` drive the identical reducer.

import { makeAutoObservable, runInAction } from "mobx";
import type { TmuxBridge } from "./bridge.ts";
import {
  EMPTY_RECORDING,
  buildRecording,
  busiestPane,
  locateOffset,
  paneStreamBytes,
  type PaneGeometry,
  type Recording,
  type RecordedChunk,
  type StreamLocation,
} from "./session-recording-engine.ts";
import { type ScrollbackSnapshot, type Timeline } from "./scrollback-engine.ts";
import type { AttributionGrid } from "./byte-attribution-engine.ts";
import {
  type BisectState,
  type Culprit,
  type OffendingSequence,
  culprit,
  culpritSequence,
  gridFromStream,
  isConverged,
  probeOffset,
  recordVerdict,
  startBisect,
} from "./bisect-engine.ts";
import {
  MAX_RECORDING_BYTES,
  captureSeeds,
  firstKey,
  now,
} from "./recording-capture.ts";

/** Cadence of the live elapsed-time counter shown while recording. */
const TICK_INTERVAL_MS = 100;

/** Discrete lifecycle. [LAW:no-mode-explosion] three states, no flags. */
export type BisectPhase = "idle" | "recording" | "review";

export class BisectStore {
  phase: BisectPhase = "idle";
  /** True while the firehose taps are open (the mode is active). */
  active = false;

  /** The frozen forward artifact, available in `review`. */
  recording: Recording = EMPTY_RECORDING;
  /** Per-pane seed snapshots captured at record-start; empty until `review`. */
  snapshots: ReadonlyMap<number, ScrollbackSnapshot> = new Map();

  liveDurationMs = 0;
  limitHit = false;
  seedTruncated = false;
  seeding = false;

  /** Which recorded pane the bisect searches. */
  selectedPaneId: number | null = null;

  /**
   * The live binary search over the selected pane's byte stream, or null before
   * review / when the pane recorded no forward bytes (nothing to bisect). The
   * user's verdicts narrow it; the engine reads the culprit off it.
   */
  bisect: BisectState | null = null;

  /** Every probe the user has judged, oldest first — the search path. */
  steps: { readonly offset: number; readonly verdict: "present" | "absent" }[] =
    [];

  // --- capture buffer (non-observable; frozen into `recording` on stop) ---
  private buffer: RecordedChunk[] = [];
  private capturedBytes = 0;
  private captureStartedAt = 0;
  private pendingSeeds = new Map<number, ScrollbackSnapshot>();
  private readonly geometry = new Map<number, PaneGeometry>();

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
   * open forward buffering. The await between the two halves guarantees no
   * forward byte is both seeded and streamed. A double Record is ignored while
   * seeding or recording.
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
      this.bisect = null;
      this.steps = [];
      this.liveDurationMs = 0;
    });
    void captureSeeds(this.bridge, "bisect").then(({ seeds, truncated }) => {
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
    });
  }

  /** Freeze the forward buffer + seeds into the review artifacts. */
  stopRecording(): void {
    if (this.phase !== "recording") return;
    const rec = buildRecording(this.buffer, this.geometry);
    const seeds = this.pendingSeeds;
    // The bisectable panes are the SEEDED ones; prefer the busiest among them so
    // review opens on the most interesting pane that can actually be searched.
    const busiest = busiestPane(rec);
    const selected =
      busiest !== null && seeds.has(busiest) ? busiest : firstKey(seeds);
    runInAction(() => {
      this.recording = rec;
      this.snapshots = seeds;
      this.phase = "review";
      this.selectedPaneId = selected;
      this.bisect = this.freshBisect(selected, rec);
      this.steps = [];
    });
  }

  /** Discard the current recording and return to idle (armed). */
  reset(): void {
    runInAction(() => {
      this.phase = "idle";
      this.recording = EMPTY_RECORDING;
      this.snapshots = new Map();
      this.selectedPaneId = null;
      this.bisect = null;
      this.steps = [];
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
  // Review — the bisect
  // -------------------------------------------------------------------------

  /** Build the per-pane timeline the engine reconstructs from. */
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

  /** The selected pane's timeline, or null if none is bisectable. */
  get timeline(): Timeline | null {
    return this.selectedPaneId === null
      ? null
      : this.timelineFor(this.selectedPaneId);
  }

  /**
   * The selected pane's whole forward byte stream — the axis the search runs
   * over. Memoized by MobX, so the many probe reconstructions concatenate it
   * once. [LAW:one-source-of-truth] derived from the recording, never tracked.
   */
  get stream(): Uint8Array {
    if (this.selectedPaneId === null) return new Uint8Array(0);
    return paneStreamBytes(this.recording, this.selectedPaneId);
  }

  /** A fresh search bracketing the pane's whole stream, or null if it's empty. */
  private freshBisect(
    paneId: number | null,
    rec: Recording,
  ): BisectState | null {
    if (paneId === null) return null;
    const len = paneStreamBytes(rec, paneId).length;
    return len <= 0 ? null : startBisect(len);
  }

  /** True once the search has pinned the offending byte. */
  get converged(): boolean {
    return this.bisect !== null && isConverged(this.bisect);
  }

  /**
   * The byte offset whose reconstructed screen the user is currently judging.
   * While searching it is the midpoint probe; once converged it is the bad-end
   * (the first broken screen), so the user sees what they were hunting. Null when
   * there is nothing to bisect. [LAW:dataflow-not-control-flow] one offset feeds
   * the same reconstruction every render; only its value changes.
   */
  get displayOffset(): number | null {
    if (this.bisect === null) return null;
    const c = culprit(this.bisect);
    return c !== null ? c.badOffset : probeOffset(this.bisect);
  }

  /** The reconstructed screen at `displayOffset` — the grid the view paints. */
  get displayGrid(): AttributionGrid | null {
    const tl = this.timeline;
    const offset = this.displayOffset;
    if (tl === null || offset === null) return null;
    return gridFromStream(
      tl.snapshot,
      tl.snapshot.geometry,
      this.stream,
      offset,
    );
  }

  /** The culprit once converged, else null — the offending byte boundary. */
  get culprit(): Culprit | null {
    return this.bisect === null ? null : culprit(this.bisect);
  }

  /** The escape sequence (or text run) the culprit byte belongs to. */
  get offendingSequence(): OffendingSequence | null {
    const c = this.culprit;
    return c === null ? null : culpritSequence(this.stream, c.byteOffset);
  }

  /** When + which `%output` chunk delivered the culprit byte (.8 provenance). */
  get culpritLocation(): StreamLocation | null {
    const c = this.culprit;
    if (c === null || this.selectedPaneId === null) return null;
    return locateOffset(this.recording, this.selectedPaneId, c.byteOffset);
  }

  /** How many more probes remain at most — log2 of the open interval. */
  get probesRemaining(): number {
    if (this.bisect === null || isConverged(this.bisect)) return 0;
    return Math.ceil(Math.log2(this.bisect.hi - this.bisect.lo));
  }

  selectPane(paneId: number): void {
    runInAction(() => {
      this.selectedPaneId = paneId;
      this.bisect = this.freshBisect(paneId, this.recording);
      this.steps = [];
    });
  }

  /** Mark the probe screen as showing the bug — narrow the bad ceiling down. */
  markPresent(): void {
    this.applyVerdict("present");
  }

  /** Mark the probe screen as clean — lift the good floor up. */
  markAbsent(): void {
    this.applyVerdict("absent");
  }

  private applyVerdict(verdict: "present" | "absent"): void {
    // Capture into a local so the non-null/unconverged narrowing survives into
    // the action closure — no cast needed across the observable read.
    const state = this.bisect;
    if (state === null || isConverged(state)) return;
    const offset = probeOffset(state);
    runInAction(() => {
      this.steps = [...this.steps, { offset, verdict }];
      this.bisect = recordVerdict(state, verdict);
    });
  }

  /** Restart the search over the same pane from the full bracket. */
  restartBisect(): void {
    runInAction(() => {
      this.bisect = this.freshBisect(this.selectedPaneId, this.recording);
      this.steps = [];
    });
  }

  /**
   * The single timing authority: while recording, advance the live elapsed
   * counter. The bisect is static, so the ticker does nothing outside recording.
   * [LAW:no-ambient-temporal-coupling] one owner for the only clock this store has.
   */
  private tick(): void {
    if (this.phase !== "recording") return;
    runInAction(() => {
      this.liveDurationMs = now() - this.captureStartedAt;
    });
  }
}
