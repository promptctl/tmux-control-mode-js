// examples/web-multiplexer/web/snapshot-codec.ts
//
// Pure wire↔tree codec for the tmux subscription model.
//
// The demo drives its entire model from three tmux format subscriptions
// (SPEC §14: refresh-client -B) whose delivered values are encoded strings.
// This module is the single translation layer between those strings and the
// assembled session/window/pane tree — strings in, one tree out. It holds no
// state, touches no client, performs no effects; every function is a pure
// transform. [LAW:effects-at-boundaries] [LAW:decomposition]
//
// [LAW:single-enforcer] The snapshot-string format (`\n`-separated,
// `|`-delimited rows) is defined here by the SESSIONS/WINDOWS/PANES_FORMAT
// constants and the parse/merge helpers below. Anything that manipulates
// these strings must go through this module so the format stays canonical.

export interface PaneInfo {
  id: number;
  index: number;
  active: boolean;
  title: string;
  width: number;
  height: number;
}

export interface WindowInfo {
  id: number;
  index: number;
  name: string;
  active: boolean;
  /**
   * True when a pane in this window has been zoomed via `resize-pane -Z`
   * (C-b z in the keymap). While zoomed, the UI renders only the active
   * pane at full size; other panes are hidden but still exist server-side.
   */
  zoomed: boolean;
  panes: PaneInfo[];
}

export interface SessionInfo {
  id: number;
  name: string;
  attached: boolean;
  windows: WindowInfo[];
}

// ---------------------------------------------------------------------------
// Subscription format strings
//
// Record separator: literal 2-char `\n` (tmux preserves my backslash-n as-is
// in the delivered value, so I split on the 2-char sequence in JS).
// Field separator: `|`.
//
// Known limitation: if a session/window/pane name contains the literal
// 2-char sequence `\n` OR the character `|`, parsing will be wrong for that
// record. For a canonical demo against a reasonable tmux server this is
// fine; production consumers should pick unambiguous separators or use
// length-prefixed encoding.
// ---------------------------------------------------------------------------

export const SESSIONS_FORMAT =
  "'#{S:#{session_id}|#{session_name}|#{session_attached}\\n}'";

export const WINDOWS_FORMAT =
  "'#{S:#{W:#{session_id}|#{window_id}|#{window_index}|#{window_name}|#{window_active}|#{window_zoomed_flag}\\n}}'";

export const PANES_FORMAT =
  "'#{S:#{W:#{P:#{window_id}|#{pane_id}|#{pane_index}|#{pane_active}|#{pane_width}|#{pane_height}|#{pane_title}\\n}}}'";

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function stripPrefix(raw: string): number {
  return parseInt(raw.replace(/^[$@%]/, ""), 10);
}

function parseRecords(
  value: string,
  keys: readonly string[],
): Record<string, string>[] {
  return value
    .split("\\n") // literal 2-char backslash-n (tmux preserves it)
    .filter((l) => l.length > 0)
    .map((line) => {
      const parts = line.split("|");
      const row: Record<string, string> = {};
      keys.forEach((k, i) => {
        row[k] = parts[i] ?? "";
      });
      return row;
    });
}

export function encodeSnapshotLines(lines: readonly string[]): string {
  return lines.join("\\n");
}

/**
 * Replace all rows for a given session_id in an encoded snapshot string
 * with fresh ones. Used by the fast-path refresh to swap in the current
 * state of one session without discarding the others.
 */
export function mergeSessionRows(
  existing: string,
  sessionId: number,
  freshRows: readonly string[],
  sidFieldIndex: number,
): string {
  const sidValue = `$${sessionId}`;
  const oldRows = existing
    .split("\\n")
    .filter((l) => l.length > 0 && l.split("|")[sidFieldIndex] !== sidValue);
  const combined = [...oldRows, ...freshRows];
  return encodeSnapshotLines(combined);
}

/**
 * Replace all pane rows whose window_id is in the given set with fresh
 * ones. Used alongside mergeSessionRows — panes don't carry session_id in
 * our format, so we match by window.
 */
export function mergePaneRowsByWindow(
  existing: string,
  freshWindowIds: ReadonlySet<string>,
  freshRows: readonly string[],
): string {
  const oldRows = existing
    .split("\\n")
    .filter((l) => l.length > 0 && !freshWindowIds.has(l.split("|")[0]));
  return encodeSnapshotLines([...oldRows, ...freshRows]);
}

/**
 * Assemble the session/window/pane tree from the three latest subscription
 * values. Pure function of the three strings — the same inputs always
 * produce the same tree, so callers can rebuild eagerly on any change.
 * Windows are sorted by index; active pointers are NOT resolved here (they
 * are computed from `session.attached` / `window.active` / `pane.active`,
 * which travel in the tree itself).
 */
export function buildSessionTree(
  sessionsValue: string,
  windowsValue: string,
  panesValue: string,
): SessionInfo[] {
  const sessionRows = parseRecords(sessionsValue, ["sid", "name", "attached"]);
  const windowRows = parseRecords(windowsValue, [
    "sid",
    "wid",
    "idx",
    "name",
    "active",
    "zoomed",
  ]);
  const paneRows = parseRecords(panesValue, [
    "wid",
    "pid",
    "idx",
    "active",
    "width",
    "height",
    "title",
  ]);

  const panesByWindow = new Map<string, PaneInfo[]>();
  for (const p of paneRows) {
    const list = panesByWindow.get(p.wid) ?? [];
    list.push({
      id: stripPrefix(p.pid),
      index: parseInt(p.idx, 10),
      active: p.active === "1",
      width: parseInt(p.width, 10) || 80,
      height: parseInt(p.height, 10) || 24,
      title: p.title,
    });
    panesByWindow.set(p.wid, list);
  }

  const windowsBySession = new Map<string, WindowInfo[]>();
  for (const w of windowRows) {
    const list = windowsBySession.get(w.sid) ?? [];
    list.push({
      id: stripPrefix(w.wid),
      index: parseInt(w.idx, 10),
      name: w.name,
      active: w.active === "1",
      zoomed: w.zoomed === "1",
      panes: panesByWindow.get(w.wid) ?? [],
    });
    windowsBySession.set(w.sid, list);
  }

  return sessionRows.map((s) => ({
    id: stripPrefix(s.sid),
    name: s.name,
    attached: s.attached !== "0" && s.attached !== "",
    windows: (windowsBySession.get(s.sid) ?? []).sort(
      (a, b) => a.index - b.index,
    ),
  }));
}
