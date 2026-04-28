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
//   - methods: synthesize ClientToServer → emit "out" wire → invoke proxy
//     → emit "in-response" wire (or "in-error" on rejection)
//   - events:  proxy.on("*") → emit "in-event" wire → fan out to handlers
// No branching on "is this a special method" or "is this a special event".

import {
  createRendererBridge,
  type IpcRendererLike,
  type TmuxClientProxy,
} from "@promptctl/tmux-control-mode-js/electron/renderer";
import type {
  CommandResponse,
  TmuxMessage,
} from "../../../src/protocol/types.js";
import type { ClientToServer } from "../shared/protocol.ts";
import type {
  ConnState,
  ErrorHandler,
  EventHandler,
  StateHandler,
  TmuxBridge,
  WireEntry,
  WireHandler,
} from "./bridge.ts";

export class ElectronBridge implements TmuxBridge {
  private readonly proxy: TmuxClientProxy;
  private state: ConnState = "connecting";
  private closed = false;
  private nextId = 0;
  private readonly eventHandlers = new Set<EventHandler>();
  private readonly errorHandlers = new Set<ErrorHandler>();
  private readonly stateHandlers = new Set<StateHandler>();
  private readonly wireHandlers = new Set<WireHandler>();
  private readonly proxyEventHandler: (msg: TmuxMessage) => void;

  constructor(ipcRenderer: IpcRendererLike) {
    this.proxy = createRendererBridge(ipcRenderer);

    // [LAW:single-enforcer] One proxy.on("*") subscription per bridge —
    // every event fans out to local handlers + the wire stream from this
    // single source. Adding a second subscription would create a second
    // ingestion path the inspector and renderer could disagree about.
    this.proxyEventHandler = (msg) => this.fanOutEvent(msg);
    this.proxy.on("*", this.proxyEventHandler);

    // Main-side createWindow gates on `session-changed`, so by the time
    // this constructor runs the underlying TmuxClient is already attached
    // and ready. Defer the connecting → ready transition by one microtask
    // so callers that wire `onState` synchronously after construction
    // (DemoStore does this in its constructor) observe the transition.
    queueMicrotask(() => {
      if (this.closed) return;
      this.setState("ready");
    });
  }

  // ---------------------------------------------------------------------------
  // RPC methods
  // ---------------------------------------------------------------------------

  execute(command: string): Promise<CommandResponse> {
    const request: ClientToServer = {
      kind: "execute",
      id: this.allocId(),
      command,
    };
    return this.invokeWithWire(request, () => this.proxy.execute(command));
  }

  sendKeys(target: string, keys: string): Promise<CommandResponse> {
    const request: ClientToServer = {
      kind: "sendKeys",
      id: this.allocId(),
      target,
      keys,
    };
    return this.invokeWithWire(request, () =>
      this.proxy.sendKeys(target, keys),
    );
  }

  /**
   * No-op on Electron. WebSocketBridge.detach asks the bridge server to
   * close its TmuxClient, which detaches every connected renderer; the
   * Electron equivalent is an admin operation the main process owns
   * (it holds the TmuxClient handle). The renderer-side proxy
   * intentionally does not expose `detach` — see
   * src/connectors/electron/renderer.ts on why. The demo's renderer
   * does not call this method today; this stub exists to satisfy the
   * TmuxBridge interface.
   */
  detach(): void {
    // intentional no-op
  }

  /**
   * The proxy is constructed already-attached, so `connect` is a no-op.
   * The URL argument is ignored — IPC has no URL to dial. The
   * connecting → ready transition was scheduled by the constructor.
   */
  connect(_url: string): void {
    // intentional no-op
  }

  disconnect(): void {
    if (this.closed) return;
    this.closed = true;
    this.proxy.off("*", this.proxyEventHandler);
    this.proxy.close();
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
    request: ClientToServer,
    invoker: () => Promise<CommandResponse>,
  ): Promise<CommandResponse> {
    const sentAt = Date.now();
    this.emitWire({ dir: "out", ts: sentAt, msg: request });
    try {
      const response = await invoker();
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
