// examples/web-multiplexer/web/webgl-atlas-engine.ts
//
// The PURE rendering math for the WebGL terminal-grid stress demo: everything
// needed to turn a screen of cells into GPU-ready instance data, with no WebGL
// call in sight. The renderer (webgl-grid-renderer.ts) owns the GL effect; this
// module owns the arithmetic, so the hard part is unit-testable.
//
// The renderer-facing seam is `RenderGrid` — a screen of `RenderCell | null`.
// `AttributionGrid` (from byte-attribution-engine) is a STRUCTURAL SUPERTYPE of
// this: an `AttributedCell` carries everything a `RenderCell` does (char / fg /
// bg / bold) plus provenance, so a live attribution grid flows into `packFrame`
// with no adapter and the synthetic load generator produces the same shape.
// [LAW:dataflow-not-control-flow] live-vs-synthetic is a value (which grids),
//   never a branch in the renderer.
// [LAW:one-type-per-behavior] one grid type, two producers.
// [LAW:effects-at-boundaries] pure math here; the GL upload/draw is the boundary.

// ---------------------------------------------------------------------------
// The cell seam
// ---------------------------------------------------------------------------

/** The minimum a renderer needs of a terminal cell. A superset of this (e.g.
 *  byte-attribution's `AttributedCell`) is assignable, by structural typing. */
export interface RenderCell {
  readonly char: string;
  readonly fg: string | null;
  readonly bg: string | null;
  readonly bold: boolean;
}

/** A screen of cells, row-major, `cells.length === cols * rows`; `null` = blank. */
export interface RenderGrid {
  readonly cols: number;
  readonly rows: number;
  readonly cells: readonly (RenderCell | null)[];
}

// ---------------------------------------------------------------------------
// Colors — CSS string → linear [r,g,b] in 0..1
// ---------------------------------------------------------------------------

/** An RGB triple, each channel 0..1. */
export type RGB = readonly [number, number, number];

const HEX3 = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i;
const HEX6 = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;
const RGB_FN = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i;

/**
 * Parse a CSS color (the forms byte-attribution / SGR resolution actually emit:
 * `#rgb`, `#rrggbb`, `rgb(r,g,b)`) into an `RGB` 0..1 triple. An unparseable or
 * `null` color resolves to `fallback` — terminal cells legitimately carry no
 * explicit color (the default fg/bg), so absence is a represented value, not a
 * failure. [LAW:no-defensive-null-guards]
 */
export function parseColor(css: string | null, fallback: RGB): RGB {
  if (css === null) return fallback;
  const h6 = HEX6.exec(css);
  if (h6 !== null) {
    return [
      parseInt(h6[1], 16) / 255,
      parseInt(h6[2], 16) / 255,
      parseInt(h6[3], 16) / 255,
    ];
  }
  const h3 = HEX3.exec(css);
  if (h3 !== null) {
    return [
      parseInt(h3[1] + h3[1], 16) / 255,
      parseInt(h3[2] + h3[2], 16) / 255,
      parseInt(h3[3] + h3[3], 16) / 255,
    ];
  }
  const fn = RGB_FN.exec(css);
  if (fn !== null) {
    return [
      Math.min(255, parseInt(fn[1], 10)) / 255,
      Math.min(255, parseInt(fn[2], 10)) / 255,
      Math.min(255, parseInt(fn[3], 10)) / 255,
    ];
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// Glyph atlas layout
// ---------------------------------------------------------------------------

/** The printable-ASCII glyph set the shared atlas rasterizes (0x20..0x7E). A
 *  char outside this set renders as the atlas's space cell (documented tofu). */
export const ATLAS_CHARS: string = buildAsciiPrintable();

function buildAsciiPrintable(): string {
  let s = "";
  for (let c = 0x20; c <= 0x7e; c += 1) s += String.fromCharCode(c);
  return s;
}

/** A glyph's rectangle in the atlas texture, in 0..1 texture coordinates. */
export interface GlyphUV {
  readonly u0: number;
  readonly v0: number;
}

/**
 * The geometry of a shared glyph atlas: where every glyph lives in the texture.
 * Pure data + a lookup; the actual pixels are rasterized by the renderer using
 * exactly these coordinates (one source of truth for glyph placement).
 * [LAW:one-source-of-truth]
 */
export interface AtlasLayout {
  /** Glyph columns / rows in the atlas. */
  readonly gridCols: number;
  readonly gridRows: number;
  /** Per-glyph cell size in atlas pixels. */
  readonly cellPxW: number;
  readonly cellPxH: number;
  /** Atlas texture dimensions in pixels. */
  readonly widthPx: number;
  readonly heightPx: number;
  /** The glyph set, in atlas order. */
  readonly chars: string;
  /** Per-glyph atlas cell uv size (du, dv) — constant across glyphs. */
  readonly glyphUvW: number;
  readonly glyphUvH: number;
  /** Texture-coord origin of a char's cell; unknown chars → the space cell. */
  uvFor(char: string): GlyphUV;
}

/**
 * Lay out `chars` into a near-square atlas of `cellPxW × cellPxH` cells. Pure:
 * computes only where each glyph sits; the renderer draws the font into these
 * slots. The space character is guaranteed present so unknown glyphs have a
 * blank fallback.
 */
export function buildAtlasLayout(
  chars: string,
  cellPxW: number,
  cellPxH: number,
): AtlasLayout {
  const set = chars.includes(" ") ? chars : " " + chars;
  const n = set.length;
  const gridCols = Math.ceil(Math.sqrt(n));
  const gridRows = Math.ceil(n / gridCols);
  const widthPx = gridCols * cellPxW;
  const heightPx = gridRows * cellPxH;
  const glyphUvW = cellPxW / widthPx;
  const glyphUvH = cellPxH / heightPx;

  const index = new Map<string, number>();
  for (let i = 0; i < n; i += 1) index.set(set[i], i);
  const spaceIndex = index.get(" ") ?? 0;

  const uvForIndex = (i: number): GlyphUV => {
    const gx = i % gridCols;
    const gy = Math.floor(i / gridCols);
    return { u0: (gx * cellPxW) / widthPx, v0: (gy * cellPxH) / heightPx };
  };

  return {
    gridCols,
    gridRows,
    cellPxW,
    cellPxH,
    widthPx,
    heightPx,
    chars: set,
    glyphUvW,
    glyphUvH,
    uvFor(char: string): GlyphUV {
      const i = index.get(char);
      return uvForIndex(i === undefined ? spaceIndex : i);
    },
  };
}

// ---------------------------------------------------------------------------
// Pane tiling — arrange N grids into a viewport
// ---------------------------------------------------------------------------

/** A placed tile: where a grid's top-left corner sits in the canvas, in px. */
export interface PlacedTile {
  readonly originPxX: number;
  readonly originPxY: number;
  readonly widthPx: number;
  readonly heightPx: number;
}

/** A grid plus where to draw it. */
export interface Tile {
  readonly grid: RenderGrid;
  readonly originPxX: number;
  readonly originPxY: number;
}

/**
 * Shelf-pack grids of (possibly varying) pixel size into a viewport `widthPx`
 * wide: left-to-right, wrapping to a new row when the next tile would overflow.
 * Pure geometry; vertical overflow is allowed (the view clips/scrolls), which
 * is itself part of "push the throughput axis until it breaks". Each input is a
 * `[w,h]` px size; output origins align 1:1 by index.
 */
export function shelfPack(
  sizes: readonly (readonly [number, number])[],
  viewportWidthPx: number,
  gapPx: number,
): PlacedTile[] {
  const out: PlacedTile[] = [];
  let x = 0;
  let y = 0;
  let rowH = 0;
  for (const [w, h] of sizes) {
    if (x > 0 && x + w > viewportWidthPx) {
      x = 0;
      y += rowH + gapPx;
      rowH = 0;
    }
    out.push({ originPxX: x, originPxY: y, widthPx: w, heightPx: h });
    x += w + gapPx;
    rowH = Math.max(rowH, h);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Instance packing — grids → one interleaved GPU buffer
// ---------------------------------------------------------------------------

/** Floats per cell instance: posPx(2) + glyphUV(2) + fg(3) + bg(3). */
export const INSTANCE_STRIDE = 10;

/** A packed frame: the interleaved instance buffer plus the instance count. */
export interface PackedFrame {
  readonly data: Float32Array;
  readonly cellCount: number;
}

/**
 * Pack every cell of every tile into one interleaved instance buffer for a
 * single instanced draw — the "shared atlas" payoff: thousands of cells across
 * many panes in one call. Each instance is
 *   [posPxX, posPxY, glyphU0, glyphV0, fgR,fgG,fgB, bgR,bgG,bgB].
 * Blank (`null`) cells are emitted too (space glyph + default bg) so the grid
 * has a solid background — variability is in the value, not a skipped cell.
 * [LAW:dataflow-not-control-flow]
 */
export function packFrame(
  tiles: readonly Tile[],
  atlas: AtlasLayout,
  cellPxW: number,
  cellPxH: number,
  defaultFg: RGB,
  defaultBg: RGB,
): PackedFrame {
  let total = 0;
  for (const t of tiles) total += t.grid.cols * t.grid.rows;

  const data = new Float32Array(total * INSTANCE_STRIDE);
  let o = 0;
  for (const tile of tiles) {
    const { grid } = tile;
    for (let r = 0; r < grid.rows; r += 1) {
      for (let c = 0; c < grid.cols; c += 1) {
        const cell = grid.cells[r * grid.cols + c] ?? null;
        const char = cell === null ? " " : cell.char;
        const uv = atlas.uvFor(char === "" ? " " : char);
        const fg = parseColor(cell === null ? null : cell.fg, defaultFg);
        const bg = parseColor(cell === null ? null : cell.bg, defaultBg);
        data[o] = tile.originPxX + c * cellPxW;
        data[o + 1] = tile.originPxY + r * cellPxH;
        data[o + 2] = uv.u0;
        data[o + 3] = uv.v0;
        data[o + 4] = fg[0];
        data[o + 5] = fg[1];
        data[o + 6] = fg[2];
        data[o + 7] = bg[0];
        data[o + 8] = bg[1];
        data[o + 9] = bg[2];
        o += INSTANCE_STRIDE;
      }
    }
  }
  return { data, cellCount: total };
}
