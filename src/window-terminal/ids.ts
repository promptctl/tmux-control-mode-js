// src/window-terminal/ids.ts
//
// tmux's window and pane ids as the window terminal's public seam spells them:
// `@3`, `%7`. Inside, the library works in numbers (every TmuxMessage carries
// `windowId: number`); these types are the string form at the public edge and
// the one place the two convert.
//
// [LAW:parse-dont-validate] `parseWindowId`/`parsePaneId` are the checkpoint:
//   a string that is not a tmux id never becomes a `WindowId`/`PaneId`, so no
//   code past them asks again.
// [LAW:types-are-the-program] Template-literal types: a `PaneId` cannot be
//   passed where a `WindowId` is wanted, and `string` cannot be passed for
//   either.

export type WindowId = `@${number}`;
export type PaneId = `%${number}`;

const WINDOW_ID = /^@(0|[1-9]\d*)$/;
const PANE_ID = /^%(0|[1-9]\d*)$/;

function parseId(raw: unknown, pattern: RegExp, what: string): number {
  const m = typeof raw === "string" ? pattern.exec(raw) : null;
  const n = m === null ? NaN : Number(m[1]);
  if (!Number.isSafeInteger(n)) {
    throw new RangeError(
      `${what} must look like ${pattern.source}; got ${JSON.stringify(raw)}`,
    );
  }
  return n;
}

/** `"@3"` → `"@3"` as a `WindowId`; anything else throws `RangeError`. */
export function parseWindowId(raw: unknown): WindowId {
  return windowIdOf(parseId(raw, WINDOW_ID, "a window id"));
}

/** `"%7"` → `"%7"` as a `PaneId`; anything else throws `RangeError`. */
export function parsePaneId(raw: unknown): PaneId {
  return paneIdOf(parseId(raw, PANE_ID, "a pane id"));
}

export function windowIdOf(n: number): WindowId {
  return `@${n}`;
}

export function paneIdOf(n: number): PaneId {
  return `%${n}`;
}

/** The number tmux's messages carry for this window. */
export function windowNumber(id: WindowId): number {
  return Number(id.slice(1));
}

/** The number tmux's messages carry for this pane. */
export function paneNumber(id: PaneId): number {
  return Number(id.slice(1));
}
