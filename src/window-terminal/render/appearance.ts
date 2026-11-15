// src/window-terminal/render/appearance.ts
//
// The xterm.js look of every pane, and its checkpoint.
//
// [LAW:one-way-deps] The one xterm type the public options name lives in
//   render/, the only layer (beside react/) that may import xterm.js.

import type { ITerminalOptions } from "@xterm/xterm";

/** The xterm.js look of every pane. Font size lives in `Sizing`. */
export type Appearance = Pick<
  ITerminalOptions,
  "theme" | "fontFamily" | "lineHeight" | "cursorStyle"
>;

/**
 * [LAW:parse-dont-validate] xterm.js takes a `lineHeight` below 1 by throwing
 * from deep inside its option setter; the terminal refuses it at the call that
 * passed it instead.
 */
export function parseAppearance(raw: Appearance | undefined): Appearance {
  const a = raw ?? {};
  if (
    a.lineHeight !== undefined &&
    !(Number.isFinite(a.lineHeight) && a.lineHeight >= 1)
  ) {
    throw new RangeError(
      `appearance.lineHeight must be a number of at least 1; got ${String(a.lineHeight)}`,
    );
  }
  return a;
}

/**
 * Whether two appearances look the same. A host passing an inline
 * `appearance` hands a new object every render; xterm.js redraws every pane
 * on any theme assignment, so only a different look reaches it. An
 * appearance is plain data (strings, numbers, a theme of colour strings), so
 * its JSON is the comparison.
 */
export function sameAppearance(a: Appearance, b: Appearance): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
