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
//     rate-limited to once per second per subscription. RefreshPolicy handles
//     each event by re-parsing the delivered value and replacing the
//     corresponding observable collection. MobX observers re-render.
//
//   - Pane output (%output, %extended-output) is unrelated to subscriptions;
//     the PaneView component subscribes to those events directly.
//
// This is the canonical reactive pattern for a tmux control-mode consumer:
// zero polling, zero explicit queries after startup, the UI is a pure
// function of tmux's pushed state.
//
// DemoStore itself is a thin composition root: it wires the bridge to its
// collaborators exactly once and exposes their state through delegating
// getters so the public API (and every component that reads it) is unchanged.
// The real work lives in the parts it composes:
//   - snapshot-codec       — pure wire↔tree translation
//   - TmuxModel            — the reactive tree + derived active pointers
//   - LogStore             — event / error ring buffers
//   - ConnectionController — connection state + subscription install
//   - RefreshPolicy        — event routing + fast-path refreshes
//   - SelectionController  — optimistic session/window/pane selection
//   - KeymapController     — keymap engine + destructive-action confirmation

import { makeAutoObservable, runInAction } from "mobx";
import type { TmuxBridge } from "./bridge.ts";
import type { TmuxMessage } from "@promptctl/tmux-control-mode-js";
import type { KeyEvent } from "@promptctl/tmux-control-mode-js/keymap";
import { BridgePaneStreamClient } from "./pane-stream-bridge.ts";
import type { PaneInfo, SessionInfo, WindowInfo } from "./snapshot-codec.ts";
import { TmuxModel } from "./tmux-model.ts";
import { LogStore } from "./log-store.ts";
import {
  ConnectionController,
  type ConnState,
} from "./connection-controller.ts";
import { RefreshPolicy } from "./refresh-policy.ts";
import { SelectionController } from "./selection-controller.ts";
import {
  KeymapController,
  type KeymapHooks,
  type PendingConfirm,
} from "./keymap-controller.ts";

// Re-exported so the many components importing these from "./store.ts" keep
// working while the definitions live with the parts that own them.
// [LAW:one-source-of-truth]
export type { PaneInfo, SessionInfo, WindowInfo } from "./snapshot-codec.ts";
export type { PendingConfirm } from "./keymap-controller.ts";
export type { KeymapHooks as DemoStoreHooks } from "./keymap-controller.ts";

export class DemoStore {
  readonly client: TmuxBridge;
  /** Shared `TmuxConnection` adapter — one per bridge, used by all `PaneStream` instances. */
  readonly paneStreamClient: BridgePaneStreamClient;

  private readonly model: TmuxModel;
  private readonly log: LogStore;
  private readonly connection: ConnectionController;
  private readonly refresh: RefreshPolicy;
  private readonly selection: SelectionController;
  private readonly keymap: KeymapController;

  constructor(client: TmuxBridge, hooks: KeymapHooks = {}) {
    this.client = client;
    this.paneStreamClient = new BridgePaneStreamClient(client);

    // Build the collaborators in dependency order: pure/leaf parts first, the
    // effectful controllers (which drive them) last. [LAW:one-way-deps]
    this.model = new TmuxModel();
    this.log = new LogStore();
    this.connection = new ConnectionController(client, this.model, this.log);
    this.refresh = new RefreshPolicy(client, this.model);
    this.selection = new SelectionController(client, this.model, this.refresh);
    this.keymap = new KeymapController(client, this.model, this.refresh, hooks);

    makeAutoObservable<
      this,
      "model" | "log" | "connection" | "refresh" | "selection" | "keymap"
    >(this, {
      client: false,
      paneStreamClient: false,
      model: false,
      log: false,
      connection: false,
      refresh: false,
      selection: false,
      keymap: false,
    });

    // [LAW:single-enforcer] Wire TmuxBridge subscribers EXACTLY ONCE in the
    // constructor (which only runs once via React's useMemo). Wiring them in
    // connect() would register a fresh handler each time React StrictMode
    // invokes the connect-effect, causing every event to fire every duplicate
    // handler — ie every event would be processed N times.
    this.client.onState((s) =>
      runInAction(() => this.connection.onStateChange(s)),
    );
    this.client.onError((m) => runInAction(() => this.log.pushError(m)));
    this.client.onEvent((ev) =>
      runInAction(() => {
        // Every event is logged; RefreshPolicy additionally routes the ones
        // that drive the model. One transaction so observers update once.
        this.log.pushEvent(ev);
        this.refresh.handleEvent(ev);
      }),
    );
  }

  // -------------------------------------------------------------------------
  // Connection lifecycle (→ ConnectionController)
  // -------------------------------------------------------------------------

  connect(url: string): void {
    this.connection.connect(url);
  }

  disconnect(): void {
    this.connection.disconnect();
  }

  get connState(): ConnState {
    return this.connection.connState;
  }

  get statusColor(): string {
    return this.connection.statusColor;
  }

  // -------------------------------------------------------------------------
  // Model (→ TmuxModel)
  // -------------------------------------------------------------------------

  get sessions(): SessionInfo[] {
    return this.model.sessions;
  }

  set sessions(value: SessionInfo[]) {
    this.model.sessions = value;
  }

  get activeSessionId(): number | null {
    return this.model.activeSessionId;
  }

  get currentSession(): SessionInfo | null {
    return this.model.currentSession;
  }

  get activeWindowId(): number | null {
    return this.model.activeWindowId;
  }

  get currentWindow(): WindowInfo | null {
    return this.model.currentWindow;
  }

  get paneLabels(): Map<number, string> {
    return this.model.paneLabels;
  }

  clearTopology(): void {
    this.model.clearTopology();
  }

  // -------------------------------------------------------------------------
  // Event / error log (→ LogStore)
  // -------------------------------------------------------------------------

  get events(): TmuxMessage[] {
    return this.log.events;
  }

  get errors(): string[] {
    return this.log.errors;
  }

  clearEvents(): void {
    this.log.clearEvents();
  }

  clearErrors(): void {
    this.log.clearErrors();
  }

  // -------------------------------------------------------------------------
  // Selection commands (→ SelectionController)
  // -------------------------------------------------------------------------

  selectSession(id: number): void {
    this.selection.selectSession(id);
  }

  selectWindow(id: number): void {
    this.selection.selectWindow(id);
  }

  selectPane(pane: PaneInfo): void {
    this.selection.selectPane(pane);
  }

  jumpToPane(sessionId: number, windowId: number, paneId: number): void {
    this.selection.jumpToPane(sessionId, windowId, paneId);
  }

  // -------------------------------------------------------------------------
  // Keymap + confirm modal (→ KeymapController)
  // -------------------------------------------------------------------------

  handleKeyEvent(ev: KeyEvent): boolean {
    return this.keymap.handleKeyEvent(ev);
  }

  get prefixActive(): boolean {
    return this.keymap.prefixActive;
  }

  get pendingConfirm(): PendingConfirm | null {
    return this.keymap.pendingConfirm;
  }

  confirmPendingAction(): void {
    this.keymap.confirmPendingAction();
  }

  cancelPendingAction(): void {
    this.keymap.cancelPendingAction();
  }
}
