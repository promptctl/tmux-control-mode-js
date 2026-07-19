// examples/web-multiplexer/web/selection-controller.ts
//
// SelectionController — the demo's imperative session/window/pane selection
// commands. Each only dispatches a tmux command and nudges a fast-path
// refresh; the subscription-fed tree stays the source of truth for what is
// active. The cross-session jump and plain session switch are optimistic:
// they adopt the target immediately and roll back through TmuxModel's
// token-guarded protocol if tmux never actually switched. [LAW:decomposition]
//
// [LAW:single-enforcer] The demo's primary session/window/pane navigation is
// owned here; callers pass ids, never assemble these tmux target strings
// themselves. (Standalone playground features that issue their own unrelated
// commands are a separate concern, not routed through this controller.)

import type { TmuxBridge } from "./bridge.ts";
import type { PaneInfo, TmuxModel } from "./tmux-model.ts";
import type { RefreshPolicy } from "./refresh-policy.ts";

export class SelectionController {
  constructor(
    private readonly client: TmuxBridge,
    private readonly model: TmuxModel,
    private readonly refresh: RefreshPolicy,
  ) {}

  selectSession(id: number): void {
    // Optimistic: adopt the id we just told tmux to switch to. The
    // %client-session-changed event will confirm it shortly.
    const token = this.model.beginSelect(id);
    // [LAW:no-silent-failure] If the switch doesn't land — a transport
    // rejection, OR a tmux %error which resolves execute() with
    // {success:false} rather than throwing (same contract jumpToPane checks) —
    // the confirming event never arrives, so revert the optimistic pointer.
    // Otherwise activeSessionId would keep pointing at a session tmux never
    // switched to. Guarded by `token`: a newer selectSession/jumpToPane must
    // win over this reversion arriving late.
    void (async () => {
      let switched = false;
      try {
        switched = (await this.client.execute(`switch-client -t \\$${id}`))
          .success;
        if (!switched) {
          console.warn(
            "[selection] selectSession switch-client returned %error",
          );
        }
      } catch (err) {
        console.warn("[selection] selectSession failed", err);
      }
      // Gate on the token before acting, symmetric with jumpToPane: a newer
      // select/jump issued while switch-client was pending owns the pointer
      // now, so a stale call must neither revert nor log. [LAW:no-ambient-temporal-coupling]
      if (!this.model.isCurrentSelect(token)) return;
      if (!switched) this.model.revertSelectIfCurrent(token);
    })();
    void this.refresh.refreshSession(id);
  }

  selectWindow(id: number): void {
    const s = this.model.currentSession;
    const w = s?.windows.find((x) => x.id === id);
    if (s !== null && w !== undefined) {
      void this.client
        .execute(`select-window -t ${s.name}:${w.index}`)
        .catch((err: unknown) =>
          console.warn("[selection] selectWindow failed", err),
        );
      void this.refresh.refreshSession(s.id);
    }
  }

  selectPane(pane: PaneInfo): void {
    const s = this.model.currentSession;
    const w = this.model.currentWindow;
    if (s !== null && w !== null) {
      void this.client
        .execute(`select-pane -t ${s.name}:${w.index}.${pane.index}`)
        .catch((err: unknown) =>
          console.warn("[selection] selectPane failed", err),
        );
      void this.refresh.refreshSession(s.id);
    }
  }

  /**
   * Focus a pane anywhere in the server by absolute id, regardless of which
   * session/window is currently active. Used by cross-session jumps (e.g. a
   * search hit in another session).
   *
   * [LAW:no-ambient-temporal-coupling] `select-window`/`select-pane` target
   *   the session `switch-client` was supposed to activate, so that ordering
   *   dependency is made explicit: they are only issued after `switch-client`
   *   *actually switched*. A switch that failed — either a transport rejection
   *   or a tmux `%error` (which resolves `execute()` with `{success:false}`
   *   rather than throwing) — short-circuits the jump instead of the other two
   *   firing regardless and moving the target session's active window/pane
   *   while the client itself never switched there. Once switched,
   *   `select-window`/`select-pane` use `@windowId` / `%paneId` absolute
   *   targets that tmux resolves itself — no reliance on the client-side model
   *   catching up between the two.
   */
  jumpToPane(sessionId: number, windowId: number, paneId: number): void {
    const token = this.model.beginSelect(sessionId);
    void (async () => {
      let switched = false;
      try {
        // A tmux %error resolves execute() with {success:false} (see
        // ws-client.ts) rather than throwing, so "switched" means the command
        // succeeded, not merely that the promise settled.
        switched = (
          await this.client.execute(`switch-client -t \\$${sessionId}`)
        ).success;
        if (!switched) {
          console.warn("[selection] jumpToPane switch-client returned %error");
        }
      } catch (err) {
        console.warn("[selection] jumpToPane switch-client failed", err);
      }
      // [LAW:no-ambient-temporal-coupling] Everything past the await is gated
      // on the token: a newer selectSession/jumpToPane issued while
      // switch-client was pending owns the pointer now, so a stale call must
      // neither revert it nor fire its select commands.
      if (!this.model.isCurrentSelect(token)) return;
      if (!switched) {
        // [LAW:no-silent-failure] The client never switched — revert the
        // optimistic pointer (same rationale as selectSession) and
        // short-circuit, rather than firing select-window/select-pane against
        // the wrong (still-current) session.
        this.model.revertSelectIfCurrent(token);
        return;
      }
      void this.client
        .execute(`select-window -t @${windowId}`)
        .catch((err: unknown) =>
          console.warn("[selection] jumpToPane select-window failed", err),
        );
      void this.client
        .execute(`select-pane -t %${paneId}`)
        .catch((err: unknown) =>
          console.warn("[selection] jumpToPane select-pane failed", err),
        );
    })();
    void this.refresh.refreshSession(sessionId);
  }
}
