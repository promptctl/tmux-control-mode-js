// examples/web-multiplexer/web/electron-bridge.ts
// Electron-IPC implementation of TmuxBridge — wraps the library's
// renderer-side TmuxClientProxy so the unified web-multiplexer renderer
// can drive tmux over Electron IPC instead of (or alongside) WebSocket.
//
// [LAW:single-enforcer] One adapter, one boundary. The proxy is the
// single in-renderer surface that talks to the main process; this file
// is the single place that adapts the proxy's shape to TmuxBridge.
//
// [LAW:dataflow-not-control-flow] Method calls and events run the same
// pipeline every time:
//   - methods: synthesize InspectorRequest (RpcRequest + id) → emit "out"
//     wire → invoke proxy → emit "in-response" wire (or "in-error" on
//     rejection)
//   - events:  proxy.on("*") → emit "in-event" wire → fan out to handlers
// No branching on "is this a special method" or "is this a special event".

import {
  createRendererBridge,
  type IpcRendererLike,
  type TmuxClientProxy,
} from "@promptctl/tmux-control-mode-js/electron/renderer";
import type {
  CommandResponse,
  PaneAction,
  TmuxMessage,
} from "../../../src/protocol/types.js";
import type {
  ConnState,
  ErrorHandler,
  EventHandler,
  InspectorRequest,
  StateHandler,
  TmuxBridge,
  WireEntry,
  WireHandler,
} from "./bridge.ts";

export class ElectronBridge implements TmuxBridge {
  private readonly ipcRenderer: IpcRendererLike;
  private readonly proxyEventHandler: (msg: TmuxMessage) => void;
  private proxy: TmuxClientProxy | null = null;
  private state: ConnState = "connecting";
  private nextId = 0;
  private readonly eventHandlers = new Set<EventHandler>();
  private readonly errorHandlers = new Set<ErrorHandler>();
  private readonly stateHandlers = new Set<StateHandler>();
  private readonly wireHandlers = new Set<WireHandler>();

  constructor(ipcRenderer: IpcRendererLike) {
    this.ipcRenderer = ipcRenderer;
    // [LAW:single-enforcer] One proxy.on("*") subscription per connect()
    // — every event fans out to local handlers + the wire stream from
    // this single source. Storing the bound handler at construction time
    // means each connect/disconnect cycle uses the SAME closure identity
    // so removeListener pairs cleanly with on().
    this.proxyEventHandler = (msg) => this.fanOutEvent(msg);
  }

  // ---------------------------------------------------------------------------
  // RPC methods
  // ---------------------------------------------------------------------------

  execute(command: string): Promise<CommandResponse> {
    const request: InspectorRequest = {
      id: this.allocId(),
      method: "execute",
      args: [command],
    };
    return this.invokeWithWire(request, (proxy) => proxy.execute(command));
  }

  sendKeys(target: string, keys: string): Promise<CommandResponse> {
    const request: InspectorRequest = {
      id: this.allocId(),
      method: "sendKeys",
      args: [target, keys],
    };
    return this.invokeWithWire(request, (proxy) =>
      proxy.sendKeys(target, keys),
    );
  }

  setPaneAction(
    paneId: number,
    action: PaneAction,
  ): Promise<CommandResponse> {
    const request: InspectorRequest = {
      id: this.allocId(),
      method: "setPaneAction",
      args: [paneId, action],
    };
    return this.invokeWithWire(request, (proxy) =>
      proxy.setPaneAction(paneId, action),
    );
  }

  /**
   * No-op on Electron. The renderer-side proxy intentionally does not
   * expose `detach` — it tears down the tmux client for every renderer
   * sharing the bridge, which is an admin operation the main process
   * owns. The demo's renderer does not call this method today; this stub
   * exists to satisfy the TmuxBridge interface, mirroring the same
   * stance taken by the WebSocket adapter (`web/ws-bridge.ts`).
   */
  detach(): void {
    // intentional no-op
  }

  /**
   * Open the proxy and announce readiness. Idempotent — a second connect
   * while a proxy is live is a no-op. The URL argument is ignored: IPC
   * has no URL to dial; the renderer's tmux session is whichever one the
   * main process attached to.
   *
   * Lazy proxy creation lets a renderer cycle through connect/disconnect/
   * connect (e.g. React StrictMode dev double-mount, or a "reconnect"
   * UI affordance) without leaking a dead proxy or duplicate IPC
   * handlers.
   */
  connect(_url: string): void {
    if (this.proxy !== null) return;
    const proxy = createRendererBridge(this.ipcRenderer);
    proxy.on("*", this.proxyEventHandler);
    this.proxy = proxy;
    this.setState("connecting");
    // Main-side createWindow gates on `session-changed`, so by the time
    // this runs the underlying TmuxClient is already attached and ready.
    // Defer the ready transition by one microtask so callers that wire
    // `onState` synchronously after connect() observe connecting → ready.
    queueMicrotask(() => {
      if (this.proxy !== proxy) return;
      this.setState("ready");
    });
  }

  disconnect(): void {
    const proxy = this.proxy;
    if (proxy === null) return;
    this.proxy = null;
    proxy.off("*", this.proxyEventHandler);
    proxy.close();
    this.setState("closed");
  }

  // ---------------------------------------------------------------------------
  // Subscriptions
  // ---------------------------------------------------------------------------

  onEvent(h: EventHandler): () => void {
    this.eventHandlers.add(h);
    return () => {
      this.eventHandlers.delete(h);
    };
  }

  onError(h: ErrorHandler): () => void {
    this.errorHandlers.add(h);
    return () => {
      this.errorHandlers.delete(h);
    };
  }

  onState(h: StateHandler): () => void {
    this.stateHandlers.add(h);
    h(this.state);
    return () => {
      this.stateHandlers.delete(h);
    };
  }

  onWire(h: WireHandler): () => void {
    this.wireHandlers.add(h);
    return () => {
      this.wireHandlers.delete(h);
    };
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private fanOutEvent(msg: TmuxMessage): void {
    this.emitWire({ dir: "in-event", ts: Date.now(), event: msg });
    this.eventHandlers.forEach((h) => h(msg));
  }

  private async invokeWithWire(
    request: InspectorRequest,
    invoker: (proxy: TmuxClientProxy) => Promise<CommandResponse>,
  ): Promise<CommandResponse> {
    const proxy = this.proxy;
    if (proxy === null) {
      const message = `cannot ${request.method}: bridge is not connected`;
      this.emitWire({
        dir: "in-error",
        ts: Date.now(),
        id: request.id,
        message,
      });
      this.errorHandlers.forEach((h) => h(message, request.id));
      throw new Error(message);
    }
    const sentAt = Date.now();
    this.emitWire({ dir: "out", ts: sentAt, msg: request });
    try {
      const response = await invoker(proxy);
      const now = Date.now();
      this.emitWire({
        dir: "in-response",
        ts: now,
        id: request.id,
        response,
        latencyMs: now - sentAt,
        request,
      });
      return response;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.emitWire({
        dir: "in-error",
        ts: Date.now(),
        id: request.id,
        message,
      });
      this.errorHandlers.forEach((h) => h(message, request.id));
      throw err;
    }
  }

  private setState(s: ConnState): void {
    if (this.state === s) return;
    this.state = s;
    this.stateHandlers.forEach((h) => h(s));
  }

  private emitWire(entry: WireEntry): void {
    this.wireHandlers.forEach((h) => h(entry));
  }

  private allocId(): string {
    this.nextId += 1;
    return `e${this.nextId}`;
  }
}
