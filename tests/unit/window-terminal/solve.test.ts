import { describe, it, expect } from "vitest";
import {
  parseSizing,
  type Sizing,
} from "../../../src/window-terminal/options.js";
import {
  solve,
  type CellAt,
} from "../../../src/window-terminal/sizing/solve.js";

// A monospace font whose cell is 0.6em wide and 1.2em tall.
const cell: CellAt = (px) => ({ width: px * 0.6, height: px * 1.2 });

const run = (
  sizing: Sizing,
  width: number,
  height: number,
  cols = 80,
  rows = 24,
) => solve(parseSizing(sizing), { width, height }, cell, { cols, rows });

describe("solve, the box owns the window's size", () => {
  it("declares as many cells as the box holds at a fixed font", () => {
    // 14px: cell 8.4 × 16.8 → 1000/8.4 = 119, 500/16.8 = 29.
    expect(run({ window: "box", font: 14 }, 1000, 500)).toEqual({
      font: 14,
      cell: { width: 8.4, height: 16.8 },
      claim: { kind: "declare", grid: { cols: 119, rows: 29 } },
    });
  });

  it("sole-client phone: the largest font at which 80 columns still fit", () => {
    // 80 cols in 600px → cell ≤ 7.5 → font ≤ 12.5 → 12.
    const s = run(
      { window: "box", font: { min: 10, max: 16 }, minCols: 80 },
      600,
      800,
    );
    expect(s.font).toBe(12);
    expect(s.claim).toEqual({ kind: "declare", grid: { cols: 83, rows: 55 } });
  });

  it("rotating the phone re-solves with the same constraints", () => {
    const sizing: Sizing = {
      window: "box",
      font: { min: 10, max: 16 },
      minCols: 80,
      minRows: 24,
    };
    const portrait = run(sizing, 400, 800);
    const landscape = run(sizing, 800, 400);
    // Portrait cannot hold 80 columns at any font in range: min, and the
    // floor is still declared (the box scrolls).
    expect(portrait.font).toBe(10);
    expect(portrait.claim).toEqual({
      kind: "declare",
      grid: { cols: 80, rows: 66 },
    });
    // Landscape: 80 cols at ≤ 16px needs 768px; 24 rows at 13px needs 374px.
    expect(landscape.font).toBe(13);
    expect(landscape.claim).toEqual({
      kind: "declare",
      grid: { cols: 102, rows: 25 },
    });
  });

  it("holds the declaration when the box has no area", () => {
    expect(run({ window: "box", font: 14 }, 0, 500).claim).toEqual({
      kind: "hold",
    });
    expect(run({ window: "box", font: 14 }, 900, 0).claim).toEqual({
      kind: "hold",
    });
  });

  it("picks integer fonts only", () => {
    const s = run(
      { window: "box", font: { min: 9, max: 30 }, minCols: 80, minRows: 24 },
      777,
      555,
    );
    expect(Number.isInteger(s.font)).toBe(true);
  });
});

describe("solve, tmux owns the window's size", () => {
  it("iPad watching a desktop window: the largest font whose rows fit", () => {
    // 24 rows in 600px → cell height ≤ 25 → font ≤ 20.8 → max 18.
    const s = run(
      { window: "tmux", font: { min: 11, max: 18 }, fit: "height" },
      300,
      600,
      200,
      24,
    );
    expect(s.font).toBe(18);
    expect(s.claim).toEqual({ kind: "release" });
    // Rows that only fit lower in range: 40 rows in 600px → font ≤ 12.
    expect(
      run(
        { window: "tmux", font: { min: 11, max: 18 }, fit: "height" },
        300,
        600,
        200,
        40,
      ).font,
    ).toBe(12);
  });

  it("fit width fits the columns", () => {
    // 100 cols in 900px → cell ≤ 9 → font ≤ 15.
    expect(
      run(
        { window: "tmux", font: { min: 8, max: 20 }, fit: "width" },
        900,
        10,
        100,
        50,
      ).font,
    ).toBe(15);
  });

  it("fit both takes the tighter axis", () => {
    expect(
      run(
        { window: "tmux", font: { min: 8, max: 20 }, fit: "both" },
        900,
        600,
        100,
        40,
      ).font,
    ).toBe(12);
  });

  it("fit none takes the largest font", () => {
    expect(
      run({ window: "tmux", font: { min: 8, max: 20 }, fit: "none" }, 1, 1)
        .font,
    ).toBe(20);
  });

  it("nothing fits: the smallest font", () => {
    expect(
      run({ window: "tmux", font: { min: 8, max: 20 }, fit: "both" }, 10, 10)
        .font,
    ).toBe(8);
  });

  it("releases even at a zero box", () => {
    expect(run({ window: "tmux", font: 12, fit: "both" }, 0, 0).claim).toEqual({
      kind: "release",
    });
  });
});
