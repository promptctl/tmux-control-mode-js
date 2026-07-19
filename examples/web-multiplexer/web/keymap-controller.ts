// examples/web-multiplexer/web/keymap-controller.ts
//
// KeymapController — drives the pure keymap engine (see
// tmux-control-mode-js/keymap) directly, rather than via bindKeymap, so it
// can (1) surface a "prefix active" signal into a MobX observable the UI can
// render, and (2) intercept destructive actions (kill-pane, kill-window) for
// a user-confirmation dialog before dispatching. [LAW:decomposition]
//
// [LAW:single-enforcer] dispatchAction from the library owns the single
// canonical Action → tmux command mapping. This controller only decides
// WHICH actions to forward and when — it never re-implements what tmux
// command corresponds to `split` / `select-pane` / etc.

import { makeAutoObservable } from "mobx";
import type { TmuxBridge } from "./bridge.ts";
import {
  INITIAL_STATE,
  defaultTmuxKeymap,
  dispatchAction,
  handleKey,
  type Action,
  type KeyEvent,
  type Keymap,
  type KeymapState,
} from "@promptctl/tmux-control-mode-js/keymap";
import type { TmuxModel } from "./tmux-model.ts";
import type { RefreshPolicy } from "./refresh-policy.ts";

export interface PendingConfirm {
  readonly action: Action;
  readonly prompt: string;
}

/**
 * Hooks the demo wires in so certain keymap actions don't dispatch to tmux
 * but instead drive the demo's own UI. Library stays out of this: the library
 * emits the semantic Action, the demo decides the policy.
 */
export interface KeymapHooks {
  /** Called when the keymap emits `choose-session` (C-b s). */
  readonly onChooseSession?: () => void;
}

export class KeymapController {
  // [LAW:one-source-of-truth] `prefixActive` is the demo's UI-facing
  // projection of the keymap engine's state. The engine is the source of
  // truth; this field mirrors `engineState.mode === "prefix"` and is set from
  // exactly one place (handleKeyEvent below).
  prefixActive = false;

  // When a destructive action (kill-pane, kill-window) is dispatched, the demo
  // shows a confirm modal backed by this observable. Setting it non-null opens
  // the modal; confirming dispatches; cancelling discards.
  pendingConfirm: PendingConfirm | null = null;

  // [LAW:one-source-of-truth] One keymap engine per client session. The
  // engine's state (root vs. prefix) is shared across all pane mounts so
  // pressing C-b in one pane doesn't leave the others in a stale mode.
  private readonly keymapConfig: Keymap = defaultTmuxKeymap();
  private engineState: KeymapState = INITIAL_STATE;

  constructor(
    private readonly client: TmuxBridge,
    private readonly model: TmuxModel,
    private readonly refresh: RefreshPolicy,
    private readonly hooks: KeymapHooks,
  ) {
    // engineState is a non-observable plumbing detail — the UI observes
    // `prefixActive` instead, which is set whenever the engine transitions.
    // [LAW:no-shared-mutable-globals] Exposing raw engine state would create a
    // second source of truth for "is the prefix active".
    makeAutoObservable<
      this,
      "client" | "model" | "refresh" | "hooks" | "keymapConfig" | "engineState"
    >(this, {
      client: false,
      model: false,
      refresh: false,
      hooks: false,
      keymapConfig: false,
      engineState: false,
    });
  }

  /**
   * Called by PaneTerminal whenever xterm sees a keydown. Returns true if the
   * keymap consumed the event (caller must prevent default); false if the
   * caller should route the key to the focused pane.
   */
  handleKeyEvent(ev: KeyEvent): boolean {
    const prev = this.engineState;
    const result = handleKey(ev, prev, this.keymapConfig);
    if (result.state !== prev) {
      this.engineState = result.state;
      this.prefixActive = result.state.mode === "prefix";
    }
    for (const action of result.actions) this.dispatchWithConfirm(action);
    return result.handled;
  }

  private dispatchWithConfirm(action: Action): void {
    if (action.type === "kill-pane") {
      this.pendingConfirm = { action, prompt: "Kill this pane?" };
      return;
    }
    if (action.type === "kill-window") {
      this.pendingConfirm = { action, prompt: `Kill the current window?` };
      return;
    }
    // [LAW:dataflow-not-control-flow] The demo's policy for choose-session is
    // "open the sidebar" rather than tmux's choose-tree. Intercept the action,
    // invoke the hook, swallow the dispatch.
    if (action.type === "choose-session") {
      this.hooks.onChooseSession?.();
      return;
    }
    this.dispatchAndRefresh(action);
  }

  /**
   * Dispatch an action to tmux and then fast-path a targeted refresh of the
   * current session's windows/panes. Subscriptions will catch up within ~1s
   * on their own; this just makes the UI feel snappy after a user keystroke.
   *
   * [LAW:single-enforcer] This is the ONE place that pairs an action dispatch
   * with a refresh. Event handlers don't write active state; the refresh call
   * here is what pulls the post-action truth from tmux.
   */
  private dispatchAndRefresh(action: Action): void {
    dispatchAction(this.client, action);
    const sid = this.model.activeSessionId;
    if (sid !== null) void this.refresh.refreshSession(sid);
  }

  confirmPendingAction(): void {
    const pending = this.pendingConfirm;
    this.pendingConfirm = null;
    if (pending !== null) this.dispatchAndRefresh(pending.action);
  }

  cancelPendingAction(): void {
    this.pendingConfirm = null;
  }
}
