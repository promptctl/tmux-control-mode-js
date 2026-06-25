// examples/web-multiplexer/web/data-sniff-store.ts
//
// DataSnifferStore — the IO boundary for the Structured Data Sniffer: a live
// watch over the firehose of EVERY pane in EVERY session that surfaces JSON,
// CSV/TSV and table blocks as they scroll past. It owns exactly two effects:
// (1) the firehose start/stop lifecycle, (2) draining accumulated bytes into
// the pure DataSniffEngine on a ticker. The detection logic it drives is pure
// and unit-tested in isolation.
//
// [LAW:effects-at-boundaries] All IO (bridge.startFirehose / onFirehose /
//   onState, the ticker) lives here; the DataSniffEngine is pure.
// [LAW:one-source-of-truth] The engine's ring IS the block feed. `version` is a
//   change-signal for the non-observable engine, not a second copy of the feed.
// [LAW:dataflow-not-control-flow] Every firehose chunk is accumulated; every
//   tick drains the accumulator through the same engine.pushBytes pipeline.
//   "No structured data yet" is the empty-feed case, not a skipped branch.

import { makeAutoObservable, runInAction } from "mobx";
import { bytesToLatin1 } from "@promptctl/tmux-control-mode-js/protocol";
import type { TmuxBridge } from "./bridge.ts";
import { DataSniffEngine, type SniffedBlock } from "./data-sniff-engine.ts";

/** Drain the firehose byte accumulator into the engine at this cadence. */
const TICK_INTERVAL_MS = 200;
/** Max blocks retained in the live feed (FIFO). Bounds memory. */
const BLOCK_CAP = 500;

export type { SniffedBlock, SniffFormat, TabularData } from "./data-sniff-engine.ts";

export class DataSnifferStore {
  /** True while the firehose taps are open (sniffer mode is active). */
  active = false;
  /**
   * [LAW:one-source-of-truth] Change-signal for the non-observable engine.
   * Bumped once per drain tick so the `blocks` computed recomputes without
   * making the engine's internals observable.
   */
  version = 0;
  /** Currently-expanded block id in the feed (null = none expanded). */
  selectedId: number | null = null;

  private readonly engine = new DataSniffEngine(BLOCK_CAP);
  private readonly accum = new Map<number, string[]>();
  /**
   * Panes that received bytes on the previous tick. A pane present here but
   * absent from this tick's accumulator has fallen silent — its open run is
   * finalized (quiescence is the completion signal). [LAW:one-source-of-truth]
   */
  private lastActive = new Set<number>();
  private timerHandle: number | null = null;
  private readonly disposeOnFirehose: () => void;
  private readonly disposeOnState: () => void;

  constructor(private readonly bridge: TmuxBridge) {
    makeAutoObservable<
      this,
      "engine" | "accum" | "bridge" | "timerHandle" | "lastActive"
    >(this, {
      engine: false,
      accum: false,
      bridge: false,
      timerHandle: false,
      lastActive: false,
    });

    this.disposeOnFirehose = bridge.onFirehose((paneId, data) => {
      let chunks = this.accum.get(paneId);
      if (chunks === undefined) {
        chunks = [];
        this.accum.set(paneId, chunks);
      }
      chunks.push(bytesToLatin1(data));
    });

    // A reconnect drops the previous server's taps; re-open the firehose if
    // sniffer mode is still active so the feed survives a socket swap.
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

  /** Open the firehose taps. Idempotent. Called on entering sniffer mode. */
  start(): void {
    if (this.active) return;
    this.active = true;
    this.bridge.startFirehose();
  }

  /**
   * Close the firehose taps and free the feed. Called on leaving sniffer mode —
   * idle panes shouldn't keep paying the pipe-pane cost. Blocks repopulate live
   * on the next `start`.
   */
  stop(): void {
    if (!this.active) return;
    this.active = false;
    this.bridge.stopFirehose();
    this.accum.clear();
    this.engine.clear();
    this.selectedId = null;
    this.version++;
  }

  /** Drop the feed without leaving the mode (the "clear" button). */
  clearFeed(): void {
    this.engine.clear();
    this.accum.clear();
    this.selectedId = null;
    this.version++;
  }

  /** Expand/collapse a block in the feed. */
  select(id: number | null): void {
    this.selectedId = this.selectedId === id ? null : id;
  }

  // -------------------------------------------------------------------------
  // Live ingestion
  // -------------------------------------------------------------------------

  private tick(): void {
    const activeNow = new Set(this.accum.keys());
    // Panes that spoke last tick but are silent now: their open run is complete
    // (no breaking line will arrive). A pane still streaming bytes keeps its run
    // open so a slowly-printed table isn't split into per-tick fragments.
    const quiesced: number[] = [];
    for (const paneId of this.lastActive) {
      if (!activeNow.has(paneId)) quiesced.push(paneId);
    }
    if (activeNow.size === 0 && quiesced.length === 0) return;

    runInAction(() => {
      for (const [paneId, chunks] of this.accum) {
        this.engine.pushBytes(paneId, chunks.join(""));
      }
      this.accum.clear();
      for (const paneId of quiesced) this.engine.flushPane(paneId);
      this.lastActive = activeNow;
      this.version++;
    });
  }

  // -------------------------------------------------------------------------
  // Derived
  // -------------------------------------------------------------------------

  /** The live, bounded block feed (chronological). */
  get blocks(): readonly SniffedBlock[] {
    void this.version;
    return this.engine.blocks;
  }

  /** Number of panes that have produced bytes since the firehose opened. */
  get sniffedPaneCount(): number {
    void this.version;
    return this.engine.sniffedPaneCount;
  }

  /** Number of blocks currently in the feed. */
  get blockCount(): number {
    void this.version;
    return this.engine.blocks.length;
  }

  get selectedBlock(): SniffedBlock | null {
    void this.version;
    if (this.selectedId === null) return null;
    return this.engine.blocks.find((b) => b.id === this.selectedId) ?? null;
  }
}
