// examples/web-multiplexer/web/webgl-atlas-engine.test.ts
//
// Behavior tests for the pure rendering math. They assert the CONTRACT a
// renderer relies on (where a glyph sits, what a cell packs to), never the
// arithmetic's internal form. [LAW:behavior-not-structure]

import { describe, it, expect } from "vitest";
import {
  ATLAS_CHARS,
  INSTANCE_STRIDE,
  buildAtlasLayout,
  packFrame,
  parseColor,
  shelfPack,
  type RenderCell,
  type RenderGrid,
  type RGB,
} from "./webgl-atlas-engine.ts";

const WHITE: RGB = [1, 1, 1];
const BLACK: RGB = [0, 0, 0];

function cell(char: string, fg: string | null, bg: string | null): RenderCell {
  return { char, fg, bg, bold: false };
}

function grid(cols: number, rows: number, cells: (RenderCell | null)[]): RenderGrid {
  return { cols, rows, cells };
}

describe("parseColor", () => {
  it("parses #rrggbb to 0..1 channels", () => {
    expect(parseColor("#ff0000", BLACK)).toEqual([1, 0, 0]);
    expect(parseColor("#00ff00", BLACK)).toEqual([0, 1, 0]);
    expect(parseColor("#0000ff", BLACK)).toEqual([0, 0, 1]);
  });

  it("expands #rgb shorthand", () => {
    // #f00 -> #ff0000
    expect(parseColor("#f00", BLACK)).toEqual([1, 0, 0]);
    expect(parseColor("#fff", BLACK)).toEqual([1, 1, 1]);
  });

  it("parses rgb(r,g,b) functional form", () => {
    const [r, g, b] = parseColor("rgb(255,128,0)", BLACK);
    expect(r).toBe(1);
    expect(g).toBeCloseTo(128 / 255, 6);
    expect(b).toBe(0);
  });

  it("returns the fallback for null (the unstyled default cell)", () => {
    expect(parseColor(null, WHITE)).toBe(WHITE);
  });

  it("returns the fallback for an unparseable string, never throws", () => {
    expect(parseColor("chartreuse", BLACK)).toBe(BLACK);
    expect(parseColor("", WHITE)).toBe(WHITE);
  });
});

describe("buildAtlasLayout", () => {
  it("covers every printable-ASCII glyph", () => {
    const atlas = buildAtlasLayout(ATLAS_CHARS, 9, 18);
    expect(atlas.chars).toContain("A");
    expect(atlas.chars).toContain("~");
    expect(atlas.chars).toContain(" ");
  });

  it("places distinct glyphs at distinct texture coordinates", () => {
    const atlas = buildAtlasLayout(ATLAS_CHARS, 9, 18);
    const a = atlas.uvFor("A");
    const b = atlas.uvFor("B");
    expect(a).not.toEqual(b);
  });

  it("keeps all uv origins inside the unit square", () => {
    const atlas = buildAtlasLayout(ATLAS_CHARS, 9, 18);
    for (const ch of atlas.chars) {
      const { u0, v0 } = atlas.uvFor(ch);
      expect(u0).toBeGreaterThanOrEqual(0);
      expect(v0).toBeGreaterThanOrEqual(0);
      expect(u0 + atlas.glyphUvW).toBeLessThanOrEqual(1.0000001);
      expect(v0 + atlas.glyphUvH).toBeLessThanOrEqual(1.0000001);
    }
  });

  it("maps an unknown glyph to the space cell (tofu fallback, no throw)", () => {
    const atlas = buildAtlasLayout(ATLAS_CHARS, 9, 18);
    expect(atlas.uvFor("中")).toEqual(atlas.uvFor(" "));
  });

  it("guarantees a space cell even when the input omits it", () => {
    const atlas = buildAtlasLayout("AB", 9, 18);
    expect(atlas.chars).toContain(" ");
    expect(atlas.uvFor("Z")).toEqual(atlas.uvFor(" "));
  });
});

describe("shelfPack", () => {
  it("lays tiles left-to-right then wraps when the row overflows", () => {
    const placed = shelfPack(
      [
        [100, 50],
        [100, 50],
        [100, 50],
      ],
      250,
      0,
    );
    // Two fit on row 0 (200 <= 250); the third wraps.
    expect(placed[0].originPxX).toBe(0);
    expect(placed[1].originPxX).toBe(100);
    expect(placed[2].originPxX).toBe(0);
    expect(placed[2].originPxY).toBe(50);
  });

  it("never wraps the first tile of a row even if it alone overflows", () => {
    const placed = shelfPack([[300, 40]], 200, 0);
    expect(placed[0].originPxX).toBe(0);
    expect(placed[0].originPxY).toBe(0);
  });

  it("applies the gap between tiles", () => {
    const placed = shelfPack(
      [
        [100, 50],
        [100, 50],
      ],
      1000,
      8,
    );
    expect(placed[1].originPxX).toBe(108);
  });
});

describe("packFrame", () => {
  const atlas = buildAtlasLayout(ATLAS_CHARS, 9, 18);

  it("emits one instance per cell, including blanks", () => {
    const g = grid(2, 2, [cell("a", null, null), null, null, cell("b", null, null)]);
    const packed = packFrame(
      [{ grid: g, originPxX: 0, originPxY: 0 }],
      atlas,
      9,
      18,
      WHITE,
      BLACK,
    );
    expect(packed.cellCount).toBe(4);
    expect(packed.data.length).toBe(4 * INSTANCE_STRIDE);
  });

  it("positions each cell at originPx + (col,row)*cellPx", () => {
    const g = grid(2, 1, [cell("a", null, null), cell("b", null, null)]);
    const packed = packFrame(
      [{ grid: g, originPxX: 100, originPxY: 200 }],
      atlas,
      9,
      18,
      WHITE,
      BLACK,
    );
    // cell (0,0)
    expect(packed.data[0]).toBe(100);
    expect(packed.data[1]).toBe(200);
    // cell (1,0): x advances by one cell width
    expect(packed.data[INSTANCE_STRIDE]).toBe(109);
    expect(packed.data[INSTANCE_STRIDE + 1]).toBe(200);
  });

  it("packs the cell's fg/bg, falling back to defaults when unstyled", () => {
    const g = grid(1, 1, [cell("x", "#ff0000", "#0000ff")]);
    const packed = packFrame(
      [{ grid: g, originPxX: 0, originPxY: 0 }],
      atlas,
      9,
      18,
      WHITE,
      BLACK,
    );
    // fg at offset 4..6, bg at 7..9
    expect([packed.data[4], packed.data[5], packed.data[6]]).toEqual([1, 0, 0]);
    expect([packed.data[7], packed.data[8], packed.data[9]]).toEqual([0, 0, 1]);
  });

  it("uses the default fg/bg for a blank (null) cell", () => {
    const g = grid(1, 1, [null]);
    const packed = packFrame(
      [{ grid: g, originPxX: 0, originPxY: 0 }],
      atlas,
      9,
      18,
      [0.5, 0.6, 0.7],
      [0.1, 0.2, 0.3],
    );
    // Float32 storage rounds, so compare with tolerance.
    expect(packed.data[4]).toBeCloseTo(0.5, 5);
    expect(packed.data[5]).toBeCloseTo(0.6, 5);
    expect(packed.data[6]).toBeCloseTo(0.7, 5);
    expect(packed.data[7]).toBeCloseTo(0.1, 5);
    expect(packed.data[8]).toBeCloseTo(0.2, 5);
    expect(packed.data[9]).toBeCloseTo(0.3, 5);
  });

  it("offsets a second tile by its own origin (shared single buffer)", () => {
    const g = grid(1, 1, [cell("a", null, null)]);
    const packed = packFrame(
      [
        { grid: g, originPxX: 0, originPxY: 0 },
        { grid: g, originPxX: 300, originPxY: 60 },
      ],
      atlas,
      9,
      18,
      WHITE,
      BLACK,
    );
    expect(packed.cellCount).toBe(2);
    expect(packed.data[INSTANCE_STRIDE]).toBe(300);
    expect(packed.data[INSTANCE_STRIDE + 1]).toBe(60);
  });
});
