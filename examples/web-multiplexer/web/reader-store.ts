// examples/web-multiplexer/web/reader-store.ts
//
// ReaderStore — the IO boundary for Terminal Reader mode: a live watch over the
// firehose of EVERY pane in EVERY session that accumulates each pane's stripped
// output, plus the reader-local view state (which pane to read, at what page
// width). It owns exactly two effects: (1) the firehose start/stop lifecycle,
// (2) draining accumulated bytes into the pure ReaderEngine on a ticker. There
// is NO write path — reader mode only observes (a `pipe-pane` tap injects
// nothing), so unlike the command palette / co-pilot it never calls `sendKeys`.
//
// [LAW:effects-at-boundaries] All IO (bridge.startFirehose / onFirehose /
//   onState, the ticker) lives here; the ReaderEngine is pure.
// [LAW:one-source-of-truth] The engine's per-pane lines are canonical;
//   `version` is a change-signal for the non-observable engine, not a second
//   copy. The reflowed `segments` are derived from (lines, width) on demand.
// [LAW:dataflow-not-control-flow] Every firehose chunk is accumulated; every
//   tick drains the accumulator through the same engine.pushBytes pipeline.
//   "Nothing to read yet" is the empty-segment case, not a skipped branch.
// [LAW:no-ambient-temporal-coupling] No quiescence flush: a line completes on
//   its `\n`, an explicit event. A silent pane is simply not redrained — the
//   tick only DRAINS, it never finalizes.

import { makeAutoObservable, runInAction } from "mobx";
import { bytesToLatin1 } from "@promptctl/tmux-control-mode-js/protocol";
import type { TmuxBridge } from "./bridge.ts";
import { ReaderEngine, reflow, type ReaderSegment } from "./reader-engine.ts";

/** Drain the firehose byte accumulator into the engine at this cadence. */
const TICK_INTERVAL_MS = 200;
/** Max stripped lines retained per pane (FIFO eviction). Bounds memory. */
const PER_PANE_LINE_CAP = 5000;

const DEFAULT_WIDTH = 80;
export const MIN_WIDTH = 20;
export const MAX_WIDTH = 160;

export type { ReaderSegment } from "./reader-engine.ts";

export class ReaderStore {
  /** True while the firehose taps are open (reader mode is active). */
  active = false;
  /**
   * [LAW:one-source-of-truth] Change-signal for the non-observable engine.
   * Bumped once per drain tick so the `segments` computed recomputes without
   * making the engine's internals observable.
   */
  version = 0;
  /** Pane the user chose to read (null = follow the first tapped pane). */
  selectedPaneId: number | null = null;
  /** Page width (columns) the prose is reflowed to. */
  width = DEFAULT_WIDTH;

  private readonly engine = new ReaderEngine(PER_PANE_LINE_CAP);
  private readonly accum = new Map<number, string[]>();
  private timerHandle: number | null = null;
  private readonly disposeOnFirehose: () => void;
  private readonly disposeOnState: () => void;

  constructor(private readonly bridge: TmuxBridge) {
    makeAutoObservable<this, "engine" | "accum" | "bridge" | "timerHandle">(
      this,
      { engine: false, accum: false, bridge: false, timerHandle: false },
    );

    this.disposeOnFirehose = bridge.onFirehose((paneId, data) => {
      let chunks = this.accum.get(paneId);
      if (chunks === undefined) {
        chunks = [];
        this.accum.set(paneId, chunks);
      }
      chunks.push(bytesToLatin1(data));
    });

    // A reconnect drops the previous server's taps; re-open the firehose if
    // reader mode is still active so the feed survives a socket swap.
    this.disposeOnState = bridge.onState((state) => {
      if (state === "ready" && this.active) this.bridge.startFirehose();
    });

    this.timerHandle = setInterval(
      () => this.tick(),
      TICK_INTERVAL_MS,
    ) as unknown as number;
  }

  dispose(): void {
    this.disposeOnFirehose();
    this.disposeOnState();
    if (this.timerHandle !== null) {
      clearInterval(
        this.timerHandle as unknown as ReturnType<typeof setInterval>,
      );
      this.timerHandle = null;
    }
    if (this.active) this.bridge.stopFirehose();
  }

  // -------------------------------------------------------------------------
  // Lifecycle (firehose taps)
  // -------------------------------------------------------------------------

  /** Open the firehose taps. Idempotent. Called on entering reader mode. */
  start(): void {
    if (this.active) return;
    this.active = true;
    this.bridge.startFirehose();
  }

  /**
   * Close the firehose taps and free the accumulated text. Called on leaving the
   * mode — idle panes shouldn't keep paying the pipe-pane cost. Text repopulates
   * live on the next `start`.
   */
  stop(): void {
    if (!this.active) return;
    this.active = false;
    this.bridge.stopFirehose();
    this.accum.clear();
    this.engine.clear();
    this.selectedPaneId = null;
    this.version++;
  }

  /** Drop the accumulated text without leaving the mode (the "clear" button). */
  clearText(): void {
    this.engine.clear();
    this.accum.clear();
    this.selectedPaneId = null;
    this.version++;
  }

  /** Choose which pane to read. */
  selectPane(paneId: number): void {
    this.selectedPaneId = paneId;
  }

  /** Set the page width, clamped to the readable range. */
  setWidth(width: number): void {
    this.width = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(width)));
  }

  // -------------------------------------------------------------------------
  // Live ingestion
  // -------------------------------------------------------------------------

  private tick(): void {
    if (this.accum.size === 0) return;
    runInAction(() => {
      for (const [paneId, chunks] of this.accum) {
        this.engine.pushBytes(paneId, chunks.join(""));
      }
      this.accum.clear();
      this.version++;
    });
  }

  // -------------------------------------------------------------------------
  // Derived
  // -------------------------------------------------------------------------

  /** Panes that have produced bytes since the firehose opened (first-seen order). */
  get tappedPaneIds(): readonly number[] {
    void this.version;
    return this.engine.tappedPaneIds;
  }

  /** Number of distinct panes tapped. */
  get tappedPaneCount(): number {
    void this.version;
    return this.engine.tappedPaneCount;
  }

  /**
   * The pane actually being read: the explicit selection if it is still tapped,
   * otherwise the first tapped pane. [LAW:no-defensive-null-guards] absence (no
   * panes yet, or a selection that aged out) is a represented `null`, handled by
   * the empty-segment case — not a guard that silently skips work.
   */
  get activePaneId(): number | null {
    void this.version;
    const ids = this.engine.tappedPaneIds;
    if (this.selectedPaneId !== null && ids.includes(this.selectedPaneId)) {
      return this.selectedPaneId;
    }
    return ids.length > 0 ? ids[0] : null;
  }

  /** Stripped logical-line count for the pane being read. */
  get activeLineCount(): number {
    void this.version;
    const id = this.activePaneId;
    return id === null ? 0 : this.engine.lineCountFor(id);
  }

  /** The reflowed prose for the pane being read, at the current page width. */
  get segments(): readonly ReaderSegment[] {
    void this.version;
    const id = this.activePaneId;
    if (id === null) return [];
    return reflow(this.engine.linesFor(id), this.width);
  }
}
