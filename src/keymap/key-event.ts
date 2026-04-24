// src/keymap/key-event.ts
// Neutral key-event shape. No browser/Electron/xterm dependencies.
// UI adapters translate their native event into this shape at the boundary.

// [LAW:one-source-of-truth] KeyEvent is the single vocabulary the engine
// speaks. Adapters (browser KeyboardEvent, Electron input event, xterm key
// handler) map into this, never around it.
export interface KeyEvent {
  readonly key: string;
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
  readonly meta: boolean;
}

// [LAW:one-source-of-truth] Chord equality lives here only. Every bindings
// lookup routes through this predicate — if we allowed callers to compare
// modifiers ad-hoc, two chord "keys" could disagree on casing or shift.
//
// Implicit shift: when the `key` is a single character that is NOT a
// lowercase letter and NOT a digit — uppercase letters, `%`, `!`, `{`, `|`
// and friends — the shift flag is treated as "don't care". Rationale: the
// browser's KeyboardEvent.key already encodes shift INTO the character
// (Shift+5 produces key="%" with shift:true; Shift+a produces key="A").
// Requiring callers to write `S-%` for `%` would be noise. For lowercase
// letters (`a` vs `A`) and digits (`1` vs `!`) shift meaningfully changes
// what you'd see, so we keep the strict comparison.
export function keysEqual(a: KeyEvent, b: KeyEvent): boolean {
  const shiftImplicit = shiftIsImplicit(a.key) || shiftIsImplicit(b.key);
  return (
    a.key === b.key &&
    a.ctrl === b.ctrl &&
    a.alt === b.alt &&
    (shiftImplicit || a.shift === b.shift) &&
    a.meta === b.meta
  );
}

// [LAW:single-enforcer] This predicate is the sole definition of "shift is
// baked into the character". Changing what counts as implicit-shift means
// editing exactly one place.
function shiftIsImplicit(key: string): boolean {
  return key.length === 1 && !/[a-z0-9]/.test(key);
}

// [LAW:dataflow-not-control-flow] parseChord produces a value; it never
// branches on "is there a modifier". Modifier tokens update the accumulator
// uniformly, whether present or absent.
/**
 * Parse a tmux-style chord notation into a KeyEvent.
 *
 *   parseChord("C-b")   → { key: "b",     ctrl: true,  ... }
 *   parseChord("M-x")   → { key: "x",     alt:  true,  ... }
 *   parseChord("S-Tab") → { key: "Tab",   shift: true, ... }
 *   parseChord("Up")    → { key: "ArrowUp" }
 *
 * The trailing token is always the key name. Modifier prefixes (`C-`, `M-`,
 * `S-`, `D-`) may be combined in any order: `C-M-x` is Ctrl+Alt+x.
 *
 * Emacs-style is accepted because that is how tmux's `key-bindings.c`
 * documents its defaults, and because it reads clearly in source.
 */
export function parseChord(chord: string): KeyEvent {
  let ctrl = false;
  let alt = false;
  let shift = false;
  let meta = false;
  let rest = chord;

  // Loop peels off `X-` prefixes. Each iteration sets one modifier or exits.
  // [LAW:dataflow-not-control-flow] The loop body runs the same way every
  // time; which modifier it sets is driven by the two-char prefix value.
  while (rest.length >= 2 && rest[1] === "-") {
    const pfx = rest[0];
    if (pfx === "C") ctrl = true;
    else if (pfx === "M") alt = true;
    else if (pfx === "S") shift = true;
    else if (pfx === "D") meta = true;
    else break;
    rest = rest.slice(2);
  }

  // Map tmux/terminal key names to the KeyboardEvent.key names we standardize
  // on. Keeping this as a data table (not if/else) preserves the
  // dataflow-not-control-flow property and lets consumers extend by forking
  // the table.
  const key = KEY_ALIASES.get(rest) ?? rest;

  return { key, ctrl, alt, shift, meta };
}

// [LAW:one-source-of-truth] Key-name aliases live in one table. tmux uses
// "Up" but KeyboardEvent.key produces "ArrowUp"; UIs feeding KeyEvent from
// the browser should see these as the same chord.
const KEY_ALIASES: ReadonlyMap<string, string> = new Map([
  ["Up", "ArrowUp"],
  ["Down", "ArrowDown"],
  ["Left", "ArrowLeft"],
  ["Right", "ArrowRight"],
  ["PgUp", "PageUp"],
  ["PgDn", "PageDown"],
  ["Space", " "],
  ["BSpace", "Backspace"],
]);
