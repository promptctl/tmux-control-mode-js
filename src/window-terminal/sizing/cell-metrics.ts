// src/window-terminal/sizing/cell-metrics.ts
//
// The size of one xterm.js cell at a font size, in CSS px, measured the way
// xterm.js 5.5 measures it, so the grid the solver lays out is the grid xterm
// draws.
//
//   char  — CharSizeService: an OffscreenCanvas `measureText("W")` (width,
//           fontBoundingBoxAscent + fontBoundingBoxDescent), else a DOM span
//           of 32 "W"s (offsetWidth / 32, offsetHeight).
//   cell  — DomRenderer: width = char width; height =
//           floor(ceil(char height × dpr) × lineHeight) / dpr.
//
// [LAW:no-shared-mutable-globals] The cache belongs to one measure (one
//   terminal), not the module.
// [LAW:no-silent-failure] A font that measures to nothing (no layout engine,
//   a document not rendering) throws: a guessed size would lay every pane out
//   wrong with no signal.

import type { CellAt, CellSize } from "./solve.js";

const REPEAT = 32;

function charSizeOnCanvas(family: string, px: number): CellSize | null {
  if (typeof OffscreenCanvas === "undefined") return null;
  const ctx = new OffscreenCanvas(100, 100).getContext("2d");
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

export interface CellMeasure {
  /** The cell size at each font size for this family and line height. */
  cellAt(family: string, lineHeight: number): CellAt;
  /**
   * Called when cell sizes may have changed under the same settings: a font
   * finished loading, or the device pixel ratio moved (a zoom, a monitor).
   */
  onChange(cb: () => void): () => void;
  dispose(): void;
}

export function createCellMeasure(win: Window): CellMeasure {
  const doc = win.document;
  const cache = new Map<string, CellSize>();
  const listeners = new Set<() => void>();
  const changed = (): void => {
    cache.clear();
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
    cellAt(family, lineHeight) {
      return (px) => {
        const key = `${px}|${lineHeight}|${family}`;
        const hit = cache.get(key);
        if (hit !== undefined) return hit;
        const char =
          charSizeOnCanvas(family, px) ?? charSizeInDom(doc, family, px);
        if (!(char.width > 0 && char.height > 0)) {
          throw new Error(
            `cannot measure ${px}px ${family}: the document measured it as ${char.width}x${char.height}`,
          );
        }
        const dpr = win.devicePixelRatio;
        const cell = {
          width: char.width,
          height: Math.floor(Math.ceil(char.height * dpr) * lineHeight) / dpr,
        };
        cache.set(key, cell);
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
      cache.clear();
    },
  };
}
