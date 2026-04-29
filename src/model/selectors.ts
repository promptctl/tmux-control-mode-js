// src/model/selectors.ts
// Pure selectors over a TmuxSnapshot.
//
// [LAW:one-source-of-truth] These functions are the canonical "active id"
// derivations. The TmuxModel class exposes instance methods of the same
// names; both delegate to these functions so the two paths cannot drift.
//
// [LAW:dataflow-not-control-flow] Active state is read from the tree on
// every call. There is no cached "currentSession" field on the snapshot —
// `session.attached` and `window.active` ARE the truth, and selectors
// recompute from them. A stale-cache class of bug is impossible here.

import type {
  PaneSnapshot,
  SessionSnapshot,
  TmuxSnapshot,
  WindowSnapshot,
} from "./types.js";

/**
 * Resolution order for the active session id:
 *   1. `clientSessionId` — set by `%client-session-changed` for our control
 *      client. The only per-client signal that subscriptions cannot deliver.
 *   2. First session whose `attached` flag is true. Useful before the
 *      `%client-session-changed` event arrives or for non-control clients.
 *   3. First session in the snapshot. Visibility fallback so the UI never
 *      renders nothing if a snapshot is non-empty.
 */
export function activeSessionId(s: TmuxSnapshot): number | null {
  if (s.clientSessionId !== null) {
    const exists = s.sessions.some((x) => x.id === s.clientSessionId);
    if (exists) return s.clientSessionId;
  }
  const attached = s.sessions.find((x) => x.attached);
  if (attached !== undefined) return attached.id;
  return s.sessions[0]?.id ?? null;
}

export function currentSession(s: TmuxSnapshot): SessionSnapshot | null {
  const id = activeSessionId(s);
  if (id === null) return null;
  return s.sessions.find((x) => x.id === id) ?? null;
}

export function activeWindowId(s: TmuxSnapshot): number | null {
  const sess = currentSession(s);
  if (sess === null) return null;
  const active = sess.windows.find((w) => w.active);
  if (active !== undefined) return active.id;
  return sess.windows[0]?.id ?? null;
}

export function currentWindow(s: TmuxSnapshot): WindowSnapshot | null {
  const sess = currentSession(s);
  const id = activeWindowId(s);
  if (sess === null || id === null) return null;
  return sess.windows.find((w) => w.id === id) ?? null;
}

export function activePaneId(s: TmuxSnapshot): number | null {
  const win = currentWindow(s);
  if (win === null) return null;
  const active = win.panes.find((p) => p.active);
  if (active !== undefined) return active.id;
  return win.panes[0]?.id ?? null;
}

/**
 * Map of pane id → "session_name:window_index.pane_index" label. Useful
 * for inspector/debug UIs that render pane events (which carry a numeric
 * pane id) with a human-readable handle.
 *
 * [LAW:dataflow-not-control-flow] Built unconditionally from the snapshot;
 * empty input yields an empty map without any branching.
 */
export function paneLabels(s: TmuxSnapshot): Map<number, string> {
  const m = new Map<number, string>();
  for (const sess of s.sessions) {
    for (const win of sess.windows) {
      for (const pane of win.panes) {
        m.set(pane.id, `${sess.name}:${win.index}.${pane.index}`);
      }
    }
  }
  return m;
}

/**
 * Walk the tree and return the pane snapshot for a given numeric id, or
 * null. Convenience for consumers correlating events (which carry numeric
 * `paneId`) with topology metadata.
 */
export function findPane(
  s: TmuxSnapshot,
  paneId: number,
): PaneSnapshot | null {
  for (const sess of s.sessions) {
    for (const win of sess.windows) {
      for (const pane of win.panes) {
        if (pane.id === paneId) return pane;
      }
    }
  }
  return null;
}
