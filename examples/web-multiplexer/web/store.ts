// examples/web-multiplexer/web/store.ts
//
// DemoStore — reactive tmux model driven entirely by tmux subscriptions
// (SPEC §14: refresh-client -B). No polling. No explicit refresh calls.
//
// Design:
//   - On bridge ready, we install three format subscriptions:
//       "sessions" → one record per session
//       "windows"  → one record per (session × window)
//       "panes"    → one record per (session × window × pane)
//     Each uses tmux's nested loop syntax (`#{S:...}`, `#{W:...}`, `#{P:...}`)
//     so a single subscription emits the full collection of that entity.
//
//   - tmux pushes %subscription-changed events whenever the data changes,
//     rate-limited to once per second per subscription. The store handles
//     each event by re-parsing the delivered value and replacing the
//     corresponding observable collection. MobX observers re-render.
//
//   - Pane output (%output, %extended-output) is unrelated to subscriptions;
//     the PaneView component subscribes to those events directly.
//
// This is the canonical reactive pattern for a tmux control-mode consumer:
// zero polling, zero explicit queries after startup, the UI is a pure
// function of tmux's pushed state.

import { makeAutoObservable, runInAction } from "mobx";
import { BridgeClient } from "./ws-client.ts";
import type { SerializedTmuxMessage } from "../shared/protocol.ts";

export interface PaneInfo {
  id: number;
  index: number;
  active: boolean;
  title: string;
}

export interface WindowInfo {
  id: number;
  index: number;
  name: string;
  active: boolean;
  panes: PaneInfo[];
}

export interface SessionInfo {
  id: number;
  name: string;
  attached: boolean;
  windows: WindowInfo[];
}

type ConnState = "connecting" | "open" | "ready" | "closed";

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

const SESSIONS_FORMAT =
  "'#{S:#{session_id}|#{session_name}|#{session_attached}\\n}'";

const WINDOWS_FORMAT =
  "'#{S:#{W:#{session_id}|#{window_id}|#{window_index}|#{window_name}|#{window_active}\\n}}'";

const PANES_FORMAT =
  "'#{S:#{W:#{P:#{window_id}|#{pane_id}|#{pane_index}|#{pane_active}|#{pane_title}\\n}}}'";

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function stripPrefix(raw: string): number {
  return parseInt(raw.replace(/^[$@%]/, ""), 10);
}

function parseRecords(
  value: string,
  keys: readonly string[],
): Array<Record<string, string>> {
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

// ---------------------------------------------------------------------------
// DemoStore
// ---------------------------------------------------------------------------

export class DemoStore {
  connState: ConnState = "connecting";
  sessions: SessionInfo[] = [];
  activeSessionId: number | null = null;
  activeWindowId: number | null = null;
  events: SerializedTmuxMessage[] = [];
  errors: string[] = [];

  readonly client: BridgeClient;

  // Raw latest subscription values, kept as observable fields so the
  // assembled `sessions` collection can be rebuilt lazily in one place.
  private latestSessions: string | null = null;
  private latestWindows: string | null = null;
  private latestPanes: string | null = null;

  constructor(client: BridgeClient) {
    this.client = client;
    makeAutoObservable(this, { client: false });
  }

  connect(url: string): void {
    this.client.onState((s) => runInAction(() => this.onStateChange(s)));
    this.client.onError((m) => runInAction(() => this.pushError(m)));
    this.client.onEvent((ev) => runInAction(() => this.handleEvent(ev)));
    this.client.connect(url);
  }

  // -------------------------------------------------------------------------
  // Connection lifecycle
  // -------------------------------------------------------------------------

  private onStateChange(s: ConnState): void {
    this.connState = s;
    if (s === "ready") {
      this.installSubscriptions();
    }
  }

  /**
   * Install the three tmux subscriptions that drive the entire model.
   * tmux pushes `%subscription-changed` events whenever the data changes,
   * so there is no need to ever poll after this.
   */
  private async installSubscriptions(): Promise<void> {
    try {
      await Promise.all([
        this.client.execute(`refresh-client -B sessions::${SESSIONS_FORMAT}`),
        this.client.execute(`refresh-client -B windows::${WINDOWS_FORMAT}`),
        this.client.execute(`refresh-client -B panes::${PANES_FORMAT}`),
      ]);
    } catch (err) {
      runInAction(() =>
        this.pushError(
          `subscribe failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }
  }

  // -------------------------------------------------------------------------
  // Event handling
  // -------------------------------------------------------------------------

  private handleEvent(ev: SerializedTmuxMessage): void {
    this.pushEvent(ev);
    if (ev.type === "subscription-changed") {
      this.applySubscription(ev.name, ev.value);
    }
    // All other events (%window-*, %session-*, %output, etc.) are purely
    // informational here — the subscriptions already drive the model.
    // The debug panel still shows them for visibility.
  }

  private applySubscription(name: string, value: string): void {
    if (name === "sessions") {
      this.latestSessions = value;
    } else if (name === "windows") {
      this.latestWindows = value;
    } else if (name === "panes") {
      this.latestPanes = value;
    } else {
      return; // unknown subscription name — ignore
    }
    this.rebuildModel();
  }

  /**
   * Rebuild the session/window/pane tree from the latest three subscription
   * values. Called whenever any of them changes. This is a pure function of
   * the three strings; the UI updates automatically via MobX.
   */
  private rebuildModel(): void {
    // If any subscription hasn't arrived yet, leave the model empty.
    if (
      this.latestSessions === null ||
      this.latestWindows === null ||
      this.latestPanes === null
    ) {
      return;
    }

    const sessionRows = parseRecords(this.latestSessions, ["sid", "name", "attached"]);
    const windowRows = parseRecords(this.latestWindows, [
      "sid",
      "wid",
      "idx",
      "name",
      "active",
    ]);
    const paneRows = parseRecords(this.latestPanes, [
      "wid",
      "pid",
      "idx",
      "active",
      "title",
    ]);

    const panesByWindow = new Map<string, PaneInfo[]>();
    for (const p of paneRows) {
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
    for (const w of windowRows) {
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

    const built: SessionInfo[] = sessionRows.map((s) => ({
      id: stripPrefix(s.sid),
      name: s.name,
      attached: s.attached !== "0" && s.attached !== "",
      windows: (windowsBySession.get(s.sid) ?? []).sort(
        (a, b) => a.index - b.index,
      ),
    }));

    this.sessions = built;

    // Reconcile UI focus with the new model.
    const stillExists =
      this.activeSessionId !== null &&
      built.some((s) => s.id === this.activeSessionId);
    if (!stillExists) {
      const attached = built.find((s) => s.attached) ?? built[0];
      this.activeSessionId = attached?.id ?? null;
    }

    const currentSession = built.find((s) => s.id === this.activeSessionId);
    if (currentSession !== undefined) {
      const stillExistsW =
        this.activeWindowId !== null &&
        currentSession.windows.some((w) => w.id === this.activeWindowId);
      if (!stillExistsW) {
        this.activeWindowId =
          currentSession.windows.find((w) => w.active)?.id ??
          currentSession.windows[0]?.id ??
          null;
      }
    } else {
      this.activeWindowId = null;
    }
  }

  private pushEvent(ev: SerializedTmuxMessage): void {
    this.events = [ev, ...this.events].slice(0, 200);
  }

  private pushError(m: string): void {
    const stamp = new Date().toLocaleTimeString();
    this.errors = [`${stamp} — ${m}`, ...this.errors].slice(0, 50);
  }

  // -------------------------------------------------------------------------
  // UI actions
  // -------------------------------------------------------------------------

  selectSession(id: number): void {
    this.activeSessionId = id;
    // Tell the control client to follow the UI's focus so session-scoped
    // notifications arrive for the session the user is looking at.
    // Session id `$N` is accepted directly by `switch-client -t`.
    void this.client.execute(`switch-client -t \\$${id}`);
  }

  selectWindow(id: number): void {
    this.activeWindowId = id;
    const s = this.currentSession;
    const w = s?.windows.find((x) => x.id === id);
    if (s !== null && w !== undefined) {
      void this.client.execute(`select-window -t ${s.name}:${w.index}`);
    }
  }

  selectPane(pane: PaneInfo): void {
    const s = this.currentSession;
    const w = this.currentWindow;
    if (s !== null && w !== null) {
      void this.client.execute(
        `select-pane -t ${s.name}:${w.index}.${pane.index}`,
      );
    }
  }

  sendKeysToPane(paneId: number, data: string): void {
    void this.client.sendKeys(`%${paneId}`, data);
  }

  // -------------------------------------------------------------------------
  // Derived state
  // -------------------------------------------------------------------------

  get currentSession(): SessionInfo | null {
    return this.sessions.find((s) => s.id === this.activeSessionId) ?? null;
  }

  get currentWindow(): WindowInfo | null {
    return (
      this.currentSession?.windows.find((w) => w.id === this.activeWindowId) ??
      null
    );
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

  get statusColor(): string {
    return this.connState === "ready"
      ? "teal"
      : this.connState === "open"
      ? "yellow"
      : this.connState === "closed"
      ? "red"
      : "gray";
  }
}
