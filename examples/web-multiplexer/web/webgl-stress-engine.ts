// examples/web-multiplexer/web/webgl-stress-engine.ts
//
// The PURE load + measurement math for the WebGL grid stress demo, separate
// from the rendering math (webgl-atlas-engine.ts) because it is a different
// concern: how to MANUFACTURE a controllable cell load, how to MEASURE the
// renderer's throughput, and how to DECIDE when to push harder. [LAW:decomposition]
//
// A render stress test needs a load it controls — real panes won't reliably
// emit thousands of churning cells on demand. So `generateGrid` fabricates a
// deterministic, frame-varying screen; the renderer can't tell it from a live
// AttributionGrid (same `RenderGrid` shape). [LAW:one-type-per-behavior]
//
// [LAW:effects-at-boundaries] No clock, no rng-with-hidden-state, no GL here.
//   Determinism (seed+frame) makes the generator and the ramp decision testable.

import { PALETTE_16 } from "./escape-parse-engine.ts";
import type { RenderCell, RenderGrid } from "./webgl-atlas-engine.ts";

// ---------------------------------------------------------------------------
// Load spec — the knobs, and the cap
// ---------------------------------------------------------------------------

/** A synthetic load: how many panes, each of `cols × rows` cells. */
export interface LoadSpec {
  readonly paneCount: number;
  readonly cols: number;
  readonly rows: number;
}

/** Total cells a spec asks the renderer to paint per frame. */
export function totalCells(spec: LoadSpec): number {
  return spec.paneCount * spec.cols * spec.rows;
}

/**
 * The hard ceiling the auto-ramp will not cross — a stress test that grows
 * without bound silently wedges the tab instead of reporting a finding.
 * [LAW:no-silent-failure] The cap is documented and enforced in one place.
 */
export const RAMP_CAP: LoadSpec = { paneCount: 256, cols: 200, rows: 50 };

// ---------------------------------------------------------------------------
// Synthetic grid generation — deterministic churn
// ---------------------------------------------------------------------------

/** The glyphs the synthetic load draws from — dense, varied, ASCII-atlas-safe. */
const LOAD_GLYPHS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789#$%&@*+=/\\|<>[]{}";

/** Deterministic 32-bit hash → 0..1, so no `Math.random` leaks into the core. */
function hash01(a: number, b: number): number {
  let h = (a * 0x9e3779b1 + b * 0x85ebca77) | 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 0xffffffff;
}

/**
 * Generate one synthetic screen for pane `seed` at animation `frame`. The
 * content churns with `frame` (so the GPU re-uploads a moving payload, the real
 * cost), and is fully determined by (seed, frame, cell index) — same inputs,
 * same grid, every run. A fraction of cells are left blank (`null`) so the grid
 * is not pathologically uniform.
 */
export function generateGrid(
  seed: number,
  frame: number,
  cols: number,
  rows: number,
): RenderGrid {
  const w = Math.max(1, Math.floor(cols));
  const h = Math.max(1, Math.floor(rows));
  const cells: (RenderCell | null)[] = new Array<RenderCell | null>(w * h);
  for (let i = 0; i < w * h; i += 1) {
    const blank = hash01(seed * 131 + i, frame) < 0.12;
    if (blank) {
      cells[i] = null;
      continue;
    }
    const g = hash01(seed + i * 7, frame * 3 + i);
    const fgi = Math.floor(hash01(seed + i, frame + 1) * PALETTE_16.length);
    cells[i] = {
      char: LOAD_GLYPHS[Math.floor(g * LOAD_GLYPHS.length)],
      fg: PALETTE_16[Math.min(PALETTE_16.length - 1, fgi)],
      bg: null,
      bold: false,
    };
  }
  return { cols: w, rows: h, cells };
}

/** Generate the full synthetic frame: one grid per pane in the spec. */
export function generateFrame(spec: LoadSpec, frame: number): RenderGrid[] {
  const grids: RenderGrid[] = new Array<RenderGrid>(spec.paneCount);
  for (let p = 0; p < spec.paneCount; p += 1) {
    grids[p] = generateGrid(p, frame, spec.cols, spec.rows);
  }
  return grids;
}

// ---------------------------------------------------------------------------
// FPS measurement
// ---------------------------------------------------------------------------

/** Throughput summary over a window of inter-frame intervals (ms). */
export interface FpsStats {
  readonly fps: number;
  readonly meanMs: number;
  readonly p95Ms: number;
  readonly sampleCount: number;
}

/**
 * Summarize a window of inter-frame intervals. `fps` is from the mean interval
 * (steady-state rate); `p95Ms` exposes the stutter the mean hides. An empty
 * window is the represented "no data yet" value (fps 0), not a divide-by-zero.
 */
export function fpsFromFrameTimes(frameMs: readonly number[]): FpsStats {
  const n = frameMs.length;
  if (n === 0) return { fps: 0, meanMs: 0, p95Ms: 0, sampleCount: 0 };
  let sum = 0;
  for (const ms of frameMs) sum += ms;
  const meanMs = sum / n;
  const sorted = [...frameMs].sort((a, b) => a - b);
  const p95Ms = sorted[Math.min(n - 1, Math.floor(n * 0.95))];
  return {
    fps: meanMs > 0 ? 1000 / meanMs : 0,
    meanMs,
    p95Ms,
    sampleCount: n,
  };
}

// ---------------------------------------------------------------------------
// Auto-ramp — push until it breaks, then stop and report
// ---------------------------------------------------------------------------

/** The outcome of one ramp step. */
export interface RampOutcome {
  readonly next: LoadSpec;
  /** True once load held below the target frame rate: the breaking point. */
  readonly broke: boolean;
}

/** How much one ramp step adds when throughput is still healthy. */
const RAMP_PANE_STEP = 4;

/**
 * Decide the next load given the measured `fps`. While the renderer holds
 * `targetFps`, add panes (up to `RAMP_CAP`); the first time it can't, stop
 * growing and flag the breaking point — the load at which 60fps broke is the
 * finding this demo exists to produce. Hitting the cap also stops (and counts
 * as "broke" only if still at/above target it is simply capped, not broken).
 * [LAW:no-silent-failure] the stop condition is explicit and reported.
 */
export function rampDecision(
  current: LoadSpec,
  fps: number,
  targetFps: number,
): RampOutcome {
  if (fps > 0 && fps < targetFps) {
    return { next: current, broke: true };
  }
  if (current.paneCount >= RAMP_CAP.paneCount) {
    return { next: current, broke: false };
  }
  const nextCount = Math.min(
    RAMP_CAP.paneCount,
    current.paneCount + RAMP_PANE_STEP,
  );
  return {
    next: { ...current, paneCount: nextCount },
    broke: false,
  };
}
