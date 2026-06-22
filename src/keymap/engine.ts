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

// [LAW:decomposition] A ChordBinding is a static keystroke → intent pairing —
// a distinct concept from the live binding handle the dispatcher layer returns,
// so the two carry distinct names rather than being conflated under one type.
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
 * - any mode + bare modifier (Shift/Control/Alt/Meta) → state unchanged, actions=[], handled=false
 * - `root` + prefix chord                       → state=prefix, actions=[],       handled=true
 * - `root` + anything else                      → state=root,   actions=[],       handled=false
 * - `prefix` + bound chord                      → state=root,   actions=[action], handled=true
 * - `prefix` + prefix chord (unbound)           → state=root,   actions=[],       handled=false  (send-prefix)
 * - `prefix` + unbound non-prefix chord         → state=root,   actions=[],       handled=true
 *
 * The bare-modifier row is distinct: it is the only outcome that preserves the
 * incoming state. A modifier pressed mid-sequence (e.g. Shift to reach `%`
 * after the prefix) must not be read as an "unbound non-prefix chord" and drop
 * prefix mode, so it passes through with state untouched.
 *
 * The send-prefix row matches tmux's default `C-b C-b` behavior: pressing the
 * prefix key a second time exits prefix mode AND lets the UI forward the
 * literal prefix key to the focused pane (handled=false). An explicit binding
 * for the prefix key still wins over send-prefix (the binding row is checked
 * first in the index selection below).
 *
 * [LAW:dataflow-not-control-flow] The function always executes the same
 * sequence: compute (isBareModifier, isPrefix, matchedBinding, isInPrefixMode),
 * then index into the outcomes table. No branch does less work than another and
 * there is no early return; the bare-modifier pass-through is a row of the
 * table like every other outcome, and the returned *value* encodes which one.
 */
// [LAW:one-source-of-truth] Bare modifier key names per KeyboardEvent.key.
// A keydown whose `key` IS one of these is a user pressing a modifier in
// preparation for a chord — never a chord on its own. Treating it like any
// other key would wreck prefix mode: pressing Shift to type `%` after `C-b`
// would be seen as "unbound chord in prefix" and drop the prefix.
const BARE_MODIFIER_KEYS: ReadonlySet<string> = new Set([
  "Shift",
  "Control",
  "Alt",
  "Meta",
]);

export function handleKey(
  event: KeyEvent,
  state: KeymapState,
  keymap: Keymap,
): HandleResult {
  const isBareModifier = BARE_MODIFIER_KEYS.has(event.key);
  const isPrefix = keysEqual(event, keymap.prefix);
  const matched = findBinding(event, keymap.bindings);
  const inPrefixMode = state.mode === "prefix";

  // Table-driven outcome. [LAW:dataflow-not-control-flow] — the rows of this
  // decision are data, not branches of an if/else cascade. Each row produces a
  // fully-formed result; no row "skips" a field.
  const outcomes: readonly HandleResult[] = [
    // inPrefixMode && matched              — bound chord fires, return to root
    {
      state: INITIAL_STATE,
      actions: matched !== null ? [matched.action] : [],
      handled: true,
    },
    // inPrefixMode && !matched && !isPrefix — unbound non-prefix chord, swallow
    { state: INITIAL_STATE, actions: [], handled: true },
    // !inPrefixMode && isPrefix            — enter prefix mode
    { state: { mode: "prefix" }, actions: [], handled: true },
    // !inPrefixMode && !isPrefix           — pass through
    { state: INITIAL_STATE, actions: [], handled: false },
    // inPrefixMode && !matched && isPrefix  — send-prefix: return to root and
    //                                        let the UI forward the literal
    //                                        prefix key to the focused pane
    { state: INITIAL_STATE, actions: [], handled: false },
    // isBareModifier (any mode)            — pass through, PRESERVING state so a
    //                                        modifier pressed mid-chord can't
    //                                        drop prefix mode (the only row that
    //                                        keeps the incoming state)
    { state, actions: [], handled: false },
  ];

  // Index selection is the only decision — again, data drives which row we
  // return, not control flow over emitted work. A bare modifier is checked
  // first (it must never disturb state); below that, an explicit binding for
  // the prefix key (matched !== null) wins over the send-prefix row, so users
  // can override `C-b C-b` with their own binding.
  const index = isBareModifier
    ? 5
    : inPrefixMode
      ? matched !== null
        ? 0
        : isPrefix
          ? 4
          : 1
      : isPrefix
        ? 2
        : 3;
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
