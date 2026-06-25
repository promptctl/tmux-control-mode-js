// examples/web-multiplexer/web/webgl-stress-store.ts
//
// WebGLStressStore — the IO + state boundary for the WebGL terminal-grid stress
// demo. It owns two clearly-separated things and one effect:
//   1. the SOURCE of cells, as a value: "live" panes (real bytes through a
//      PaneStream + WebGLGridSink) or "synthetic" generated load. The renderer
//      sees only `RenderGrid[]` and cannot tell them apart.
//      [LAW:dataflow-not-control-flow]
//   2. the LOAD + METRICS state (spec, fps, breaking point).
//   the effect: live mode opens a PaneStream per pane of the current window and
//   reconciles that set on a ticker.
//
// Timing has two NAMED owners, never ambient: the reconcile ticker (the live
// pane set) and the view's rAF loop (rendering + frame accounting, fed back via
// recordFrame). Neither implicitly couples to the other — the renderer paints
// whatever grids exist; the ticker only maintains the set.
// [LAW:no-ambient-temporal-coupling]
//
// [LAW:effects-at-boundaries] PaneStream lifecycle + the ticker live here; the
//   atlas/stress engines and the grid it exposes are pure.

import { makeAutoObservable, runInAction } from "mobx";
import { PaneStream } from "@promptctl/pane-terminal/stream";
import type { DemoStore, PaneInfo } from "./store.ts";
import { WebGLGridSink } from "./webgl-grid-sink.ts";
import type { RenderGrid } from "./webgl-atlas-engine.ts";
import {
  RAMP_CAP,
  fpsFromFrameTimes,
  generateFrame,
  rampDecision,
  totalCells,
  type FpsStats,
  type LoadSpec,
} from "./webgl-stress-engine.ts";

/** Reconcile the live PaneStream set against the current window this often. */
const RECONCILE_INTERVAL_MS = 250;
/** Inter-frame intervals kept for the FPS window (~1s at 60fps). */
const FPS_WINDOW = 60;
/** Recompute stats / consider a ramp step every this many frames. */
const SAMPLE_EVERY = 30;
/** The frame rate the auto-ramp tries to hold (margin under 60). */
const TARGET_FPS = 55;

export type GridSource = "live" | "synthetic";

interface LivePane {
  readonly stream: PaneStream;
  readonly sink: WebGLGridSink;
  width: number;
  height: number;
}

export class WebGLStressStore {
  active = false;
  source: GridSource = "synthetic";
  spec: LoadSpec = { paneCount: 12, cols: 80, rows: 24 };
  autoRamp = false;

  /** Metrics surfaced to the HUD. */
  stats: FpsStats = { fps: 0, meanMs: 0, p95Ms: 0, sampleCount: 0 };
  lastCellCount = 0;
  lastDrawCalls = 0;
  /** True once the auto-ramp found the breaking point; `breakingSpec` is it. */
  broke = false;
  breakingSpec: LoadSpec | null = null;
  /** A represented GL-init failure (no WebGL2) — shown, never silently hidden. */
  glError: string | null = null;

  private frame = 0;
  private readonly frameTimes: number[] = [];
  private readonly live = new Map<number, LivePane>();
  private reconcileTimer: number | null = null;
  private readonly disposeOnState: () => void;

  constructor(private readonly demo: DemoStore) {
    makeAutoObservable<
      this,
      "demo" | "frame" | "frameTimes" | "live" | "reconcileTimer"
    >(this, {
      demo: false,
      frame: false,
      frameTimes: false,
      live: false,
      reconcileTimer: false,
    });

    // A reconnect drops the previous server's panes; the ticker re-reconciles,
    // and each PaneStream reseeds itself, so the feed survives a socket swap.
    this.disposeOnState = this.demo.client.onState(() => {
      if (this.active && this.source === "live") this.reconcile();
    });
  }

  // --- lifecycle ------------------------------------------------------------

  /** Enter the mode. Starts live reconciliation if the source is live. */
  start(): void {
    if (this.active) return;
    this.active = true;
    this.reconcileTimer = setInterval(
      () => this.reconcile(),
      RECONCILE_INTERVAL_MS,
    ) as unknown as number;
    this.reconcile();
  }

  /** Leave the mode: tear down every live PaneStream and stop the ticker. */
  stop(): void {
    if (!this.active) return;
    this.active = false;
    if (this.reconcileTimer !== null) {
      clearInterval(
        this.reconcileTimer as unknown as ReturnType<typeof setInterval>,
      );
      this.reconcileTimer = null;
    }
    this.teardownLive();
    this.frameTimes.length = 0;
  }

  dispose(): void {
    this.stop();
    this.disposeOnState();
  }

  // --- controls -------------------------------------------------------------

  setSource(source: GridSource): void {
    if (source === this.source) return;
    this.source = source;
    this.broke = false;
    this.breakingSpec = null;
    this.frameTimes.length = 0;
    if (source === "live") this.reconcile();
    else this.teardownLive();
  }

  setPaneCount(n: number): void {
    this.spec = {
      ...this.spec,
      paneCount: clamp(n, 1, RAMP_CAP.paneCount),
    };
    this.frameTimes.length = 0;
  }

  setGridSize(cols: number, rows: number): void {
    this.spec = {
      ...this.spec,
      cols: clamp(cols, 1, RAMP_CAP.cols),
      rows: clamp(rows, 1, RAMP_CAP.rows),
    };
    this.frameTimes.length = 0;
  }

  setAutoRamp(on: boolean): void {
    this.autoRamp = on;
    if (on) {
      this.broke = false;
      this.breakingSpec = null;
      this.frameTimes.length = 0;
    }
  }

  setGlError(message: string | null): void {
    this.glError = message;
  }

  // --- render-facing reads (called by the view's rAF loop) ------------------

  /** The grids to paint this frame — live sinks' screens or synthetic load. */
  get grids(): RenderGrid[] {
    if (this.source === "live") {
      const out: RenderGrid[] = [];
      for (const lp of this.live.values()) out.push(lp.sink.grid);
      return out;
    }
    return generateFrame(this.spec, this.frame);
  }

  /** Cells the current source asks to be painted (before any GL). */
  get requestedCells(): number {
    if (this.source === "live") {
      let n = 0;
      for (const lp of this.live.values()) n += lp.width * lp.height;
      return n;
    }
    return totalCells(this.spec);
  }

  get livePaneCount(): number {
    return this.live.size;
  }

  /**
   * Record one painted frame: its inter-frame interval and what it drew. Drives
   * the FPS window and, when auto-ramping, the decision to push harder or stop
   * at the breaking point. The view calls this once per rAF tick.
   */
  recordFrame(dtMs: number, cellCount: number, drawCalls: number): void {
    this.frame += 1;
    this.lastCellCount = cellCount;
    this.lastDrawCalls = drawCalls;
    this.frameTimes.push(dtMs);
    if (this.frameTimes.length > FPS_WINDOW) this.frameTimes.shift();
    if (this.frame % SAMPLE_EVERY !== 0) return;

    const stats = fpsFromFrameTimes(this.frameTimes);
    runInAction(() => {
      this.stats = stats;
    });
    if (
      !this.autoRamp ||
      this.source !== "synthetic" ||
      this.frameTimes.length < FPS_WINDOW
    ) {
      return;
    }
    const outcome = rampDecision(this.spec, stats.fps, TARGET_FPS);
    runInAction(() => {
      if (outcome.broke) {
        this.broke = true;
        this.breakingSpec = this.spec;
        this.autoRamp = false;
      } else {
        this.spec = outcome.next;
      }
      // Re-measure the new load from scratch; don't average across the step.
      this.frameTimes.length = 0;
    });
  }

  // --- live source ----------------------------------------------------------

  private reconcile(): void {
    if (!this.active || this.source !== "live") return;
    const panes: readonly PaneInfo[] = this.demo.currentWindow?.panes ?? [];
    const desired = new Map<number, PaneInfo>();
    for (const p of panes) desired.set(p.id, p);

    for (const [id, lp] of this.live) {
      if (!desired.has(id)) {
        lp.stream.dispose();
        this.live.delete(id);
      }
    }
    for (const [id, info] of desired) {
      const existing = this.live.get(id);
      if (existing === undefined) {
        this.addLivePane(info);
      } else if (existing.width !== info.width || existing.height !== info.height) {
        existing.sink.resize(info.width, info.height);
        existing.width = info.width;
        existing.height = info.height;
      }
    }
  }

  private addLivePane(info: PaneInfo): void {
    const sink = new WebGLGridSink({ cols: info.width, rows: info.height });
    const stream = new PaneStream({
      client: this.demo.paneStreamClient,
      paneId: info.id,
    });
    stream.attach(sink);
    this.live.set(info.id, {
      stream,
      sink,
      width: info.width,
      height: info.height,
    });
  }

  private teardownLive(): void {
    for (const lp of this.live.values()) lp.stream.dispose();
    this.live.clear();
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(n)));
}
