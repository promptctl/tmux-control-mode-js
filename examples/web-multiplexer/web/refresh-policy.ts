// examples/web-multiplexer/web/refresh-policy.ts
//
// RefreshPolicy — routes incoming wire events to targeted model refreshes.
// The subscriptions drive the steady-state model, but they are rate-limited
// to ~1 Hz; this layer owns the sub-second fast-paths that keep the UI
// feeling instant after a change (a targeted list-windows/list-panes, or a
// pane-dimension patch on %layout-change). Every write it makes goes through
// TmuxModel; it holds no model state of its own. [LAW:decomposition]
// [LAW:effects-at-boundaries]

import type { TmuxBridge } from "./bridge.ts";
import type { TmuxMessage } from "@promptctl/tmux-control-mode-js";
import type { PaneDimensions, TmuxModel } from "./tmux-model.ts";

export class RefreshPolicy {
  constructor(
    private readonly client: TmuxBridge,
    private readonly model: TmuxModel,
  ) {}

  /**
   * Route one wire event. Subscription deltas rebuild the model; the
   * targeted events kick a fast-path refresh so the subscription-fed tree
   * picks up new active flags / geometry in a few ms instead of ~1 s.
   *
   * [LAW:one-source-of-truth] Active-pointer events (session-window-changed,
   * window-pane-changed) trigger NO local writes beyond `clientSessionId`
   * (whose only source is client-session-changed) — the subscription tree
   * carries `session.attached` / `window.active` / `pane.active`, and the
   * derived getters read those. Patching them here would create parallel
   * state; instead we just nudge the refresh.
   */
  handleEvent(ev: TmuxMessage): void {
    if (ev.type === "subscription-changed") {
      this.model.applySnapshot(ev.name, ev.value);
      return;
    }
    if (ev.type === "layout-change") {
      // [LAW:dataflow-not-control-flow] Pane geometry must feel instant when a
      // user resizes their terminal, so fast-path on %layout-change with a
      // targeted list-panes for just that window. O(panes-in-one-window).
      void this.refreshWindowDimensions(ev.windowId);
      return;
    }
    if (ev.type === "client-session-changed") {
      // The ONLY local state write triggered by an event: which session OUR
      // control client is attached to — tmux doesn't express this via
      // subscriptions.
      this.model.setClientSession(ev.sessionId);
      void this.refreshSession(ev.sessionId);
      return;
    }
    if (
      ev.type === "session-window-changed" ||
      ev.type === "window-pane-changed"
    ) {
      const sid =
        ev.type === "session-window-changed"
          ? ev.sessionId
          : this.model.clientSessionId;
      if (sid !== null) void this.refreshSession(sid);
      return;
    }
  }

  /**
   * Targeted fast-path: re-list one session's windows and panes and merge
   * them into the model right away, rather than waiting up to a second for
   * the next subscription tick. [LAW:single-enforcer] The subscription
   * pipeline stays the steady-state builder; this feeds the same merge path.
   */
  async refreshSession(sessionId: number): Promise<void> {
    try {
      const [windowsResp, panesResp] = await Promise.all([
        this.client.execute(
          `list-windows -t $${sessionId} -F '$${sessionId}|#{window_id}|#{window_index}|#{window_name}|#{window_active}|#{window_zoomed_flag}'`,
        ),
        this.client.execute(
          `list-panes -s -t $${sessionId} -F '#{window_id}|#{pane_id}|#{pane_index}|#{pane_active}|#{pane_width}|#{pane_height}|#{pane_title}'`,
        ),
      ]);
      if (!windowsResp.success || !panesResp.success) return;
      this.model.mergeSession(sessionId, windowsResp.output, panesResp.output);
    } catch {
      // Non-fatal: subscriptions will catch up.
    }
  }

  async refreshWindowDimensions(windowId: number): Promise<void> {
    try {
      const resp = await this.client.execute(
        `list-panes -t @${windowId} -F '#{pane_id}|#{pane_width}|#{pane_height}'`,
      );
      if (!resp.success) return;
      const updates = new Map<number, PaneDimensions>();
      for (const line of resp.output) {
        if (line.length === 0) continue;
        const [pidRaw, wRaw, hRaw] = line.split("|");
        const pid = parseInt(pidRaw.replace(/^%/, ""), 10);
        const w = parseInt(wRaw, 10);
        const h = parseInt(hRaw, 10);
        if (Number.isFinite(pid) && Number.isFinite(w) && Number.isFinite(h)) {
          updates.set(pid, { w, h });
        }
      }
      this.model.applyPaneDimensions(updates);
    } catch {
      // Non-fatal; the subscription's 1 Hz cadence will correct any miss.
    }
  }
}
