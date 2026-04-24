// src/keymap/actions.ts
// Discriminated union of every intent a bound chord can produce.
// The engine emits these; the dispatcher (bind.ts) is the single enforcer
// that translates them into tmux commands.

// [LAW:one-source-of-truth] Action is the canonical vocabulary between the
// pure engine and any dispatcher. Downstream code discriminates on `type`;
// adding a variant here forces a dispatcher update (non-exhaustive switch
// becomes a compile error under `strict`).
// [LAW:one-type-per-behavior] Every action variant represents a distinct
// tmux operation. Variants that would differ only by parameter live as one
// type with a parameter field (e.g. select-window carries an index).
export type Action =
  | { readonly type: "new-window" }
  | { readonly type: "next-window" }
  | { readonly type: "previous-window" }
  | { readonly type: "last-window" }
  | { readonly type: "select-window"; readonly index: number }
  | { readonly type: "kill-window" }
  | { readonly type: "split"; readonly orientation: "horizontal" | "vertical" }
  | {
      readonly type: "select-pane";
      readonly direction: "up" | "down" | "left" | "right";
    }
  | { readonly type: "next-pane" }
  | { readonly type: "kill-pane" }
  | { readonly type: "zoom-pane" }
  | { readonly type: "break-pane" }
  | { readonly type: "swap-pane"; readonly direction: "next" | "previous" }
  | {
      readonly type: "resize-pane";
      readonly direction: "up" | "down" | "left" | "right";
      readonly amount: number;
    }
  | { readonly type: "detach" }
  | { readonly type: "next-session" }
  | { readonly type: "previous-session" }
  | { readonly type: "choose-session" }
  | { readonly type: "command-prompt" };
