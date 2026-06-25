// examples/web-multiplexer/web/hyperlink-store.ts
//
// HyperlinkStore — the IO boundary for the OSC 8 hyperlink sidebar aggregator: a
// live watch over the firehose of EVERY pane in EVERY session that collects every
// clickable link any pane has emitted into one deduplicated registry. It owns
// exactly two effects: (1) the firehose start/stop lifecycle, (2) draining
// accumulated bytes into the pure HyperlinkEngine on a ticker. The framing and
// aggregation it drives are pure and unit-tested in isolation.
//
// [LAW:effects-at-boundaries] All IO (bridge.startFirehose / onFirehose /
//   onState, the ticker) lives here; the HyperlinkEngine is pure.
// [LAW:one-source-of-truth] The engine's registry IS the link list. `version` is
//   a change-signal for the non-observable engine, not a second copy.
// [LAW:dataflow-not-control-flow] Every firehose chunk is accumulated; every tick
//   drains the accumulator through the same engine.pushBytes pipeline. "No links
//   yet" is the empty-registry case, not a skipped branch.

import { makeAutoObservable, runInAction } from "mobx";
import type { TmuxBridge } from "./bridge.ts";
import { HyperlinkEngine, type LinkEntry } from "./hyperlink-engine.ts";

/** Drain the firehose byte accumulator into the engine at this cadence. */
const TICK_INTERVAL_MS = 200;
/** Max distinct URIs retained (least-recently-seen eviction). Bounds memory. */
const LINK_CAP = 2000;

export type { LinkEntry } from "./hyperlink-engine.ts";

export class HyperlinkStore {
  /** True while the firehose taps are open (hyperlink mode is active). */
  active = false;
  /**
   * [LAW:one-source-of-truth] Change-signal for the non-observable engine.
   * Bumped once per drain tick so the `links` computed recomputes without making
   * the engine's internals observable.
   */
  version = 0;
  /** Currently-expanded URI in the sidebar (null = none expanded). */
  selectedUri: string | null = null;

  private readonly engine = new HyperlinkEngine(LINK_CAP);
  private readonly accum = new Map<number, Uint8Array[]>();
  /**
   * Panes that received bytes on the previous tick. A pane present here but
   * absent from this tick's accumulator has fallen silent — its dangling open
   * link is finalized (quiescence is the completion signal for a link whose
   * closer never arrived). [LAW:one-source-of-truth]
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
      chunks.push(data);
    });

    // A reconnect drops the previous server's taps; re-open the firehose if
    // hyperlink mode is still active so the registry keeps growing past a swap.
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

  /** Open the firehose taps. Idempotent. Called on entering hyperlink mode. */
  start(): void {
    if (this.active) return;
    this.active = true;
    this.bridge.startFirehose();
  }

  /**
   * Close the firehose taps and free the registry. Called on leaving the mode —
   * idle panes shouldn't keep paying the pipe-pane cost. Links repopulate live
   * on the next `start`.
   */
  stop(): void {
    if (!this.active) return;
    this.active = false;
    this.bridge.stopFirehose();
    this.accum.clear();
    this.engine.clear();
    this.selectedUri = null;
    this.version++;
  }

  /** Drop the registry without leaving the mode (the "clear" button). */
  clearLinks(): void {
    this.engine.clear();
    this.accum.clear();
    this.selectedUri = null;
    this.version++;
  }

  /** Expand/collapse a link in the sidebar. */
  select(uri: string | null): void {
    this.selectedUri = this.selectedUri === uri ? null : uri;
  }

  // -------------------------------------------------------------------------
  // Live ingestion
  // -------------------------------------------------------------------------

  private tick(): void {
    const activeNow = new Set(this.accum.keys());
    // Panes that spoke last tick but are silent now: their dangling open link is
    // complete (no closer will arrive). A pane still streaming bytes keeps its
    // open link pending so a slowly-printed label isn't cut short.
    const quiesced: number[] = [];
    for (const paneId of this.lastActive) {
      if (!activeNow.has(paneId)) quiesced.push(paneId);
    }
    if (activeNow.size === 0 && quiesced.length === 0) return;

    runInAction(() => {
      for (const [paneId, chunks] of this.accum) {
        for (const chunk of chunks) this.engine.pushBytes(paneId, chunk);
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

  /** The live, deduplicated link list (chronological by last-seen). */
  get links(): readonly LinkEntry[] {
    void this.version;
    return this.engine.links;
  }

  /** Number of distinct panes that have produced bytes since the firehose opened. */
  get tappedPaneCount(): number {
    void this.version;
    return this.engine.tappedPaneCount;
  }

  /** Number of distinct destinations currently collected. */
  get linkCount(): number {
    void this.version;
    return this.engine.linkCount;
  }

  get selectedLink(): LinkEntry | null {
    void this.version;
    if (this.selectedUri === null) return null;
    return this.engine.links.find((l) => l.uri === this.selectedUri) ?? null;
  }
}
