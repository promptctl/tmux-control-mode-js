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
 * - `root` + prefix chord                       → state=prefix, actions=[],       handled=true
 * - `root` + anything else                      → state=root,   actions=[],       handled=false
 * - `prefix` + bound chord                      → state=root,   actions=[action], handled=true
 * - `prefix` + prefix chord (unbound)           → state=root,   actions=[],       handled=false  (send-prefix)
 * - `prefix` + unbound non-prefix chord         → state=root,   actions=[],       handled=true
 *
 * The send-prefix row matches tmux's default `C-b C-b` behavior: pressing the
 * prefix key a second time exits prefix mode AND lets the UI forward the
 * literal prefix key to the focused pane (handled=false). An explicit binding
 * for the prefix key still wins over send-prefix (the binding row is checked
 * first in the index selection below).
 *
 * [LAW:dataflow-not-control-flow] The function always executes the same
 * sequence: compute (isPrefix, matchedBinding, isInPrefixMode), then pick
 * the result. There is no early-return optimization that would cause one
 * branch to do less work than another; control flow is the same shape per
 * call and the returned *value* encodes the outcome.
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
  // [LAW:dataflow-not-control-flow] Bare-modifier keydowns produce a
  // deterministic pass-through result: state unchanged, no actions, not
  // handled. The caller still gets a HandleResult with the same shape —
  // we're not skipping the function, we're returning early-out data.
  if (BARE_MODIFIER_KEYS.has(event.key)) {
    return { state, actions: [], handled: false };
  }

  const isPrefix = keysEqual(event, keymap.prefix);
  const matched = findBinding(event, keymap.bindings);
  const inPrefixMode = state.mode === "prefix";

  // Table-driven outcome. [LAW:dataflow-not-control-flow] — the five rows of
  // this decision are data, not branches of an if/else cascade. Each row
  // produces a fully-formed HandleResult; no row "skips" a field.
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
  ];

  // Index selection is the only decision — again, data drives which row we
  // return, not control flow over emitted work. An explicit binding for the
  // prefix key (matched !== null) wins over the send-prefix row, so users can
  // override `C-b C-b` with their own binding.
  const index = inPrefixMode
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
