// src/window-terminal/sizing/cell-metrics.ts
//
// The size of one xterm.js cell at a font size, in CSS px, measured the way
// xterm.js 5.5 measures it, so the grid the solver lays out is the grid xterm
// draws.
//
//   char  — CharSizeService: an OffscreenCanvas `measureText("W")` (width,
//           fontBoundingBoxAscent + fontBoundingBoxDescent), else a DOM span
//           of 32 "W"s (offsetWidth / 32, offsetHeight).
//   cell  — the renderer's: width =
//           (char width × dpr + round(letterSpacing)) / dpr; height =
//           floor(ceil(char height × dpr) × lineHeight) / dpr. A canvas
//           renderer (the WebGL or canvas addon) floors the char width to
//           whole device pixels first, so its glyph atlas stays sharp; the
//           DOM renderer keeps the fraction.
//
// [LAW:no-shared-mutable-globals] The cache belongs to one measure (one
//   terminal), not the module.
// [LAW:no-silent-failure] A font that measures to nothing (no layout engine,
//   a document not rendering) throws: a guessed size would lay every pane out
//   wrong with no signal.

import type { CellAt, CellSize } from "./solve.js";

const REPEAT = 32;

// One context for the measure's life, as xterm keeps one; null where there
// is no OffscreenCanvas 2D context.
function canvasContext(): OffscreenCanvasRenderingContext2D | null {
  return typeof OffscreenCanvas === "undefined"
    ? null
    : new OffscreenCanvas(100, 100).getContext("2d");
}

function charSizeOnCanvas(
  ctx: OffscreenCanvasRenderingContext2D | null,
  family: string,
  px: number,
): CellSize | null {
  if (ctx === null) return null;
  ctx.font = `${px}px ${family}`;
  const m = ctx.measureText("W");
  if (!("fontBoundingBoxAscent" in m)) return null;
  return {
    width: m.width,
    height: m.fontBoundingBoxAscent + m.fontBoundingBoxDescent,
  };
}

function charSizeInDom(doc: Document, family: string, px: number): CellSize {
  const span = doc.createElement("span");
  span.setAttribute("aria-hidden", "true");
  // xterm.css gives its measure element these, rather than the page's.
  span.style.display = "inline-block";
  span.style.lineHeight = "normal";
  span.style.position = "absolute";
  span.style.visibility = "hidden";
  span.style.whiteSpace = "pre";
  span.style.fontKerning = "none";
  span.style.fontFamily = family;
  span.style.fontSize = `${px}px`;
  span.textContent = "W".repeat(REPEAT);
  doc.body.appendChild(span);
  const size = { width: span.offsetWidth / REPEAT, height: span.offsetHeight };
  span.remove();
  return size;
}

/** The font a cell is drawn in, as xterm.js's options set it. */
export interface CellFont {
  readonly fontFamily: string;
  readonly lineHeight: number;
  readonly letterSpacing: number;
}

/**
 * Which xterm.js renderer draws a cell: its own DOM renderer, or a renderer
 * addon that draws on a canvas (WebGL, canvas).
 */
export type CellRenderer = "dom" | "canvas";

const charWidth: Record<CellRenderer, (devicePx: number) => number> = {
  dom: (w) => w,
  canvas: Math.floor,
};

export interface CellMeasure {
  /** The cell size at each font size in this font, as `renderer` draws it. */
  cellAt(font: CellFont, renderer: CellRenderer): CellAt;
  /**
   * Called when cell sizes may have changed under the same settings: a font
   * finished loading, or the device pixel ratio moved (a zoom, a monitor).
   */
  onChange(cb: () => void): () => void;
  dispose(): void;
}

export function createCellMeasure(win: Window): CellMeasure {
  const doc = win.document;
  const ctx = canvasContext();
  // The glyph is what costs a measurement; each renderer's cell is
  // arithmetic on it.
  const chars = new Map<string, CellSize>();
  const listeners = new Set<() => void>();
  const changed = (): void => {
    chars.clear();
    for (const cb of listeners) cb();
  };

  // The device pixel ratio has no change event; a media query on the
  // current ratio stops matching when it moves, and is re-armed on the new one.
  let dprQuery: MediaQueryList | null = null;
  const onDpr = (): void => {
    armDpr();
    changed();
  };
  const armDpr = (): void => {
    dprQuery?.removeEventListener("change", onDpr);
    dprQuery = win.matchMedia(`(resolution: ${win.devicePixelRatio}dppx)`);
    dprQuery.addEventListener("change", onDpr);
  };
  armDpr();
  doc.fonts.addEventListener("loadingdone", changed);

  return {
    cellAt({ fontFamily: family, lineHeight, letterSpacing }, renderer) {
      return (px) => {
        const key = `${px}|${family}`;
        const char =
          chars.get(key) ??
          charSizeOnCanvas(ctx, family, px) ??
          charSizeInDom(doc, family, px);
        const dpr = win.devicePixelRatio;
        const cell = {
          width:
            (charWidth[renderer](char.width * dpr) +
              Math.round(letterSpacing)) /
            dpr,
          height: Math.floor(Math.ceil(char.height * dpr) * lineHeight) / dpr,
        };
        // A glyph measured as nothing is no font, whatever the spacing; a
        // letterSpacing that eats a real glyph's width leaves no column.
        if (!(char.width > 0 && char.height > 0 && cell.width > 0)) {
          throw new Error(
            `cannot lay out ${px}px ${family}: the document measured its glyph as ${char.width}x${char.height}, a cell of ${cell.width}x${cell.height}`,
          );
        }
        chars.set(key, char);
        return cell;
      };
    },
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    dispose() {
      dprQuery?.removeEventListener("change", onDpr);
      doc.fonts.removeEventListener("loadingdone", changed);
      listeners.clear();
      chars.clear();
    },
  };
}
