// src/terminal/dimensions.ts
//
// Renderer-agnostic font-measurement and dimension-inversion math for
// rendering tmux panes inside any DOM-hosted terminal (xterm.js, Kitty
// for web, custom canvas, …). Every consumer that draws a pane in the
// browser has to answer two questions:
//
//   1. Given the chosen monospace font, how big is one character cell?
//   2. Given a container of W × H pixels, how many cols × rows fit —
//      and what pixel size does that grid actually occupy?
//
// [LAW:one-source-of-truth] Centralizing this math here means one
// well-tested implementation across every DOM renderer instead of one
// re-discovered version per consumer.
//
// [LAW:locality-or-seam] Zero xterm.js (or any other emulator)
// dependency. Caller passes a `FontSpec` and receives numbers — wiring
// those numbers into a particular terminal instance is the caller's
// job, lives in the caller's module, and is free to evolve.

const SAMPLE_GLYPHS = 100;

export interface FontSpec {
  /** CSS font-family stack, e.g. `'"JetBrains Mono", monospace'`. */
  readonly family: string;
  /** Pixel size, e.g. `12`. */
  readonly sizePx: number;
  /** CSS line-height. Defaults to `"1.2"` if omitted. */
  readonly lineHeight?: string;
}

export interface CellMetrics {
  readonly cellWidthPx: number;
  readonly cellHeightPx: number;
}

export interface PixelSize {
  readonly widthPx: number;
  readonly heightPx: number;
}

export interface GridSize {
  readonly cols: number;
  readonly rows: number;
}

/**
 * Measure one character cell of `font` by rendering a hidden probe of
 * `SAMPLE_GLYPHS` capital `M`s and dividing the bounding-rect width by
 * the glyph count. Cell height is the rendered line height.
 *
 * `host` controls where the probe attaches; defaults to
 * `document.body`. The probe is removed before this function returns,
 * regardless of whether `getBoundingClientRect` throws.
 *
 * Caller responsibilities (deliberately not handled here):
 *
 * - **Font loading.** If `font.family` references a custom face that
 *   has not finished loading, the browser will measure the fallback
 *   instead. Await `document.fonts.load(...)` before calling, or call
 *   again when the font event fires and discard stale results.
 * - **Caching.** Each call hits the DOM. Callers that resize per-frame
 *   should cache the result keyed on `font` and re-measure only when
 *   the font changes.
 */
export function measureCell(font: FontSpec, host?: HTMLElement): CellMetrics {
  // [LAW:single-enforcer] One DOM probe shape, one measurement
  // protocol. Variants (different fonts, different hosts) ride through
  // arguments — never branch into a second probe shape.
  const target = host ?? globalThis.document.body;
  const doc = target.ownerDocument;
  const probe = doc.createElement("div");
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  probe.style.fontFamily = font.family;
  probe.style.fontSize = `${font.sizePx}px`;
  probe.style.lineHeight = font.lineHeight ?? "1.2";
  probe.style.whiteSpace = "pre";
  probe.textContent = "M".repeat(SAMPLE_GLYPHS);
  target.appendChild(probe);
  try {
    const rect = probe.getBoundingClientRect();
    return {
      cellWidthPx: rect.width / SAMPLE_GLYPHS,
      cellHeightPx: rect.height,
    };
  } finally {
    target.removeChild(probe);
  }
}

/**
 * Largest grid that fits inside `size` at `cell`. Floors on both axes
 * so the grid never overflows; clamps to `≥1` on each axis so callers
 * never have to handle empty grids at zero-sized containers.
 */
export function pixelsToGrid(size: PixelSize, cell: CellMetrics): GridSize {
  const cols = Math.max(1, Math.floor(size.widthPx / cell.cellWidthPx));
  const rows = Math.max(1, Math.floor(size.heightPx / cell.cellHeightPx));
  return { cols, rows };
}

/**
 * Pixel dimensions of a `grid` rendered at `cell`. Inverse of
 * `pixelsToGrid` modulo the floor: round-tripping pixels → grid →
 * pixels never returns a value larger than the original, and never
 * differs by more than `(cellWidthPx, cellHeightPx)` on each axis.
 */
export function gridToPixels(grid: GridSize, cell: CellMetrics): PixelSize {
  return {
    widthPx: grid.cols * cell.cellWidthPx,
    heightPx: grid.rows * cell.cellHeightPx,
  };
}
