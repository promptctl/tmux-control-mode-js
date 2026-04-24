// src/keymap/default-keymap.ts
// Standard tmux prefix bindings, derived from tmux's own key-bindings.c
// defaults. Scope is session/window/pane/split; copy-mode is out of scope.

import type { Action } from "./actions.js";
import type { ChordBinding, Keymap } from "./engine.js";
import { parseChord } from "./key-event.js";

// [LAW:one-source-of-truth] This function is the canonical default keymap.
// Consumers who want a customized set build their own Keymap from bindings
// — no "patch" API, because that would create a second place where the
// authoritative keymap shape is assembled.
export function defaultTmuxKeymap(): Keymap {
  return {
    prefix: parseChord("C-b"),
    bindings: DEFAULT_BINDINGS,
  };
}

// [LAW:dataflow-not-control-flow] The default bindings are data. Adding or
// removing a binding is a one-line table edit, never a new branch in a
// matcher function.
const DEFAULT_BINDINGS: readonly ChordBinding[] = [
  // Windows
  bind("c", { type: "new-window" }),
  bind("n", { type: "next-window" }),
  bind("p", { type: "previous-window" }),
  bind("l", { type: "last-window" }),
  bind("&", { type: "kill-window" }),
  // Digits 0–9 → select-window by index. Generated from the digit string so
  // we don't duplicate ten near-identical rows.
  ...Array.from({ length: 10 }, (_, i) =>
    bind(String(i), { type: "select-window", index: i }),
  ),

  // Splits — tmux convention: `%` is left/right (horizontal), `"` is
  // top/bottom (vertical). Matches split-window's -h / -v flags.
  bind("%", { type: "split", orientation: "horizontal" }),
  bind('"', { type: "split", orientation: "vertical" }),

  // Panes
  bind("o", { type: "next-pane" }),
  bind("x", { type: "kill-pane" }),
  bind("z", { type: "zoom-pane" }),
  bind("!", { type: "break-pane" }),
  bind("{", { type: "swap-pane", direction: "previous" }),
  bind("}", { type: "swap-pane", direction: "next" }),

  // Pane selection by direction — arrow keys
  bind("Up", { type: "select-pane", direction: "up" }),
  bind("Down", { type: "select-pane", direction: "down" }),
  bind("Left", { type: "select-pane", direction: "left" }),
  bind("Right", { type: "select-pane", direction: "right" }),

  // Pane resize — Ctrl+arrow, step of 5 rows/cols (tmux default)
  bind("C-Up", { type: "resize-pane", direction: "up", amount: 5 }),
  bind("C-Down", { type: "resize-pane", direction: "down", amount: 5 }),
  bind("C-Left", { type: "resize-pane", direction: "left", amount: 5 }),
  bind("C-Right", { type: "resize-pane", direction: "right", amount: 5 }),

  // Sessions / client
  bind("d", { type: "detach" }),
  bind("(", { type: "previous-session" }),
  bind(")", { type: "next-session" }),
  bind("s", { type: "choose-session" }),
  bind(":", { type: "command-prompt" }),
];

function bind(chord: string, action: Action): ChordBinding {
  return { chord: parseChord(chord), action };
}
