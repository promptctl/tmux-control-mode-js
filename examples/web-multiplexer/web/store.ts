// examples/web-multiplexer/web/store.ts
// MobX store for the demo. One store, observable, consumes a BridgeClient
// and exposes the session/window/pane model + UI selection state.
//
// Components are `observer()` wrapped; they read store fields directly and
// re-render automatically when MobX observes the mutation.

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

const STRUCTURAL_EVENTS = new Set<string>([
  "window-add",
  "window-close",
  "window-renamed",
  "window-pane-changed",
  "unlinked-window-add",
  "unlinked-window-close",
  "unlinked-window-renamed",
  "session-changed",
  "session-renamed",
  "sessions-changed",
  "session-window-changed",
  "layout-change",
]);

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
  return parseInt(raw.replace(/^[$@%]/, ""), 10);
}

/**
 * Single observable store for the whole demo. Components read from this
 * store via `observer()` and never subscribe to the BridgeClient directly.
 */
export class DemoStore {
  connState: ConnState = "connecting";
  sessions: SessionInfo[] = [];
  activeSessionId: number | null = null;
  activeWindowId: number | null = null;
  events: SerializedTmuxMessage[] = [];
  errors: string[] = [];

  readonly client: BridgeClient;

  constructor(client: BridgeClient) {
    this.client = client;
    makeAutoObservable(this, { client: false });
  }

  /** Wire the store to the BridgeClient and open the connection. */
  connect(url: string): void {
    this.client.onState((s) => runInAction(() => this.onStateChange(s)));
    this.client.onError((m) => runInAction(() => this.pushError(m)));
    this.client.onEvent((ev) => {
      runInAction(() => this.pushEvent(ev));
      // Structural events trigger a snapshot refresh. Don't put this inside
      // runInAction because refresh is async.
      if (STRUCTURAL_EVENTS.has(ev.type)) {
        void this.refresh();
      }
    });
    this.client.connect(url);
  }

  private onStateChange(s: ConnState): void {
    this.connState = s;
    if (s === "ready") {
      void this.refresh();
    }
  }

  private pushEvent(ev: SerializedTmuxMessage): void {
    this.events = [ev, ...this.events].slice(0, 200);
  }

  private pushError(m: string): void {
    const stamp = new Date().toLocaleTimeString();
    this.errors = [`${stamp} — ${m}`, ...this.errors].slice(0, 50);
  }

  /** Re-query tmux state and rebuild the session/window/pane model. */
  async refresh(): Promise<void> {
    try {
      const [sessionsR, windowsR, panesR] = await Promise.all([
        this.client.execute(
          "list-sessions -F '#{session_id}|#{session_name}|#{session_attached}'",
        ),
        this.client.execute(
          "list-windows -a -F '#{session_id}|#{window_id}|#{window_index}|#{window_name}|#{window_active}'",
        ),
        this.client.execute(
          "list-panes -a -F '#{window_id}|#{pane_id}|#{pane_index}|#{pane_active}|#{pane_title}'",
        ),
      ]);

      console.log("[snapshot] sessions:", sessionsR.success, sessionsR.output.length);
      console.log("[snapshot] windows:", windowsR.success, windowsR.output.length);
      console.log("[snapshot] panes:", panesR.success, panesR.output.length);

      if (!sessionsR.success || !windowsR.success || !panesR.success) {
        const first = [sessionsR, windowsR, panesR].find((r) => !r.success);
        throw new Error(
          `tmux query failed: ${first?.output.join(" ") ?? "(no detail)"}`,
        );
      }

      const sessionRows = parseLines(sessionsR.output, ["sid", "name", "attached"]);
      const windowRows = parseLines(windowsR.output, [
        "sid",
        "wid",
        "idx",
        "name",
        "active",
      ]);
      const paneRows = parseLines(panesR.output, [
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

      console.log("[snapshot] built", built.length, "sessions");

      runInAction(() => {
        this.sessions = built;

        // Keep or initialize activeSessionId
        const stillExists =
          this.activeSessionId !== null &&
          built.some((s) => s.id === this.activeSessionId);
        if (!stillExists) {
          const attached = built.find((s) => s.attached) ?? built[0];
          this.activeSessionId = attached?.id ?? null;
        }

        // Keep or initialize activeWindowId
        const currentSession = built.find(
          (s) => s.id === this.activeSessionId,
        );
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
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[snapshot] failed:", err);
      runInAction(() => this.pushError(`snapshot failed: ${msg}`));
    }
  }

  // -------------------------------------------------------------------------
  // UI actions
  // -------------------------------------------------------------------------

  selectSession(id: number): void {
    this.activeSessionId = id;
    // Tell the control client to follow the UI's focus so notifications
    // arrive for the session the user is looking at.
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

  get currentSession(): SessionInfo | null {
    return this.sessions.find((s) => s.id === this.activeSessionId) ?? null;
  }

  get currentWindow(): WindowInfo | null {
    return this.currentSession?.windows.find((w) => w.id === this.activeWindowId) ?? null;
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
