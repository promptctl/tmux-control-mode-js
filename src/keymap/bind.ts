// src/keymap/bind.ts
// Binding layer: connects a pure engine to a live TmuxClient.
// [LAW:single-enforcer] This file is the SOLE place where Action → tmux
// command translation happens. No dispatcher logic lives elsewhere.

import type { Action } from "./actions.js";
import type { KeyEvent } from "./key-event.js";
import type { Keymap, KeymapState } from "./engine.js";
import { INITIAL_STATE, handleKey } from "./engine.js";

// [LAW:locality-or-seam] Minimal interface the dispatcher needs. Keeps the
// keymap module from depending on the full TmuxClient type (and its
// transport transitive deps), and makes the dispatcher trivially testable
// with a fake. TmuxClient satisfies this structurally.
export interface TmuxCommander {
  execute(command: string): unknown;
  splitWindow(options: { vertical?: boolean }): unknown;
  detach(): void;
}

export interface KeymapBinding {
  /**
   * Feed a key event. Returns `true` if the engine consumed the event
   * (prefix transition or bound chord, including unbound-in-prefix which is
   * swallowed silently per tmux behavior). Returns `false` if the UI should
   * handle the event itself — e.g. send as literal input to the focused
   * pane via its existing path.
   */
  handleKey(event: KeyEvent): boolean;
}

/**
 * Wire a keymap engine to a TmuxClient. The returned object holds the
 * engine state in a closure; callers feed key events and the dispatcher
 * translates emitted actions into client calls.
 *
 * Tmux commands dispatched here rely on the server's implicit "current
 * client" targeting — e.g. `new-window` applies to the client's active
 * session automatically. The binding layer therefore owns no focus state
 * for MVP; adding explicit targeting (for multi-client or headless-driver
 * scenarios) is a later expansion.
 *
 * [LAW:dataflow-not-control-flow] Every `handleKey` call runs the same
 * pipeline: engine → for-each action → dispatch. No short-circuit path.
 */
export function bindKeymap(
  client: TmuxCommander,
  keymap: Keymap,
): KeymapBinding {
  let state: KeymapState = INITIAL_STATE;

  return {
    handleKey(event) {
      const result = handleKey(event, state, keymap);
      state = result.state;
      // Fire-and-forget: actions dispatch asynchronously; the caller doesn't
      // await tmux acknowledgement just to process the next keystroke.
      for (const action of result.actions) dispatch(client, action);
      return result.handled;
    },
  };
}

// [LAW:single-enforcer] Exhaustive mapping from Action to tmux command.
// Adding a new Action variant is a compile error here under `strict` —
// TypeScript flags the unreachable `never` default.
function dispatch(client: TmuxCommander, action: Action): void {
  switch (action.type) {
    case "new-window":
      void client.execute("new-window");
      return;
    case "next-window":
      void client.execute("next-window");
      return;
    case "previous-window":
      void client.execute("previous-window");
      return;
    case "last-window":
      void client.execute("last-window");
      return;
    case "select-window":
      // `select-window -t :N` targets window index N in the current session.
      void client.execute(`select-window -t :${action.index}`);
      return;
    case "kill-window":
      void client.execute("kill-window");
      return;
    case "split":
      void client.splitWindow({ vertical: action.orientation === "vertical" });
      return;
    case "select-pane":
      void client.execute(`select-pane -${DIRECTION_FLAG[action.direction]}`);
      return;
    case "next-pane":
      // tmux's C-b o default: cycle to next pane in current window.
      void client.execute("select-pane -t :.+");
      return;
    case "kill-pane":
      void client.execute("kill-pane");
      return;
    case "zoom-pane":
      void client.execute("resize-pane -Z");
      return;
    case "break-pane":
      void client.execute("break-pane");
      return;
    case "swap-pane":
      // tmux `{` → swap with previous (-U), `}` → swap with next (-D).
      void client.execute(
        `swap-pane -${action.direction === "next" ? "D" : "U"}`,
      );
      return;
    case "resize-pane":
      void client.execute(
        `resize-pane -${DIRECTION_FLAG[action.direction]} ${action.amount}`,
      );
      return;
    case "detach":
      client.detach();
      return;
    case "next-session":
      void client.execute("switch-client -n");
      return;
    case "previous-session":
      void client.execute("switch-client -p");
      return;
    case "choose-session":
      void client.execute("choose-tree -s");
      return;
    case "command-prompt":
      void client.execute("command-prompt");
      return;
    default: {
      // Exhaustiveness check — never evaluated at runtime if the switch is
      // complete.
      const _exhaustive: never = action;
      void _exhaustive;
      return;
    }
  }
}

// [LAW:one-source-of-truth] Direction → tmux flag lookup. Four directions,
// one table; no inline ternaries scattered across the dispatcher.
const DIRECTION_FLAG: Readonly<
  Record<"up" | "down" | "left" | "right", string>
> = {
  up: "U",
  down: "D",
  left: "L",
  right: "R",
};
