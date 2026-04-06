// examples/web-multiplexer/web/state.ts
// Derive the session/window/pane display model by querying tmux directly.
// Events from tmux (%window-add, %window-close, etc.) trigger a re-query.
//
// This is simpler and more reliable than trying to maintain a local model
// by applying event deltas — tmux's own list-sessions / list-windows /
// list-panes is the source of truth.

import type { BridgeClient } from "./ws-client.ts";

export interface PaneInfo {
  readonly id: number; // numeric pane id (%N → N)
  readonly index: number; // pane index within window
  readonly active: boolean;
  readonly title: string;
}

export interface WindowInfo {
  readonly id: number; // numeric window id (@N → N)
  readonly index: number; // window index within session
  readonly name: string;
  readonly active: boolean;
  readonly panes: readonly PaneInfo[];
}

export interface SessionInfo {
  readonly id: number; // numeric session id ($N → N)
  readonly name: string;
  readonly attached: boolean;
  readonly windows: readonly WindowInfo[];
}

/**
 * Parse a delimited-line format from tmux `-F` output.
 * Expects each line like `field1|field2|field3`.
 */
function parseLines(
  output: readonly string[],
  keys: readonly string[],
): Array<Record<string, string>> {
  return output
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

function stripPrefix(raw: string): number {
  // Handles "$3", "@1", "%7" → 3, 1, 7
  return parseInt(raw.replace(/^[$@%]/, ""), 10);
}

export async function loadSnapshot(client: BridgeClient): Promise<SessionInfo[]> {
  // Format strings MUST be single-quoted — without quotes, tmux's command
  // parser chokes on `#{...}` and treats `-F` as having no argument.
  const sessionsR = await client.execute(
    "list-sessions -F '#{session_id}|#{session_name}|#{session_attached}'",
  );
  const windowsR = await client.execute(
    "list-windows -a -F '#{session_id}|#{window_id}|#{window_index}|#{window_name}|#{window_active}'",
  );
  const panesR = await client.execute(
    "list-panes -a -F '#{window_id}|#{pane_id}|#{pane_index}|#{pane_active}|#{pane_title}'",
  );

  if (!sessionsR.success || !windowsR.success || !panesR.success) {
    throw new Error("failed to query tmux state");
  }

  const sessions = parseLines(sessionsR.output, ["sid", "name", "attached"]);
  const windows = parseLines(windowsR.output, [
    "sid",
    "wid",
    "idx",
    "name",
    "active",
  ]);
  const panes = parseLines(panesR.output, ["wid", "pid", "idx", "active", "title"]);

  const panesByWindow = new Map<string, PaneInfo[]>();
  for (const p of panes) {
    const list = panesByWindow.get(p.wid) ?? [];
    list.push({
      id: stripPrefix(p.pid),
      index: parseInt(p.idx, 10),
      active: p.active === "1",
      title: p.title,
    });
    panesByWindow.set(p.wid, list);
  }

  const windowsBySession = new Map<string, WindowInfo[]>();
  for (const w of windows) {
    const list = windowsBySession.get(w.sid) ?? [];
    list.push({
      id: stripPrefix(w.wid),
      index: parseInt(w.idx, 10),
      name: w.name,
      active: w.active === "1",
      panes: panesByWindow.get(w.wid) ?? [],
    });
    windowsBySession.set(w.sid, list);
  }

  return sessions.map((s) => ({
    id: stripPrefix(s.sid),
    name: s.name,
    attached: s.attached !== "0" && s.attached !== "",
    windows: (windowsBySession.get(s.sid) ?? []).sort((a, b) => a.index - b.index),
  }));
}
