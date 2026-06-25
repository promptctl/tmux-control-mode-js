// examples/web-multiplexer/web/webgl-stress-engine.test.ts
//
// Behavior tests for the load + measurement core: determinism of the synthetic
// generator, the FPS summary contract, and the ramp's stop-on-break decision.
// [LAW:behavior-not-structure]

import { describe, it, expect } from "vitest";
import {
  RAMP_CAP,
  fpsFromFrameTimes,
  generateFrame,
  generateGrid,
  rampDecision,
  totalCells,
  type LoadSpec,
} from "./webgl-stress-engine.ts";

describe("generateGrid — deterministic churn", () => {
  it("produces a grid of exactly cols*rows cells", () => {
    const g = generateGrid(0, 0, 20, 10);
    expect(g.cols).toBe(20);
    expect(g.rows).toBe(10);
    expect(g.cells.length).toBe(200);
  });

  it("is fully determined by (seed, frame): same inputs, identical grid", () => {
    const a = generateGrid(3, 7, 12, 8);
    const b = generateGrid(3, 7, 12, 8);
    expect(a.cells).toEqual(b.cells);
  });

  it("churns with the frame: a later frame differs", () => {
    const a = generateGrid(3, 0, 16, 16);
    const b = generateGrid(3, 1, 16, 16);
    expect(a.cells).not.toEqual(b.cells);
  });

  it("differs by seed: two panes are not identical", () => {
    const a = generateGrid(0, 5, 16, 16);
    const b = generateGrid(1, 5, 16, 16);
    expect(a.cells).not.toEqual(b.cells);
  });

  it("emits only atlas-safe glyphs (printable ASCII)", () => {
    const g = generateGrid(9, 9, 30, 20);
    for (const c of g.cells) {
      if (c === null) continue;
      const code = c.char.charCodeAt(0);
      expect(code).toBeGreaterThanOrEqual(0x20);
      expect(code).toBeLessThanOrEqual(0x7e);
    }
  });

  it("leaves some cells blank (null) so the grid is not uniform", () => {
    const g = generateGrid(2, 2, 40, 40);
    const blanks = g.cells.filter((c) => c === null).length;
    expect(blanks).toBeGreaterThan(0);
    expect(blanks).toBeLessThan(g.cells.length);
  });
});

describe("generateFrame", () => {
  it("produces one grid per pane in the spec", () => {
    const grids = generateFrame({ paneCount: 5, cols: 10, rows: 4 }, 0);
    expect(grids.length).toBe(5);
    for (const g of grids) {
      expect(g.cols).toBe(10);
      expect(g.rows).toBe(4);
    }
  });
});

describe("totalCells", () => {
  it("multiplies the three knobs", () => {
    expect(totalCells({ paneCount: 8, cols: 80, rows: 24 })).toBe(8 * 80 * 24);
  });
});

describe("fpsFromFrameTimes", () => {
  it("reports zero for an empty window (no data yet, not NaN)", () => {
    const s = fpsFromFrameTimes([]);
    expect(s.fps).toBe(0);
    expect(s.sampleCount).toBe(0);
  });

  it("derives fps from the mean interval", () => {
    // 16.67ms per frame -> ~60fps
    const s = fpsFromFrameTimes([16, 17, 16, 17]);
    expect(s.fps).toBeGreaterThan(58);
    expect(s.fps).toBeLessThan(62);
  });

  it("exposes the p95 stutter the mean hides", () => {
    const frames = [16, 16, 16, 16, 16, 16, 16, 16, 16, 100];
    const s = fpsFromFrameTimes(frames);
    expect(s.p95Ms).toBeGreaterThanOrEqual(100);
    expect(s.meanMs).toBeLessThan(s.p95Ms);
  });
});

describe("rampDecision", () => {
  const base: LoadSpec = { paneCount: 8, cols: 80, rows: 24 };

  it("adds panes while throughput holds the target", () => {
    const out = rampDecision(base, 60, 55);
    expect(out.broke).toBe(false);
    expect(out.next.paneCount).toBeGreaterThan(base.paneCount);
  });

  it("stops and flags the breaking point when fps drops below target", () => {
    const out = rampDecision(base, 40, 55);
    expect(out.broke).toBe(true);
    expect(out.next).toEqual(base);
  });

  it("never grows past the documented cap", () => {
    const atCap: LoadSpec = { ...base, paneCount: RAMP_CAP.paneCount };
    const out = rampDecision(atCap, 60, 55);
    expect(out.broke).toBe(false);
    expect(out.next.paneCount).toBe(RAMP_CAP.paneCount);
  });

  it("treats fps 0 (no measurement yet) as not-broken, and ramps", () => {
    const out = rampDecision(base, 0, 55);
    expect(out.broke).toBe(false);
    expect(out.next.paneCount).toBeGreaterThan(base.paneCount);
  });
});
