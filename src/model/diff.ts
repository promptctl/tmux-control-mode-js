// src/model/diff.ts
// Structural diff between two TmuxSnapshots.
//
// [LAW:dataflow-not-control-flow] Diff is a pure function of two snapshots.
// `prev = null` is treated as the empty-snapshot constant, so the very
// first diff naturally reports every entity as "added" without any
// "is this the first run" branch in the orchestrator.
//
// [LAW:single-enforcer] Diff lives here; consumers do not implement their
// own snapshot comparison. If a category of change is missing from the
// diff, add it here rather than diffing snapshots in the consumer.

import {
  EMPTY_SNAPSHOT,
  type PaneSnapshot,
  type RenamePayload,
  type SessionSnapshot,
  type TmuxDiff,
  type TmuxSnapshot,
  type WindowSnapshot,
} from "./types.js";

// ---------------------------------------------------------------------------
// Flatten helpers — per-tier maps keyed by id.
//
// We walk the prev/next trees once to build flat Maps; every diff category
// after that is a Map.has / equality compare. For the snapshot sizes tmux
// actually produces (≤ a few dozen panes) this is cheap; the alternative
// (recursive walk for every category) is more code without any speedup.
// ---------------------------------------------------------------------------

function flattenSessions(
  s: TmuxSnapshot,
): Map<number, SessionSnapshot> {
  const m = new Map<number, SessionSnapshot>();
  for (const sess of s.sessions) m.set(sess.id, sess);
  return m;
}

function flattenWindows(
  s: TmuxSnapshot,
): Map<number, WindowSnapshot> {
  const m = new Map<number, WindowSnapshot>();
  for (const sess of s.sessions) {
    for (const win of sess.windows) m.set(win.id, win);
  }
  return m;
}

function flattenPanes(
  s: TmuxSnapshot,
): Map<number, PaneSnapshot> {
  const m = new Map<number, PaneSnapshot>();
  for (const sess of s.sessions) {
    for (const win of sess.windows) {
      for (const pane of win.panes) m.set(pane.id, pane);
    }
  }
  return m;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function computeDiff(
  prev: TmuxSnapshot | null,
  next: TmuxSnapshot,
): TmuxDiff {
  const before = prev ?? EMPTY_SNAPSHOT;

  const prevSessions = flattenSessions(before);
  const nextSessions = flattenSessions(next);
  const prevWindows = flattenWindows(before);
  const nextWindows = flattenWindows(next);
  const prevPanes = flattenPanes(before);
  const nextPanes = flattenPanes(next);

  const sessionsAdded: number[] = [];
  const sessionsRemoved: number[] = [];
  const sessionsRenamed: RenamePayload[] = [];
  const sessionsAttachChanged: number[] = [];

  for (const [id, sess] of nextSessions) {
    const old = prevSessions.get(id);
    if (old === undefined) {
      sessionsAdded.push(id);
      continue;
    }
    if (old.name !== sess.name) {
      sessionsRenamed.push({ id, oldName: old.name, newName: sess.name });
    }
    if (old.attached !== sess.attached) sessionsAttachChanged.push(id);
  }
  for (const [id] of prevSessions) {
    if (!nextSessions.has(id)) sessionsRemoved.push(id);
  }

  const windowsAdded: number[] = [];
  const windowsRemoved: number[] = [];
  const windowsRenamed: RenamePayload[] = [];
  const windowsActiveChanged: number[] = [];
  const windowsZoomedChanged: number[] = [];

  for (const [id, win] of nextWindows) {
    const old = prevWindows.get(id);
    if (old === undefined) {
      windowsAdded.push(id);
      continue;
    }
    if (old.name !== win.name) {
      windowsRenamed.push({ id, oldName: old.name, newName: win.name });
    }
    if (old.active !== win.active) windowsActiveChanged.push(id);
    if (old.zoomed !== win.zoomed) windowsZoomedChanged.push(id);
  }
  for (const [id] of prevWindows) {
    if (!nextWindows.has(id)) windowsRemoved.push(id);
  }

  const panesAdded: number[] = [];
  const panesRemoved: number[] = [];
  const panesDimChanged: number[] = [];
  const panesTitleChanged: number[] = [];
  const panesActiveChanged: number[] = [];

  for (const [id, pane] of nextPanes) {
    const old = prevPanes.get(id);
    if (old === undefined) {
      panesAdded.push(id);
      continue;
    }
    if (old.width !== pane.width || old.height !== pane.height) {
      panesDimChanged.push(id);
    }
    if (old.title !== pane.title) panesTitleChanged.push(id);
    if (old.active !== pane.active) panesActiveChanged.push(id);
  }
  for (const [id] of prevPanes) {
    if (!nextPanes.has(id)) panesRemoved.push(id);
  }

  return {
    sessions: {
      added: sessionsAdded,
      removed: sessionsRemoved,
      renamed: sessionsRenamed,
      attachChanged: sessionsAttachChanged,
    },
    windows: {
      added: windowsAdded,
      removed: windowsRemoved,
      renamed: windowsRenamed,
      activeChanged: windowsActiveChanged,
      zoomedChanged: windowsZoomedChanged,
    },
    panes: {
      added: panesAdded,
      removed: panesRemoved,
      dimChanged: panesDimChanged,
      titleChanged: panesTitleChanged,
      activeChanged: panesActiveChanged,
    },
    clientSessionChanged: before.clientSessionId !== next.clientSessionId,
  };
}

/**
 * True when the diff carries any structural change. Useful as a guard for
 * consumers that only want to react when something actually moved.
 *
 * [LAW:dataflow-not-control-flow] The model emits `change` for every
 * snapshot regardless; this helper is for consumer-side filtering.
 */
export function isEmptyDiff(d: TmuxDiff): boolean {
  return (
    d.sessions.added.length === 0 &&
    d.sessions.removed.length === 0 &&
    d.sessions.renamed.length === 0 &&
    d.sessions.attachChanged.length === 0 &&
    d.windows.added.length === 0 &&
    d.windows.removed.length === 0 &&
    d.windows.renamed.length === 0 &&
    d.windows.activeChanged.length === 0 &&
    d.windows.zoomedChanged.length === 0 &&
    d.panes.added.length === 0 &&
    d.panes.removed.length === 0 &&
    d.panes.dimChanged.length === 0 &&
    d.panes.titleChanged.length === 0 &&
    d.panes.activeChanged.length === 0 &&
    !d.clientSessionChanged
  );
}
