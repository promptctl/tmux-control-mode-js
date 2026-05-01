// examples/web-multiplexer/web/store.ts
//
// DemoStore — UI policy layer over the library's `TmuxModel`.
//
// The topology projection (subscription installation, list-* bootstrap,
// snapshot rebuild, fast-path refreshes) lives in `TmuxModel` (src/model/).
// This store wires the library's `BridgeModelClient` so `TmuxModel` runs in the
// renderer against either WebSocket or Electron IPC, then projects each
// `snapshot` event into MobX-observable fields.
//
// What stays here is genuinely demo policy:
//   - keymap engine driving (with confirm-modal interception for
//     destructive actions)
//   - the event log for the inspector
//   - selection helpers that pair a tmux command dispatch with a
//     fast-path refresh through the model
//
// [LAW:one-source-of-truth] Topology lives in `TmuxModel`. This file
// projects from snapshots into the renderer's UI types; it never builds
// or mutates a topology tree on its own.

import { makeAutoObservable, runInAction } from "mobx";
import type { TmuxBridge } from "./bridge.ts";
import { BridgeModelClient } from "../../../src/connectors/bridge/index.js";
// [LAW:one-way-deps] Deep-import the renderer-safe submodule. The barrel
// at `src/index.ts` re-exports Node-only `spawnTmux`/socket helpers, and ES
// module evaluation pulls every transitive import even for a single named
// symbol — loading `src/index.js` in the browser fails on `node:child_process`.
import { TmuxModel } from "../../../src/model/index.js";
import type {
  SessionSnapshot,
  TmuxSnapshot,
} from "../../../src/model/index.js";
import type { TmuxMessage } from "../../../src/protocol/types.js";
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
// Snapshot projection
//
// `TmuxModel` produces `TmuxSnapshot` shapes with `width: number | null`;
// the demo's UI components were written against the older "always a number"
// shape and treat empty as 80×24. The projection collapses null → 80/24 at
// this single boundary so the rest of the renderer stays unchanged.
// ---------------------------------------------------------------------------

function projectSessions(snapshot: TmuxSnapshot): SessionInfo[] {
  return snapshot.sessions.map(projectSession);
}

function projectSession(s: SessionSnapshot): SessionInfo {
  return {
    id: s.id,
    name: s.name,
    attached: s.attached,
    windows: s.windows.map((w) => ({
      id: w.id,
      index: w.index,
      name: w.name,
      active: w.active,
      zoomed: w.zoomed,
      panes: w.panes.map((p) => ({
        id: p.id,
        index: p.index,
        active: p.active,
        title: p.title,
        width: p.width ?? 80,
        height: p.height ?? 24,
      })),
    })),
  };
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
  events: TmuxMessage[] = [];
  errors: string[] = [];

  // Mirrored from `TmuxSnapshot.clientSessionId` — kept as an MobX field
  // (instead of a getter into the snapshot) so the few legacy getters that
  // optimistically write it from selection actions can still observe the
  // optimistic value before the next snapshot lands.
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

  readonly client: TmuxBridge;

  // [LAW:one-source-of-truth] One keymap engine per client session.
  private readonly keymapConfig: Keymap = defaultTmuxKeymap();
  private engineState: KeymapState = INITIAL_STATE;
  private readonly hooks: DemoStoreHooks;

  // [LAW:single-enforcer] BridgeModelClient (library) adapts the renderer-
  // side TmuxBridge to TmuxModelClient. Subscription routing, format-string
  // assembly, and typed event fan-out all live there — DemoStore consumes
  // only the model's `snapshot`/`error` stream.
  private readonly bridgeClient: BridgeModelClient;
  private readonly model: TmuxModel;

  constructor(client: TmuxBridge, hooks: DemoStoreHooks = {}) {
    this.client = client;
    this.hooks = hooks;
    this.bridgeClient = new BridgeModelClient(client);
    this.model = new TmuxModel(this.bridgeClient);

    // [LAW:single-enforcer] `keyof T` excludes private fields, so the
    // overrides argument can only constrain public members by default.
    // Declaring the private fields via the AdditionalKeys generic re-admits
    // the annotation for them — keeping access modifiers honest while
    // telling MobX not to wrap them.
    makeAutoObservable<this, "hooks" | "bridgeClient" | "model">(this, {
      client: false,
      hooks: false,
      bridgeClient: false,
      model: false,
    });

    // [LAW:single-enforcer] Wire bridge subscribers EXACTLY ONCE in the
    // constructor (which only runs once via React's useMemo). Wiring them
    // in connect() would register a fresh handler each time React
    // StrictMode invokes the connect-effect, causing every event to fire
    // every duplicate handler.
    this.client.onState((s) => runInAction(() => this.onStateChange(s)));
    this.client.onError((m) => runInAction(() => this.pushError(m)));
    this.client.onEvent((ev) => runInAction(() => this.pushEvent(ev)));

    this.model.on("snapshot", (snap) =>
      runInAction(() => this.applySnapshot(snap)),
    );
    this.model.on("error", (e) =>
      runInAction(() =>
        this.pushError(
          `tmux model [${e.phase}]: ${
            e.cause instanceof Error ? e.cause.message : String(e.cause)
          }`,
        ),
      ),
    );
  }

  connect(url: string): void {
    this.client.connect(url);
  }

  disconnectForReconnect(): void {
    // [LAW:single-enforcer] Socket switching is a transport reconnect, not
    // store teardown. Keep BridgeModelClient/TmuxModel alive so their single
    // reconnect handler reissues subscriptions and clears stale snapshots.
    this.client.disconnect();
  }

  disconnect(): void {
    this.model.dispose();
    this.bridgeClient.dispose();
    this.client.disconnect();
  }

  // -------------------------------------------------------------------------
  // Connection lifecycle
  // -------------------------------------------------------------------------

  private onStateChange(s: ConnState): void {
    this.connState = s;
  }

  // -------------------------------------------------------------------------
  // Snapshot projection
  // -------------------------------------------------------------------------

  private applySnapshot(snap: TmuxSnapshot): void {
    // [LAW:dataflow-not-control-flow] Always project; the snapshot's
    // emptiness is encoded in the data (empty array, null id), not in
    // whether we run the projection.
    this.sessions = projectSessions(snap);
    this.clientSessionId = snap.clientSessionId;
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
   * the current session's windows/panes via the model. Subscriptions will
   * catch up within ~1s on their own; this just makes the UI feel snappy
   * after a user keystroke.
   *
   * [LAW:single-enforcer] This is the ONE place that pairs an action
   * dispatch with a refresh.
   */
  private dispatchAndRefresh(action: Action): void {
    dispatchAction(this.client, action);
    const sid = this.activeSessionId;
    if (sid !== null) void this.model.refreshSession(sid);
  }

  confirmPendingAction(): void {
    const pending = this.pendingConfirm;
    this.pendingConfirm = null;
    if (pending !== null) this.dispatchAndRefresh(pending.action);
  }

  cancelPendingAction(): void {
    this.pendingConfirm = null;
  }

  // -------------------------------------------------------------------------
  // Event log
  // -------------------------------------------------------------------------

  private pushEvent(ev: TmuxMessage): void {
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
   * through the model to update pane dimensions, which in turn drives
   * PaneTerminal's reactive sizing.
   *
   * Uses `resize-pane -t %<id> -x <cols> -y <rows>`.
   */
  resizePane(paneId: number, cols: number, rows: number): void {
    void this.client.execute(
      `resize-pane -t %${paneId} -x ${cols} -y ${rows}`,
    );
  }

  // [LAW:one-source-of-truth] select* methods ONLY dispatch tmux commands
  // and nudge a fast-path refresh; the model owns the topology truth.
  selectSession(id: number): void {
    // Optimistic: set the id we just told tmux to switch to. The next
    // snapshot will overwrite from `client-session-changed`. If tmux
    // rejects the switch the optimistic write stays until a real change
    // corrects it.
    this.clientSessionId = id;
    void this.client.execute(`switch-client -t \\$${id}`);
    void this.model.refreshSession(id);
  }

  selectWindow(id: number): void {
    const s = this.currentSession;
    const w = s?.windows.find((x) => x.id === id);
    if (s !== null && w !== undefined) {
      void this.client.execute(`select-window -t ${s.name}:${w.index}`);
      void this.model.refreshSession(s.id);
    }
  }

  selectPane(pane: PaneInfo): void {
    const s = this.currentSession;
    const w = this.currentWindow;
    if (s !== null && w !== null) {
      void this.client.execute(
        `select-pane -t ${s.name}:${w.index}.${pane.index}`,
      );
      void this.model.refreshSession(s.id);
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
   * Map of pane id → human-readable label like "cc-dump:1.0". Computed
   * from the current sessions tree; used by the debug panel to render
   * pane events.
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
