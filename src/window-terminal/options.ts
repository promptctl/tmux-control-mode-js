// src/window-terminal/options.ts
//
// The settings a window terminal takes at mount and by `update()`, and the one
// checkpoint that turns what a consumer wrote into what the solver reads.
//
// [LAW:parse-dont-validate] `parseSizing` returns `ResolvedSizing`, a type a
//   malformed input cannot reach: the font is always a `{min, max}` range of
//   integers, the floors are always present, `fit` is two booleans. A bad
//   value throws `RangeError` synchronously, at the call that passed it.
// [LAW:types-are-the-program] `Sizing` is constraints, not modes: one union
//   whose arm says who owns the window's size. `fit` exists only where tmux
//   owns it, the floors only where the box does, so no field is ever dead.

/** One font size in CSS px, or the range the solver picks from. */
export type FontRange = number | { readonly min: number; readonly max: number };

/**
 * How big the window is and how big its font is.
 *
 * - `window: "box"` — this terminal's box sets the window's size: the solver
 *   picks the largest font in range at which the box still holds
 *   `minCols × minRows`, and declares as many cells as the box holds at that
 *   font (never fewer than the floors) as this client's size for the window.
 *   With other clients attached tmux's `window-size` option decides, and the
 *   declared size is one input to it.
 * - `window: "tmux"` — tmux's size is given and nothing is declared: the
 *   solver picks the largest font in range at which the fitted axes fit the
 *   box (`"none"`: the largest font).
 *
 * Whatever does not fit the box scrolls inside it.
 */
export type Sizing =
  | {
      readonly window: "box";
      readonly font: FontRange;
      readonly minCols?: number;
      readonly minRows?: number;
    }
  | {
      readonly window: "tmux";
      readonly font: FontRange;
      readonly fit: "width" | "height" | "both" | "none";
    };

export interface ResolvedFont {
  readonly min: number;
  readonly max: number;
}

/** Which axes of tmux's size the font must fit inside the box. */
export interface ResolvedFit {
  readonly width: boolean;
  readonly height: boolean;
}

export type ResolvedSizing =
  | {
      readonly window: "box";
      readonly font: ResolvedFont;
      readonly minCols: number;
      readonly minRows: number;
    }
  | {
      readonly window: "tmux";
      readonly font: ResolvedFont;
      readonly fit: ResolvedFit;
    };

export const DEFAULT_SIZING: Sizing = { window: "box", font: 14 };

const FLOOR_MAX = 10000;

const FIT: Readonly<Record<string, ResolvedFit>> = {
  width: { width: true, height: false },
  height: { width: false, height: true },
  both: { width: true, height: true },
  none: { width: false, height: false },
};

function fontSize(raw: unknown, what: string): number {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) {
    throw new RangeError(
      `${what} must be an integer of at least 1; got ${String(raw)}`,
    );
  }
  return raw;
}

function parseFont(raw: FontRange): ResolvedFont {
  if (typeof raw === "number") {
    const px = fontSize(raw, "sizing.font");
    return { min: px, max: px };
  }
  const min = fontSize(raw.min, "sizing.font.min");
  const max = fontSize(raw.max, "sizing.font.max");
  if (min > max) {
    throw new RangeError(
      `sizing.font.min (${min}) must not exceed sizing.font.max (${max})`,
    );
  }
  return { min, max };
}

function floor(raw: number | undefined, what: string): number {
  const n = raw ?? 1;
  if (!Number.isInteger(n) || n < 1 || n > FLOOR_MAX) {
    throw new RangeError(
      `${what} must be an integer in 1..${FLOOR_MAX}; got ${String(raw)}`,
    );
  }
  return n;
}

export function parseSizing(raw: Sizing): ResolvedSizing {
  // [LAW:dataflow-not-control-flow] The arm is the domain's own discriminator;
  //   each arm resolves every field it has, and nothing else.
  switch (raw.window) {
    case "box":
      return {
        window: "box",
        font: parseFont(raw.font),
        minCols: floor(raw.minCols, "sizing.minCols"),
        minRows: floor(raw.minRows, "sizing.minRows"),
      };
    case "tmux": {
      const fit = Object.hasOwn(FIT, raw.fit) ? FIT[raw.fit] : undefined;
      if (fit === undefined) {
        throw new RangeError(
          `sizing.fit must be "width", "height", "both" or "none"; got ${JSON.stringify(raw.fit)}`,
        );
      }
      return { window: "tmux", font: parseFont(raw.font), fit };
    }
    default:
      throw new RangeError(
        `sizing.window must be "box" or "tmux"; got ${JSON.stringify((raw as { window: unknown }).window)}`,
      );
  }
}

/** Scrollback lines per pane: captured on arrival and kept by xterm. */
export function parseHistory(raw: number | undefined): number {
  const n = raw ?? DEFAULT_HISTORY;
  if (!Number.isInteger(n) || n < 0) {
    throw new RangeError(
      `history must be a non-negative integer; got ${String(raw)}`,
    );
  }
  return n;
}

// tmux's default `history-limit`, so a pane arrives with as much history as
// tmux keeps for it by default.
const DEFAULT_HISTORY = 2000;
