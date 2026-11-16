// src/window-terminal/render/xterm-options.ts
//
// The host's xterm.js options for every pane, and their checkpoint.
//
// [LAW:one-way-deps] The one xterm type the public options name lives in
//   render/, the only layer (beside react/) that may import xterm.js.
// [LAW:composability] The host's whole set crosses the seam as one value;
//   a new xterm option needs no change here.

import type { ITerminalAddon, ITerminalOptions } from "@xterm/xterm";

/**
 * The addons a pane's xterm loads, called once per pane (an addon instance
 * belongs to one terminal), after the host's options are set and the
 * terminal is open. xterm disposes them with the pane.
 */
export type XtermAddons = () => readonly ITerminalAddon[];

/**
 * The xterm.js options the window terminal sets itself, because tmux or the
 * terminal decides them: tmux sizes the window (cols, rows), its bytes are
 * written as sent (convertEol), input goes through tmux (disableStdin), its
 * panes keep 8-column tab stops (tabStopWidth) and answer the window reports
 * themselves (windowOptions), the sizing solver picks the font size from
 * `sizing.font` (fontSize), and `history` is the scrollback (scrollback).
 */
export const TERMINAL_OWNED = [
  "cols",
  "rows",
  "convertEol",
  "disableStdin",
  "windowsMode",
  "windowsPty",
  "documentOverride",
  "fontSize",
  "scrollback",
  "tabStopWidth",
  "windowOptions",
] as const;

/** xterm.js's options for every pane, less the ones the terminal owns. */
export type XtermOptions = Omit<
  ITerminalOptions,
  (typeof TERMINAL_OWNED)[number]
>;

const owned: ReadonlySet<string> = new Set(TERMINAL_OWNED);

const atLeastOne = (v: unknown): boolean =>
  typeof v === "number" && Number.isFinite(v) && v >= 1;
const positive = (v: unknown): boolean =>
  typeof v === "number" && Number.isFinite(v) && v > 0;

// What xterm.js's option setter refuses by throwing from deep inside it.
const ACCEPTS: Readonly<
  Record<string, readonly [accepts: (v: unknown) => boolean, wants: string]>
> = {
  cursorStyle: [
    (v) => v === "block" || v === "underline" || v === "bar",
    '"block", "underline" or "bar"',
  ],
  cursorWidth: [atLeastOne, "a number of at least 1"],
  lineHeight: [atLeastOne, "a number of at least 1"],
  scrollSensitivity: [positive, "a number above 0"],
  fastScrollSensitivity: [positive, "a number above 0"],
};

/**
 * [LAW:parse-dont-validate] An owned option, or a value xterm.js's setter
 * would throw on, is refused at the call that passed it, before any pane has
 * changed. A key given as `undefined` is a key left out.
 */
export function parseXtermOptions(raw: XtermOptions | undefined): XtermOptions {
  const given = Object.entries(raw ?? {}).filter(([, v]) => v !== undefined);
  for (const [key, value] of given) {
    if (owned.has(key)) {
      throw new RangeError(
        `xterm.${key} is set by the window terminal, not the host`,
      );
    }
    const check = Object.hasOwn(ACCEPTS, key) ? ACCEPTS[key] : undefined;
    if (check !== undefined && !check[0](value)) {
      throw new RangeError(
        `xterm.${key} must be ${check[1]}; got ${JSON.stringify(value)}`,
      );
    }
  }
  return Object.fromEntries(given) as XtermOptions;
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
