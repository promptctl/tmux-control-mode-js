// src/keymap/engine.ts
// Pure state machine. Same function runs on every key; the (mode, event)
// pair drives which branch of the discriminated result it produces.
// Zero side effects, zero I/O, zero Node APIs.

import type { Action } from "./actions.js";
import type { KeyEvent } from "./key-event.js";
import { keysEqual } from "./key-event.js";

// [LAW:one-source-of-truth] KeymapState is a discriminated union. The set of
// modes lives here; adding a copy-mode later appends a variant, it does not
// fork into a parallel state type.
export type KeymapState =
  | { readonly mode: "root" }
  | { readonly mode: "prefix" };

// [LAW:one-type-per-behavior] Renamed from `Binding` to avoid collision with
// the bind.ts `KeymapBinding` (the returned handle). A ChordBinding is a
// pairing of keystroke → intent; the other is a live handle — different
// things, different names.
export interface ChordBinding {
  readonly chord: KeyEvent;
  readonly action: Action;
}

export interface Keymap {
  readonly prefix: KeyEvent;
  readonly bindings: readonly ChordBinding[];
}

// [LAW:one-source-of-truth] Every `handle()` call produces this exact shape;
// no overloads, no optional fields. Consumers always destructure the same
// three properties.
export interface HandleResult {
  readonly state: KeymapState;
  readonly actions: readonly Action[];
  /**
   * `true` if the engine consumed the event — either entering prefix mode
   * or resolving a bound chord (including unbound-in-prefix, which is
   * swallowed). `false` means the UI should treat the key as its own: in a
   * terminal UI, forward it to the focused pane via the UI's existing path.
   */
  readonly handled: boolean;
}

export const INITIAL_STATE: KeymapState = { mode: "root" };

/**
 * Advance the keymap state machine by one key event.
 *
 * Contract:
 * - `root` + prefix chord           → state=prefix, actions=[],       handled=true
 * - `root` + anything else          → state=root,   actions=[],       handled=false
 * - `prefix` + bound chord          → state=root,   actions=[action], handled=true
 * - `prefix` + unbound chord        → state=root,   actions=[],       handled=true
 *
 * [LAW:dataflow-not-control-flow] The function always executes the same
 * sequence: compute (isPrefix, matchedBinding, isInPrefixMode), then pick
 * the result. There is no early-return optimization that would cause one
 * branch to do less work than another; control flow is the same shape per
 * call and the returned *value* encodes the outcome.
 */
export function handleKey(
  event: KeyEvent,
  state: KeymapState,
  keymap: Keymap,
): HandleResult {
  const isPrefix = keysEqual(event, keymap.prefix);
  const matched = findBinding(event, keymap.bindings);
  const inPrefixMode = state.mode === "prefix";

  // Table-driven outcome. [LAW:dataflow-not-control-flow] — the four rows of
  // this decision are data, not four branches of an if/else cascade. Each
  // row produces a fully-formed HandleResult; no row "skips" a field.
  const outcomes: readonly HandleResult[] = [
    // inPrefixMode && matched      — bound chord fires, return to root
    {
      state: INITIAL_STATE,
      actions: matched !== null ? [matched.action] : [],
      handled: true,
    },
    // inPrefixMode && !matched     — unbound chord, swallow, return to root
    { state: INITIAL_STATE, actions: [], handled: true },
    // !inPrefixMode && isPrefix    — enter prefix mode
    { state: { mode: "prefix" }, actions: [], handled: true },
    // !inPrefixMode && !isPrefix   — pass through
    { state: INITIAL_STATE, actions: [], handled: false },
  ];

  // Index selection is the only decision — again, data drives which row we
  // return, not control flow over emitted work.
  const index = inPrefixMode ? (matched !== null ? 0 : 1) : isPrefix ? 2 : 3;
  return outcomes[index];
}

// [LAW:single-enforcer] Binding lookup is the sole matcher. All chord
// comparisons route through keysEqual; no callsite rolls its own predicate.
function findBinding(
  event: KeyEvent,
  bindings: readonly ChordBinding[],
): ChordBinding | null {
  for (const b of bindings) {
    if (keysEqual(b.chord, event)) return b;
  }
  return null;
}
