// examples/web-multiplexer/web/heatmap-store.ts
//
// HeatmapStore — reactive byte-rate tracker per pane.
//
// Every `%output` / `%extended-output` event contributes to a per-pane
// byte accumulator. A 200ms ticker turns those accumulators into a
// bytes-per-second rate and writes it to an observable Map. Each tick
// also decays existing rates so quiet panes smoothly fade out, giving
// the UI a pulsing-heatmap feel without per-event re-renders.
//
// [LAW:one-source-of-truth] The `rates` Map is the authoritative
// per-pane intensity. The accumulator is a private pre-image of it,
// flushed on every tick. The view never looks at the accumulator.
//
// [LAW:dataflow-not-control-flow] The tick pipeline is unconditional:
// every pane currently in the rates map gets decayed, then every pane
// with accumulated bytes gets its rate updated. No branches on "is
// this pane active". Absence of bytes is represented by data (zero in
// the accumulator), not by skipping work.

import { makeAutoObservable, runInAction } from "mobx";
import type { BridgeClient } from "./ws-client.ts";

const TICK_INTERVAL_MS = 200;
/** Per-tick multiplier applied to existing rates so quiet panes fade. */
const DECAY = 0.6;
/** Mix of (decayed previous rate) : (fresh rate from this tick). */
const EMA_FRESH = 0.75;
/** Rates below this floor are dropped from the map to keep it sparse. */
const FLOOR_BPS = 1;

export class HeatmapStore {
  /** paneId → bytes-per-second EMA. Observable. */
  rates: Map<number, number> = new Map();
  /** Peak rate observed across all panes, used to normalize colors. */
  peakBps: number = 0;

  private readonly accum = new Map<number, number>();
  private lastTick: number = Date.now();
  private timerHandle: number | null = null;
  private readonly disposeOnEvent: () => void;

  constructor(client: BridgeClient) {
    makeAutoObservable(this);

    this.disposeOnEvent = client.onEvent((ev) => {
      if (ev.type === "output" || ev.type === "extended-output") {
        // base64 → byte length: each 4 chars encode 3 bytes, minus
        // padding. We don't need exact accuracy — an estimate preserves
        // the relative intensity between panes, which is all the
        // heatmap needs.
        const bytes = Math.floor((ev.dataBase64.length * 3) / 4);
        this.accum.set(ev.paneId, (this.accum.get(ev.paneId) ?? 0) + bytes);
      }
    });

    // setInterval returns a number in the browser; guard for Node types.
    this.timerHandle = setInterval(() => this.tick(), TICK_INTERVAL_MS) as unknown as number;
  }

  dispose(): void {
    this.disposeOnEvent();
    if (this.timerHandle !== null) {
      clearInterval(this.timerHandle as unknown as ReturnType<typeof setInterval>);
      this.timerHandle = null;
    }
  }

  private tick(): void {
    const now = Date.now();
    const dtSec = (now - this.lastTick) / 1000 || TICK_INTERVAL_MS / 1000;
    this.lastTick = now;

    runInAction(() => {
      const next = new Map<number, number>();

      // Decay all existing rates. Panes with nothing this tick fade.
      for (const [pid, rate] of this.rates) {
        const decayed = rate * DECAY;
        if (decayed >= FLOOR_BPS) next.set(pid, decayed);
      }

      // Fold in fresh bytes from this tick.
      for (const [pid, bytes] of this.accum) {
        const freshRate = bytes / dtSec;
        const prev = next.get(pid) ?? 0;
        const mixed = prev * (1 - EMA_FRESH) + freshRate * EMA_FRESH;
        next.set(pid, mixed);
      }
      this.accum.clear();

      this.rates = next;

      // Track peak for color normalization. Peak itself decays slowly so
      // a one-off burst doesn't permanently compress the color range.
      let maxNow = 0;
      for (const r of next.values()) if (r > maxNow) maxNow = r;
      this.peakBps = Math.max(maxNow, this.peakBps * 0.98);
    });
  }

  rateFor(paneId: number): number {
    return this.rates.get(paneId) ?? 0;
  }

  /** 0..1 normalized intensity for a pane, log-scaled for readability. */
  intensityFor(paneId: number): number {
    const r = this.rateFor(paneId);
    if (r <= 0) return 0;
    const peak = Math.max(this.peakBps, 64);
    // log1p gives a nicer spread than linear — a 10x difference in
    // raw bytes/sec becomes a ~2.4x difference in intensity, so quiet
    // panes are still visible next to loud ones.
    const t = Math.log1p(r) / Math.log1p(peak);
    return Math.max(0, Math.min(1, t));
  }
}
