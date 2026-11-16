// src/window-terminal/sizing/solve.ts
//
// The sizing solver: from the constraints (`ResolvedSizing`), the box the
// terminal has, the cell size at each font, and tmux's current grid, pick the
// font and what this client claims as the window's size.
//
// [LAW:effects-at-boundaries] Pure. Measuring cells, declaring the size and
//   setting fonts are the caller's; this returns the decision as a value.
// [LAW:one-type-per-behavior] One loop serves both arms of `Sizing`: walk the
//   integer fonts from max to min, take the first at which the arm's `fits`
//   holds, else min. The arms differ only in what "fits" means and in the
//   claim, which are values.

import { WINDOW_MAXIMUM, type ResolvedSizing } from "../options.js";
import type { PaneSize } from "../engine/terminal-sink.js";

export type Grid = PaneSize;

export interface Box {
  readonly width: number;
  readonly height: number;
}

export interface CellSize {
  readonly width: number;
  readonly height: number;
}

/** The cell size, in CSS px, at a font size in CSS px. */
export type CellAt = (fontPx: number) => CellSize;

/**
 * What this client says about the window's size.
 *
 * - `declare` — this is my size for the window (`refresh-client -C @W:CxR`).
 * - `hold` — keep whatever is declared: the box has no area to measure (not
 *   laid out yet, or hidden), and declaring from it would shrink the window
 *   for every client to nothing.
 * - `release` — I make no claim for the window (`refresh-client -C @W:`).
 *   A control client that has declared any size stays one of the window's
 *   sizing clients at its overall size (see `clearWindowSize`).
 */
export type SizeClaim =
  | { readonly kind: "declare"; readonly grid: Grid }
  | { readonly kind: "hold" }
  | { readonly kind: "release" };

export interface Solution {
  readonly font: number;
  /** The cell size at `font`. */
  readonly cell: CellSize;
  readonly claim: SizeClaim;
}

function pickFont(
  sizing: ResolvedSizing,
  cell: CellAt,
  fits: (c: CellSize) => boolean,
): number {
  for (let px = sizing.font.max; px > sizing.font.min; px--) {
    if (fits(cell(px))) return px;
  }
  return sizing.font.min;
}

/**
 * `tmux` is the window's current grid as tmux reports it; only the `tmux`
 * arm reads it, since under `box` the grid is what this solution declares.
 */
export function solve(
  sizing: ResolvedSizing,
  box: Box,
  cell: CellAt,
  tmux: Grid,
): Solution {
  const holds = (c: CellSize): Grid => ({
    cols: Math.floor(box.width / c.width),
    rows: Math.floor(box.height / c.height),
  });
  switch (sizing.window) {
    case "box": {
      const font = pickFont(sizing, cell, (c) => {
        const g = holds(c);
        return g.cols >= sizing.minCols && g.rows >= sizing.minRows;
      });
      const at = cell(font);
      const g = holds(at);
      const empty = box.width <= 0 || box.height <= 0;
      return {
        font,
        cell: at,
        claim: empty
          ? { kind: "hold" }
          : {
              kind: "declare",
              grid: {
                cols: Math.min(
                  WINDOW_MAXIMUM,
                  Math.max(sizing.minCols, g.cols),
                ),
                rows: Math.min(
                  WINDOW_MAXIMUM,
                  Math.max(sizing.minRows, g.rows),
                ),
              },
            },
      };
    }
    case "tmux": {
      const font = pickFont(
        sizing,
        cell,
        (c) =>
          (!sizing.fit.width || tmux.cols * c.width <= box.width) &&
          (!sizing.fit.height || tmux.rows * c.height <= box.height),
      );
      return { font, cell: cell(font), claim: { kind: "release" } };
    }
  }
}
