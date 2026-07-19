// examples/web-multiplexer/web/tmux-model.ts
//
// TmuxModel — the reactive session/window/pane tree and everything derived
// from it. It owns the three latest subscription strings, the assembled
// `sessions` tree, and the one piece of per-client state tmux subscriptions
// can't give us (`clientSessionId`). It uses the pure snapshot-codec to
// rebuild; it never touches the client and performs no async work — effects
// live in the controllers that drive it. [LAW:decomposition]
// [LAW:effects-at-boundaries]

import { makeAutoObservable } from "mobx";
import {
  buildSessionTree,
  mergeSessionRows,
  mergePaneRowsByWindow,
  SESSIONS_SUB,
  WINDOWS_SUB,
  PANES_SUB,
  type PaneInfo,
  type SessionInfo,
  type WindowInfo,
} from "./snapshot-codec.ts";

/** A targeted pane-geometry update keyed by pane id. */
export interface PaneDimensions {
  readonly w: number;
  readonly h: number;
}

export class TmuxModel {
  sessions: SessionInfo[] = [];

  // [LAW:one-source-of-truth] This is the ONE piece of per-client state
  // tmux subscriptions cannot give us: "which session is THIS -CC control
  // client currently attached to". `session.attached` from the subscription
  // just means "some client is attached", so with multiple attached clients
  // it can't identify our own. tmux broadcasts this via
  // `%client-session-changed` — we capture that and nothing else writes it.
  //
  // `activeWindowId` / `activePaneId` stay fully computed from the tree:
  // `window.active` and `pane.active` ARE the truth and DO come through the
  // subscription.
  private clientSession: number | null = null;

  // Raw latest subscription values, kept as observable fields so the
  // assembled `sessions` tree can be rebuilt in one place.
  private latestSessions: string | null = null;
  private latestWindows: string | null = null;
  private latestPanes: string | null = null;

  // Monotonic id identifying which switch-client intent (selectSession /
  // jumpToPane) currently owns the optimistic `clientSession` write — an
  // identity guard, not a value guard, so a stale rejection can't clobber a
  // newer switch's value even when both target the same session id.
  // [LAW:no-ambient-temporal-coupling]
  private sessionSelectToken = 0;

  constructor() {
    makeAutoObservable(this);
  }

  get clientSessionId(): number | null {
    return this.clientSession;
  }

  /** Authoritative write of the attached-session pointer (from the
   *  `%client-session-changed` event, or the connect-time bootstrap). */
  setClientSession(id: number | null): void {
    this.clientSession = id;
  }

  /**
   * Begin an optimistic session switch: adopt `sessionId` immediately and
   * claim a fresh token. The caller carries the returned token through its
   * async switch-client so a later rejection can be matched back to THIS
   * intent (see `isCurrentSelect` / `revertSelectIfCurrent`).
   */
  beginSelect(sessionId: number): number {
    this.clientSession = sessionId;
    return ++this.sessionSelectToken;
  }

  /** True while `token` still owns the optimistic pointer — i.e. no newer
   *  select/jump has superseded it. */
  isCurrentSelect(token: number): boolean {
    return token === this.sessionSelectToken;
  }

  /**
   * Revert the optimistic pointer to null, but only if `token` still owns
   * it. [LAW:no-silent-failure] A switch that never landed must not leave
   * `activeSessionId` pointing at a session tmux never activated; a stale
   * rejection must not clobber a newer switch's value.
   */
  revertSelectIfCurrent(token: number): void {
    if (token === this.sessionSelectToken) this.clientSession = null;
  }

  /**
   * Replace one named subscription's latest value and rebuild the tree.
   * Unknown names are ignored. This is the steady-state model builder;
   * `%subscription-changed` and the connect-time snapshots both flow here.
   */
  applySnapshot(name: string, value: string): void {
    if (name === SESSIONS_SUB) {
      this.latestSessions = value;
    } else if (name === WINDOWS_SUB) {
      this.latestWindows = value;
    } else if (name === PANES_SUB) {
      this.latestPanes = value;
    } else {
      return; // unknown subscription name — ignore
    }
    this.rebuild();
  }

  /**
   * Fast-path merge: replace this session's window and pane rows in the
   * latest snapshot strings with freshly-listed ones, then rebuild. Feeding
   * the merge back through the same snapshot pipeline (rather than patching
   * `sessions` directly) keeps the model shape consistent — the tree stays a
   * pure function of the three strings. [LAW:single-enforcer]
   */
  mergeSession(
    sessionId: number,
    windowRows: readonly string[],
    paneRows: readonly string[],
  ): void {
    if (this.latestWindows !== null) {
      this.latestWindows = mergeSessionRows(
        this.latestWindows,
        sessionId,
        windowRows,
        /* sidFieldIndex */ 0,
      );
    }
    if (this.latestPanes !== null) {
      // Pane rows from the fast-path don't carry session_id, but all panes
      // returned here belong to `sessionId`'s windows. Replace rows whose
      // window_id appears in the fresh window rows (field 1 = window_id).
      const freshWindowIds = new Set(
        windowRows
          .map((line) => line.split("|")[1])
          .filter((s) => s.length > 0),
      );
      this.latestPanes = mergePaneRowsByWindow(
        this.latestPanes,
        freshWindowIds,
        paneRows,
      );
    }
    this.rebuild();
  }

  /**
   * Apply a targeted pane-geometry update in place. Reassigns `sessions` to a
   * new tree with new pane objects for any updated pane so MobX observers
   * that depend on `sessions` re-run. [LAW:dataflow-not-control-flow]
   */
  applyPaneDimensions(updates: ReadonlyMap<number, PaneDimensions>): void {
    if (updates.size === 0) return;
    this.sessions = this.sessions.map((s) => ({
      ...s,
      windows: s.windows.map((win) => ({
        ...win,
        panes: win.panes.map((p) => {
          const u = updates.get(p.id);
          return u !== undefined ? { ...p, width: u.w, height: u.h } : p;
        }),
      })),
    }));
  }

  /**
   * Drop all cached topology so PaneView unmounts its stale cells. Called
   * before a socket swap (not a transient reconnect) so React remounts fresh
   * PaneCells against the new socket on reconnect.
   */
  clearTopology(): void {
    this.latestSessions = null;
    this.latestWindows = null;
    this.latestPanes = null;
    this.sessions = [];
    this.clientSession = null;
    // [LAW:no-ambient-temporal-coupling] A socket swap is a hard teardown:
    // advance the token so any optimistic select still in flight on the OLD
    // connection can't land its revert on the NEW connection's bootstrap. Its
    // stale `revertSelectIfCurrent(oldToken)` becomes a no-op.
    this.sessionSelectToken++;
  }

  private rebuild(): void {
    // If any subscription hasn't arrived yet, leave the model empty.
    if (
      this.latestSessions === null ||
      this.latestWindows === null ||
      this.latestPanes === null
    ) {
      return;
    }
    this.sessions = buildSessionTree(
      this.latestSessions,
      this.latestWindows,
      this.latestPanes,
    );
    // [LAW:one-source-of-truth] No active-id reconciliation here. Active
    // pointers are computed from `session.attached` / `window.active` on
    // each access — they can never be out of sync with the tree.
  }

  // -------------------------------------------------------------------------
  // Derived state
  // -------------------------------------------------------------------------

  // Priority order:
  //   1. `clientSessionId` — set when %client-session-changed fires for
  //      our -CC control client. This is the only per-client state tmux
  //      doesn't deliver via subscriptions.
  //   2. First session with `attached === true`.
  //   3. First session (visibility fallback immediately after connect).
  get activeSessionId(): number | null {
    if (this.clientSession !== null) {
      const exists = this.sessions.some((s) => s.id === this.clientSession);
      if (exists) return this.clientSession;
    }
    const attached = this.sessions.find((s) => s.attached);
    if (attached !== undefined) return attached.id;
    return this.sessions[0]?.id ?? null;
  }

  get currentSession(): SessionInfo | null {
    const id = this.activeSessionId;
    if (id === null) return null;
    return this.sessions.find((s) => s.id === id) ?? null;
  }

  get activeWindowId(): number | null {
    const s = this.currentSession;
    if (s === null) return null;
    const active = s.windows.find((w) => w.active);
    if (active !== undefined) return active.id;
    return s.windows[0]?.id ?? null;
  }

  get currentWindow(): WindowInfo | null {
    const s = this.currentSession;
    const id = this.activeWindowId;
    if (s === null || id === null) return null;
    return s.windows.find((w) => w.id === id) ?? null;
  }

  /**
   * Map of pane id → human-readable label like "cc-dump:1.0". Computed from
   * the current model; used by the debug panel to render pane events.
   */
  get paneLabels(): Map<number, string> {
    const m = new Map<number, string>();
    for (const s of this.sessions) {
      for (const w of s.windows) {
        for (const p of w.panes) {
          m.set(p.id, `${s.name}:${w.index}.${p.index}`);
        }
      }
    }
    return m;
  }
}

export type { PaneInfo, SessionInfo, WindowInfo };
