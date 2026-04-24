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
import {
  INITIAL_STATE,
  defaultTmuxKeymap,
  dispatchAction,
  handleKey,
  type Action,
  type KeyEvent,
  type Keymap,
  type KeymapState,
} from "../../../src/keymap/index.js";

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
  "'#{S:#{W:#{session_id}|#{window_id}|#{window_index}|#{window_name}|#{window_active}|#{window_zoomed_flag}\\n}}'";

const PANES_FORMAT =
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

function encodeSnapshotLines(lines: readonly string[]): string {
  return lines.join("\\n");
}

/**
 * Replace all rows for a given session_id in an encoded snapshot string
 * with fresh ones. Used by the fast-path refresh to swap in the current
 * state of one session without discarding the others.
 *
 * [LAW:single-enforcer] The snapshot-string format (`\n`-separated
 * `|`-delimited rows) is defined by the SESSIONS/WINDOWS/PANES_FORMAT
 * constants above. Anything that manipulates these strings must follow
 * that format exactly.
 */
function mergeSessionRows(
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
function mergePaneRowsByWindow(
  existing: string,
  freshWindowIds: ReadonlySet<string>,
  freshRows: readonly string[],
): string {
  const oldRows = existing
    .split("\\n")
    .filter((l) => l.length > 0 && !freshWindowIds.has(l.split("|")[0]));
  return encodeSnapshotLines([...oldRows, ...freshRows]);
}

// ---------------------------------------------------------------------------
// DemoStore
// ---------------------------------------------------------------------------

export interface PendingConfirm {
  readonly action: Action;
  readonly prompt: string;
}

/**
 * Hooks the demo wires in so certain keymap actions don't dispatch to
 * tmux but instead drive the demo's own UI. Library stays out of this:
 * the library emits the semantic Action, the demo decides the policy.
 */
export interface DemoStoreHooks {
  /** Called when the keymap emits `choose-session` (C-b s). */
  readonly onChooseSession?: () => void;
}

export class DemoStore {
  connState: ConnState = "connecting";
  sessions: SessionInfo[] = [];
  events: SerializedTmuxMessage[] = [];
  errors: string[] = [];

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
  private clientSessionId: number | null = null;

  // [LAW:one-source-of-truth] `prefixActive` is the demo's UI-facing
  // projection of the keymap engine's state. The engine is the source of
  // truth; this field mirrors `engineState.mode === "prefix"` and is set
  // from exactly one place (handleKeyEvent below).
  prefixActive = false;

  // When a destructive action (kill-pane, kill-window) is dispatched, the
  // demo shows a confirm modal backed by this observable. Setting it non-
  // null opens the modal; confirming dispatches; cancelling discards.
  pendingConfirm: PendingConfirm | null = null;

  readonly client: BridgeClient;

  // [LAW:one-source-of-truth] One keymap engine per client session. The
  // engine's state (root vs. prefix) is shared across all PaneTerminal
  // instances so pressing C-b in one pane doesn't leave the others in a
  // stale mode. The demo drives the engine manually (rather than using
  // bindKeymap) so it can intercept destructive actions for confirmation
  // and tunnel the prefix-active signal into the UI.
  private readonly keymapConfig: Keymap = defaultTmuxKeymap();
  private engineState: KeymapState = INITIAL_STATE;
  private readonly hooks: DemoStoreHooks;

  // Raw latest subscription values, kept as observable fields so the
  // assembled `sessions` collection can be rebuilt lazily in one place.
  private latestSessions: string | null = null;
  private latestWindows: string | null = null;
  private latestPanes: string | null = null;

  constructor(client: BridgeClient, hooks: DemoStoreHooks = {}) {
    this.client = client;
    this.hooks = hooks;
    makeAutoObservable(this, {
      client: false,
      hooks: false,
      // engineState is a non-observable plumbing detail — the UI observes
      // `prefixActive` instead, which is set whenever the engine transitions.
      // [LAW:no-shared-mutable-globals] Even though MobX technically supports
      // observing nested objects, exposing raw engine state would create a
      // second source of truth for "is the prefix active".
    });

    // [LAW:single-enforcer] Wire BridgeClient subscribers EXACTLY ONCE in
    // the constructor (which only runs once via React's useMemo). Wiring
    // them in connect() would register a fresh handler each time React
    // StrictMode invokes the connect-effect, causing every event to fire
    // every duplicate handler — ie every event would be processed N times.
    this.client.onState((s) => runInAction(() => this.onStateChange(s)));
    this.client.onError((m) => runInAction(() => this.pushError(m)));
    this.client.onEvent((ev) => runInAction(() => this.handleEvent(ev)));
  }

  connect(url: string): void {
    // BridgeClient.connect() is itself idempotent — a second call while
    // an existing socket is OPEN/CONNECTING is a no-op.
    this.client.connect(url);
  }

  disconnect(): void {
    this.client.disconnect();
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

      // [LAW:one-source-of-truth] The live model remains driven by the
      // subscription strings. Initial list-* snapshots are encoded into that
      // same string shape and fed through the existing rebuild pipeline.
      const [sessionsResp, windowsResp, panesResp] = await Promise.all([
        this.client.execute(
          "list-sessions -F '#{session_id}|#{session_name}|#{session_attached}'",
        ),
        this.client.execute(
          "list-windows -a -F '#{session_id}|#{window_id}|#{window_index}|#{window_name}|#{window_active}|#{window_zoomed_flag}'",
        ),
        this.client.execute(
          "list-panes -a -F '#{window_id}|#{pane_id}|#{pane_index}|#{pane_active}|#{pane_width}|#{pane_height}|#{pane_title}'",
        ),
      ]);

      if (sessionsResp.success) {
        this.applySubscription("sessions", encodeSnapshotLines(sessionsResp.output));
      }
      if (windowsResp.success) {
        this.applySubscription("windows", encodeSnapshotLines(windowsResp.output));
      }
      if (panesResp.success) {
        this.applySubscription("panes", encodeSnapshotLines(panesResp.output));
      }

      // Bootstrap the "which session is OUR client attached to" field. In
      // practice tmux fires %client-session-changed on attach, but there's
      // no guarantee about timing relative to our subscriptions. Ask
      // explicitly so the UI has correct state from frame zero.
      const sessionResp = await this.client.execute(
        "display-message -p '#{session_id}'",
      );
      if (sessionResp.success && sessionResp.output[0] !== undefined) {
        const parsed = parseInt(sessionResp.output[0].replace(/^\$/, ""), 10);
        if (Number.isFinite(parsed)) {
          runInAction(() => {
            this.clientSessionId = parsed;
          });
        }
      }
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
      return;
    }
    if (ev.type === "layout-change") {
      // [LAW:dataflow-not-control-flow] The subscriptions drive the
      // steady-state model, but subscription delivery is rate-limited to
      // ~1 Hz. Pane geometry (width/height) must feel instant when a user
      // resizes their terminal, so we fast-path on %layout-change by
      // running a targeted list-panes for just that window and updating
      // dimensions in place. This is O(panes-in-one-window) and completes
      // in a few milliseconds.
      this.refreshWindowDimensions(ev.windowId);
      return;
    }
    // [LAW:one-source-of-truth] Events like session-window-changed,
    // client-session-changed, window-pane-changed are intentionally NOT
    // handled here. The subscription-fed `sessions` tree already carries
    // `session.attached`, `window.active`, `pane.active` — those flags ARE
    // the truth, and `activeSessionId`/`activeWindowId` are computed from
    // them. Subscriptions are rate-limited to ~1 Hz, so for sub-second
    // feedback after a user action we call `refreshSession` from the
    // dispatch path (see `dispatchWithConfirm` and the `select*` methods).
    // Attempting to patch these events would create parallel state.
    //
    // Structural fast-path (window created/destroyed): triggered off the
    // keymap-dispatched action too, not off this event — see
    // dispatchAndRefresh below.
    if (ev.type === "client-session-changed") {
      // The ONLY local state write triggered by an event. This tracks which
      // session OUR control client is attached to — tmux doesn't express
      // this via subscriptions.
      this.clientSessionId = ev.sessionId;
      void this.refreshSession(ev.sessionId);
      return;
    }
    if (ev.type === "session-window-changed" || ev.type === "window-pane-changed") {
      // No local writes — just kick the refresh so the subscription-fed
      // tree picks up the new active flags in a few ms instead of ~1 s.
      const sid =
        ev.type === "session-window-changed"
          ? ev.sessionId
          : this.clientSessionId;
      if (sid !== null) void this.refreshSession(sid);
      return;
    }
  }

  // -------------------------------------------------------------------------
  // Keymap integration
  //
  // The demo drives the pure keymap engine directly (see
  // tmux-control-mode-js/keymap) so it can:
  //   1. Surface the "prefix active" signal into a MobX observable the UI
  //      can render.
  //   2. Intercept destructive actions (kill-pane, kill-window) for a
  //      user-confirmation dialog before dispatching.
  //
  // [LAW:single-enforcer] dispatchAction from the library owns the single
  // canonical Action → tmux command mapping. The demo only decides WHICH
  // actions to forward and when — it never re-implements what tmux command
  // corresponds to `split` / `select-pane` / etc.
  // -------------------------------------------------------------------------

  /**
   * Called by PaneTerminal whenever xterm sees a keydown. Returns true if
   * the keymap consumed the event (caller must prevent default); false if
   * the caller should route the key to the focused pane.
   */
  handleKeyEvent(ev: KeyEvent): boolean {
    const prev = this.engineState;
    const result = handleKey(ev, prev, this.keymapConfig);
    if (result.state !== prev) {
      this.engineState = result.state;
      this.prefixActive = result.state.mode === "prefix";
    }
    for (const action of result.actions) this.dispatchWithConfirm(action);
    return result.handled;
  }

  private dispatchWithConfirm(action: Action): void {
    if (action.type === "kill-pane") {
      this.pendingConfirm = { action, prompt: "Kill this pane?" };
      return;
    }
    if (action.type === "kill-window") {
      this.pendingConfirm = {
        action,
        prompt: `Kill the current window?`,
      };
      return;
    }
    // [LAW:dataflow-not-control-flow] The demo's policy for choose-session
    // is "open the sidebar" rather than tmux's choose-tree. Intercept the
    // action, invoke the hook, swallow the dispatch.
    if (action.type === "choose-session") {
      this.hooks.onChooseSession?.();
      return;
    }
    this.dispatchAndRefresh(action);
  }

  /**
   * Dispatch an action to tmux and then fast-path a targeted refresh of
   * the current session's windows/panes. Subscriptions will catch up
   * within ~1s on their own; this just makes the UI feel snappy after a
   * user keystroke.
   *
   * [LAW:single-enforcer] This is the ONE place that pairs an action
   * dispatch with a refresh. Event handlers don't write active state; the
   * refresh call here is what pulls the post-action truth from tmux.
   */
  private dispatchAndRefresh(action: Action): void {
    dispatchAction(this.client, action);
    const sid = this.activeSessionId;
    if (sid !== null) void this.refreshSession(sid);
  }

  confirmPendingAction(): void {
    const pending = this.pendingConfirm;
    this.pendingConfirm = null;
    if (pending !== null) this.dispatchAndRefresh(pending.action);
  }

  cancelPendingAction(): void {
    this.pendingConfirm = null;
  }

  /**
   * Targeted fast-path: re-run list-windows and list-panes for a single
   * session and merge the results into the model right away. Used after
   * session-window-changed fires for a window the subscription hasn't
   * delivered yet — otherwise the UI would be blank for up to a second
   * while waiting for the next subscription tick.
   *
   * [LAW:single-enforcer] The subscription pipeline remains the
   * steady-state model builder. This is a fast-path nudge, not a parallel
   * source of truth — its output is fed through the same parseRecords +
   * rebuildModel path, so the model shape stays consistent.
   */
  private async refreshSession(sessionId: number): Promise<void> {
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

      // Merge by replacing the rows for this session in the latest snapshot
      // strings. Simpler and more correct than trying to patch `sessions`
      // directly: rebuildModel is a pure function of the three snapshots, so
      // producing a new one for just this session and re-running the rebuild
      // keeps everything consistent.
      if (this.latestWindows !== null) {
        this.latestWindows = mergeSessionRows(
          this.latestWindows,
          sessionId,
          windowsResp.output,
          /* sidFieldIndex */ 0,
        );
      }
      if (this.latestPanes !== null) {
        // Pane rows from the fast-path don't carry session_id, but all
        // panes returned here belong to `sessionId`'s windows. We replace
        // rows whose window_id appears in the fresh windowsResp output.
        const freshWindowIds = new Set(
          windowsResp.output
            .map((line) => line.split("|")[1])
            .filter((s) => s.length > 0),
        );
        this.latestPanes = mergePaneRowsByWindow(
          this.latestPanes,
          freshWindowIds,
          panesResp.output,
        );
      }
      runInAction(() => this.rebuildModel());
    } catch {
      // Non-fatal: subscriptions will catch up.
    }
  }

  private async refreshWindowDimensions(windowId: number): Promise<void> {
    try {
      const resp = await this.client.execute(
        `list-panes -t @${windowId} -F '#{pane_id}|#{pane_width}|#{pane_height}'`,
      );
      if (!resp.success) return;
      const updates = new Map<number, { w: number; h: number }>();
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
      if (updates.size === 0) return;

      // [LAW:dataflow-not-control-flow] Reassign `this.sessions` to a new
      // array with new pane objects for any updated pane. PaneInfo is a
      // plain object — mutating its fields in place does NOT trigger MobX
      // observers because the field reads in PaneTerminal's reaction
      // depend on `store.sessions` (the observable), not on per-object
      // field accesses. The immutable rebuild guarantees the reaction
      // re-runs and sees the new dimensions.
      runInAction(() => {
        this.sessions = this.sessions.map((s) => ({
          ...s,
          windows: s.windows.map((win) => ({
            ...win,
            panes: win.panes.map((p) => {
              const u = updates.get(p.id);
              return u !== undefined
                ? { ...p, width: u.w, height: u.h }
                : p;
            }),
          })),
        }));
      });
    } catch {
      // Non-fatal; the subscription's 1 Hz cadence will correct any miss.
    }
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
      "zoomed",
    ]);
    const paneRows = parseRecords(this.latestPanes, [
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

    const built: SessionInfo[] = sessionRows.map((s) => ({
      id: stripPrefix(s.sid),
      name: s.name,
      attached: s.attached !== "0" && s.attached !== "",
      windows: (windowsBySession.get(s.sid) ?? []).sort(
        (a, b) => a.index - b.index,
      ),
    }));

    this.sessions = built;
    // [LAW:one-source-of-truth] No active-id reconciliation here. Active
    // pointers are computed from `session.attached` / `window.active` on
    // each access — they can never be out of sync with the tree.
  }

  private pushEvent(ev: SerializedTmuxMessage): void {
    this.events = [ev, ...this.events].slice(0, 200);
  }

  private pushError(m: string): void {
    const stamp = new Date().toLocaleTimeString();
    this.errors = [`${stamp} — ${m}`, ...this.errors].slice(0, 50);
  }

  clearEvents(): void {
    this.events = [];
  }

  clearErrors(): void {
    this.errors = [];
  }

  // -------------------------------------------------------------------------
  // UI actions
  // -------------------------------------------------------------------------

  /**
   * Resize a tmux pane to the requested cell dimensions. This is the
   * showcase of bidirectional library use: the browser tells tmux to do
   * something, tmux performs the change, and %layout-change flows back
   * to update the store, which in turn drives PaneTerminal's reactive
   * sizing to reflow the xterm.
   *
   * Uses `resize-pane -t %<id> -x <cols> -y <rows>`.
   */
  resizePane(paneId: number, cols: number, rows: number): void {
    void this.client.execute(
      `resize-pane -t %${paneId} -x ${cols} -y ${rows}`,
    );
  }

  // [LAW:one-source-of-truth] select* methods ONLY dispatch tmux commands.
  // The subscription-fed `sessions` tree is the source of truth for which
  // session/window/pane is active; after tmux processes the command, the
  // next subscription tick (or the fast-path refreshSession below) updates
  // the tree and the computed getters reflect the new active state.
  selectSession(id: number): void {
    // Optimistic: set the id we just told tmux to switch to. The
    // %client-session-changed event will confirm it shortly. If tmux
    // rejects the switch, the event never arrives and we stay optimistic
    // — that's fine, a subsequent real change will correct us.
    this.clientSessionId = id;
    void this.client.execute(`switch-client -t \\$${id}`);
    void this.refreshSession(id);
  }

  selectWindow(id: number): void {
    const s = this.currentSession;
    const w = s?.windows.find((x) => x.id === id);
    if (s !== null && w !== undefined) {
      void this.client.execute(`select-window -t ${s.name}:${w.index}`);
      void this.refreshSession(s.id);
    }
  }

  selectPane(pane: PaneInfo): void {
    const s = this.currentSession;
    const w = this.currentWindow;
    if (s !== null && w !== null) {
      void this.client.execute(
        `select-pane -t ${s.name}:${w.index}.${pane.index}`,
      );
      void this.refreshSession(s.id);
    }
  }

  sendKeysToPane(paneId: number, data: string): void {
    void this.client.sendKeys(`%${paneId}`, data);
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
    if (this.clientSessionId !== null) {
      const exists = this.sessions.some((s) => s.id === this.clientSessionId);
      if (exists) return this.clientSessionId;
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
