// src/window-terminal/render/xterm-options.ts
//
// The host's xterm.js options for every pane, and their checkpoint.
//
// [LAW:one-way-deps] The one xterm type the public options name lives in
//   render/, the only layer (beside react/) that may import xterm.js.
// [LAW:composability] The host's whole set crosses the seam as one value;
//   a new xterm option needs no change here.

import { Terminal } from "@xterm/xterm";
import type {
  ITerminalAddon,
  ITerminalInitOnlyOptions,
  ITerminalOptions,
} from "@xterm/xterm";
import type { CellFont } from "../sizing/cell-metrics.js";

/**
 * The addons a pane's xterm loads, called once per pane (an addon instance
 * belongs to one terminal), after the host's options are set and the
 * terminal is open. xterm disposes them with the pane.
 */
export type XtermAddons = () => readonly ITerminalAddon[];

/**
 * The xterm.js options the window terminal sets itself, because tmux or the
 * terminal decides them: tmux sizes the window (cols, rows), its bytes are
 * written as sent and its lines wrap and reflow as tmux's do (convertEol,
 * windowsMode), its panes keep 8-column tab stops (tabStopWidth) and answer
 * the window reports themselves (windowOptions), the sizing solver picks the
 * font size from `sizing.font` (fontSize), `history` is the scrollback
 * (scrollback), a pane's box is exactly its cells wide, so a ruler would
 * cover its last columns (overviewRuler), and a character's cells are
 * counted as tmux counts them, through xterm's proposed Unicode API
 * (allowProposedApi).
 */
export const TERMINAL_OWNED = [
  "cols",
  "rows",
  "convertEol",
  "windowsMode",
  "windowsPty",
  "documentOverride",
  "fontSize",
  "scrollback",
  "tabStopWidth",
  "windowOptions",
  "overviewRuler",
  "allowProposedApi",
  // [LAW:types-are-the-program] A key xterm renames stops the build. The one
  //   key outside xterm's typings is windowsMode, which xterm.js 6 dropped
  //   from them but still acts on.
] as const satisfies readonly (
  | keyof ITerminalOptions
  | keyof ITerminalInitOnlyOptions
  | "windowsMode"
)[];

/** xterm.js's options for every pane, less the ones the terminal owns. */
export type XtermOptions = Omit<
  ITerminalOptions,
  (typeof TERMINAL_OWNED)[number]
>;

/**
 * Default monospace stack. The list is platform-spanning so a pane is usable
 * out of the box; a host that bundles a font passes it as `xterm.fontFamily`.
 */
export const DEFAULT_FONT_FAMILY =
  '"JetBrains Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace';

/**
 * The terminal's own choices where xterm.js's default differs; a host option
 * overrides each, and leaving it out returns to it.
 */
export const TERMINAL_DEFAULTS = {
  fontFamily: DEFAULT_FONT_FAMILY,
  cursorBlink: true,
} as const;

/** The host's options, and the font a cell is drawn in under them. */
export interface ParsedXterm {
  readonly given: XtermOptions;
  readonly font: CellFont;
}

const owned: ReadonlySet<string> = new Set(TERMINAL_OWNED);

/**
 * The font a cell is drawn in, read from a constructed terminal's options.
 * [LAW:one-source-of-truth] xterm fills every option of a terminal it
 *   constructed, so its own defaults are the ones read; the terminal keeps
 *   no copy of them.
 */
export function cellFontOf(options: ITerminalOptions): CellFont {
  const o = options as Required<ITerminalOptions>;
  return {
    fontFamily: o.fontFamily,
    lineHeight: o.lineHeight,
    letterSpacing: o.letterSpacing,
  };
}

/** The options a host gave: a key given as `undefined` is a key left out. */
export function givenOptions(raw: XtermOptions | undefined): XtermOptions {
  return Object.fromEntries(
    Object.entries(raw ?? {}).filter(([, v]) => v !== undefined),
  ) as XtermOptions;
}

/**
 * [LAW:parse-dont-validate] An owned option is refused at the call that
 * passed it; every other is set on an unopened xterm.js terminal first, so a
 * key xterm does not have, or a value it refuses, throws there, before any
 * pane has changed. The cell's font must be finite, since the window is
 * sized from it.
 * [LAW:single-enforcer] xterm.js's own options object judges the keys and its
 *   setters the values; the terminal keeps no copy of their rules.
 */
export function parseXtermOptions(raw: XtermOptions | undefined): ParsedXterm {
  const given = givenOptions(raw);
  for (const key of Object.keys(given)) {
    if (owned.has(key)) {
      throw new RangeError(
        `xterm.${key} is set by the window terminal, not the host`,
      );
    }
  }
  const probe = new Terminal({ ...TERMINAL_DEFAULTS });
  try {
    const o = probe.options as Record<string, unknown>;
    for (const [key, value] of Object.entries(given)) {
      if (!Object.hasOwn(o, key)) {
        throw new RangeError(`xterm.${key} is not an xterm.js option`);
      }
      try {
        o[key] = value;
      } catch (cause) {
        throw new RangeError(`xterm.${key}: ${(cause as Error).message}`, {
          cause,
        });
      }
    }
    const font = cellFontOf(probe.options);
    for (const key of ["lineHeight", "letterSpacing"] as const) {
      if (!Number.isFinite(font[key])) {
        throw new RangeError(`xterm.${key} must be finite, not ${font[key]}`);
      }
    }
    return { given, font };
  } finally {
    probe.dispose();
  }
}

function isPlain(v: unknown): v is Readonly<Record<string, unknown>> {
  if (typeof v !== "object" || v === null) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === Array.prototype;
}

/**
 * Whether two option values are the same: plain objects and arrays by their
 * contents, everything else (functions included) by identity. A host passing
 * an inline theme hands a new object every render, and xterm.js redraws on
 * any theme assignment; a new `linkHandler.activate` must still be written.
 */
export function sameOption(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (!isPlain(a) || !isPlain(b) || Array.isArray(a) !== Array.isArray(b)) {
    return false;
  }
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((k) => Object.hasOwn(b, k) && sameOption(a[k], b[k]))
  );
}

/**
 * The writes that take a pane from the options it has to `next`: each key
 * whose value differs, to `next`'s value, or to `base`'s (the pane's own,
 * before any host option) where `next` leaves it out.
 */
export function optionWrites(
  applied: XtermOptions,
  next: XtermOptions,
  base: Readonly<Record<string, unknown>>,
): readonly (readonly [string, unknown])[] {
  const was = applied as Readonly<Record<string, unknown>>;
  const now = next as Readonly<Record<string, unknown>>;
  const keys = new Set([...Object.keys(was), ...Object.keys(now)]);
  return [...keys]
    .filter((k) => !sameOption(was[k], now[k]))
    .map((k) => [k, now[k] === undefined ? base[k] : now[k]] as const);
}
