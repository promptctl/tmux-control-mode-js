// The snapshot model and the one parser that turns raw `tmux list-panes -a`
// output into it. Pure: no I/O, so it is testable with a string.

// [LAW:one-source-of-truth] The format string is derived from FIELDS, so a parsed
// row can never disagree with what was asked of tmux.
const FIELDS = [
  'session_id',
  'session_name',
  'session_group',
  'session_attached',
  'session_created',
  'window_id',
  'window_index',
  'window_name',
  'window_layout',
  'window_active',
  'pane_id',
  'pane_width',
  'pane_height',
  'pane_pid',
  'pane_current_command',
  'pane_current_path',
  'pane_title',
  'history_size',
  'alternate_on',
] as const;

type Field = (typeof FIELDS)[number];
type Row = Record<Field, string>;

export const PANE_ROWS_FORMAT = FIELDS.map((f) => `#{${f}}`).join('\t');

export type CaptureResult =
  | { readonly ok: true; readonly bytes: number; readonly lines: number }
  | { readonly ok: false; readonly error: string };

export interface PaneRecord {
  readonly id: string; // "%12"
  readonly windowId: string;
  readonly cwd: string;
  readonly command: string;
  readonly pid: number;
  readonly title: string;
  readonly width: number;
  readonly height: number;
  /** Lines of scrollback tmux reported above the visible screen. */
  readonly historyLines: number;
  /** True when the pane was on the alternate screen (vim, less, ...). */
  readonly alternateScreen: boolean;
  readonly capture: CaptureResult;
}

export interface WindowRecord {
  readonly id: string; // "@3"
  readonly name: string;
  readonly layout: string;
  readonly paneIds: readonly string[];
}

export interface SessionRecord {
  readonly id: string; // "$7"
  readonly name: string;
  /** Sessions in one group share the same windows. */
  readonly group: string | null;
  readonly attached: boolean;
  readonly createdAt: number; // unix seconds
  readonly windows: readonly {
    readonly index: number;
    readonly windowId: string;
    readonly active: boolean;
  }[];
}

export interface Snapshot {
  readonly version: 1;
  readonly id: string;
  readonly takenAt: string; // ISO-8601
  readonly tmuxVersion: string;
  readonly sessions: readonly SessionRecord[];
  readonly windows: readonly WindowRecord[];
  readonly panes: readonly PaneRecord[];
}

/** A server's shape before any pane has been captured. */
export interface Topology {
  readonly sessions: readonly SessionRecord[];
  readonly windows: readonly WindowRecord[];
  readonly panes: readonly Omit<PaneRecord, 'capture'>[];
}

function int(row: Row, field: Field): number {
  const n = Number(row[field]);
  if (!Number.isInteger(n)) {
    throw new Error(`tmux field ${field} is not an integer: ${JSON.stringify(row[field])}`);
  }
  return n;
}

// [LAW:parse-dont-validate] The single crossing from tmux text to typed rows.
// A wrong field count means tmux's output shape changed; fail rather than shift columns.
function parseRows(stdout: string): Row[] {
  return stdout
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const cells = line.split('\t');
      if (cells.length !== FIELDS.length) {
        throw new Error(
          `expected ${FIELDS.length} tab-separated fields from tmux, got ${cells.length}: ${JSON.stringify(line)}`,
        );
      }
      return Object.fromEntries(FIELDS.map((f, i) => [f, cells[i]])) as Row;
    });
}

/**
 * Collapse the (session x window x pane) rows into a topology. Grouped sessions
 * repeat the same windows and panes once per session, so windows and panes are
 * deduplicated by their tmux id while each session keeps its own window list.
 */
export function parseTopology(stdout: string): Topology {
  const sessions = new Map<
    string,
    { rec: Omit<SessionRecord, 'windows'>; windows: Map<string, SessionRecord['windows'][number]> }
  >();
  const windows = new Map<string, { id: string; name: string; layout: string; paneIds: string[] }>();
  const panes = new Map<string, Omit<PaneRecord, 'capture'>>();

  for (const row of parseRows(stdout)) {
    let session = sessions.get(row.session_id);
    if (session === undefined) {
      session = {
        rec: {
          id: row.session_id,
          name: row.session_name,
          group: row.session_group === '' ? null : row.session_group,
          attached: int(row, 'session_attached') > 0,
          createdAt: int(row, 'session_created'),
        },
        windows: new Map(),
      };
      sessions.set(row.session_id, session);
    }
    session.windows.set(row.window_id, {
      index: int(row, 'window_index'),
      windowId: row.window_id,
      active: row.window_active === '1',
    });

    let window = windows.get(row.window_id);
    if (window === undefined) {
      window = { id: row.window_id, name: row.window_name, layout: row.window_layout, paneIds: [] };
      windows.set(row.window_id, window);
    }
    if (!panes.has(row.pane_id)) {
      window.paneIds.push(row.pane_id);
      panes.set(row.pane_id, {
        id: row.pane_id,
        windowId: row.window_id,
        cwd: row.pane_current_path,
        command: row.pane_current_command,
        pid: int(row, 'pane_pid'),
        title: row.pane_title,
        width: int(row, 'pane_width'),
        height: int(row, 'pane_height'),
        historyLines: int(row, 'history_size'),
        alternateScreen: row.alternate_on === '1',
      });
    }
  }

  return {
    sessions: [...sessions.values()].map((s) => ({
      ...s.rec,
      windows: [...s.windows.values()].sort((a, b) => a.index - b.index),
    })),
    windows: [...windows.values()],
    panes: [...panes.values()],
  };
}

/** "%12" -> "12": the pane's on-disk file stem. Rejects anything but a tmux pane id. */
export function paneFileStem(paneId: string): string {
  const m = /^%(\d+)$/.exec(paneId);
  if (m === null) throw new Error(`not a tmux pane id: ${JSON.stringify(paneId)}`);
  return m[1];
}

/** Count of lines in a capture; a trailing newline does not start a new line. */
export function countLines(text: string): number {
  if (text === '') return 0;
  return text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length;
}

/** Snapshot id: sortable, filesystem-safe UTC timestamp. */
export function snapshotId(at: Date): string {
  return at.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

export const SNAPSHOT_ID_RE = /^\d{8}T\d{6}Z$/;
