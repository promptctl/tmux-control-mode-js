// src/protocol/uint.ts
// The one reader of an unsigned decimal integer in tmux's output. Pure — no
// Node.js dependencies.

/**
 * Read `digits` as an unsigned decimal integer: one or more ASCII digits and
 * nothing else, no larger than `Number.MAX_SAFE_INTEGER`. Anything else (an
 * empty string, a sign, trailing text such as `12abc`) is `undefined`, never
 * a partial read the way `parseInt` gives `12` or `NaN`.
 *
 * [LAW:one-source-of-truth] The control-mode line parser and the layout parser
 * both read tmux's numbers through this function.
 */
export function parseUint(digits: string): number | undefined {
  if (!/^[0-9]+$/.test(digits)) return undefined;
  const value = Number(digits);
  return Number.isSafeInteger(value) ? value : undefined;
}
