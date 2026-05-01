// examples/web-multiplexer/web/ws-bridge.ts
// WebSocket implementation of TmuxBridge — wraps the library's
// `WebSocketTmuxClient` so the unified web-multiplexer renderer drives
// tmux through the same bridge contract whether the transport is
// Electron IPC or a raw WebSocket. Mirrors the shape of
// `electron-bridge.ts:38` (`class ElectronBridge implements TmuxBridge`)
// — every wire detail (handshake, framing, base64 vs binary, reconnect)
// lives in the library; this file is purely the renderer-side adapter.
//
// [LAW:single-enforcer] One adapter, one boundary. The library's
// `WebSocketTmuxClient` is the single in-renderer surface that talks to
// the bridge server; this file is the single place that adapts it to
// `TmuxBridge`.
//
// [LAW:dataflow-not-control-flow] Method calls and events run the same
// pipeline every time:
//   - methods: synthesize InspectorRequest (RpcRequest + id) → emit "out"
//     wire → invoke client → emit "in-response" wire (or "in-error" on
//     rejection)
//   - events:  client.on("*") → emit "in-event" wire → fan out to handlers
// No branching on "is this a special method" or "is this a special event".

import { WebSocketTmuxClient } from "@promptctl/tmux-control-mode-js/websocket/client";
import type { WebSocketTmuxClientState } from "@promptctl/tmux-control-mode-js/websocket/client";
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

export class WSBridge implements TmuxBridge {
  private client: WebSocketTmuxClient | null = null;
  private readonly clientEventHandler: (msg: TmuxMessage) => void;
  private state: ConnState = "connecting";
  private nextId = 0;
  private readonly eventHandlers = new Set<EventHandler>();
  private readonly errorHandlers = new Set<ErrorHandler>();
  private readonly stateHandlers = new Set<StateHandler>();
  private readonly wireHandlers = new Set<WireHandler>();

  constructor() {
    // [LAW:single-enforcer] One client.on("*") subscription per connect()
    // — every event fans out to local handlers + the wire stream from
    // this single source. Storing the bound handler at construction time
    // means each connect/disconnect cycle uses the SAME closure identity
    // so off() pairs cleanly with on().
    this.clientEventHandler = (msg) => this.fanOutEvent(msg);
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
    return this.invokeWithWire(request, (c) => c.execute(command));
  }

  sendKeys(target: string, keys: string): Promise<CommandResponse> {
    const request: InspectorRequest = {
      id: this.allocId(),
      method: "sendKeys",
      args: [target, keys],
    };
    return this.invokeWithWire(request, (c) => c.sendKeys(target, keys));
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
    return this.invokeWithWire(request, (c) => c.setPaneAction(paneId, action));
  }

  /**
   * No-op. Detach is intentionally absent from the library's bridged RPC
   * surface (`src/connectors/rpc.ts:34-38`) because it tears down the
   * tmux client for every renderer sharing the server-side bridge — an
   * admin operation owned by the host, not the renderer. The demo's
   * renderer does not call this method today; this stub exists to
   * satisfy the TmuxBridge interface and matches the Electron adapter's
   * stance (`web/electron-bridge.ts:99-111`). To drop a renderer's own
   * session, call `disconnect()` instead — the bridge's `disposeClient`
   * hook closes the per-connection TmuxClient on the server side.
   */
  detach(): void {
    // intentional no-op
  }

  /**
   * Open the WebSocket and announce readiness. Idempotent — a second
   * connect while a client is live is a no-op. React StrictMode's
   * intentional dev double-mount goes through `disconnect`+`connect`
   * cycles; the library client tolerates this and the
   * single-listener guard above keeps event delivery from doubling.
   */
  connect(url: string): void {
    if (this.client !== null) return;
    this.setState("connecting");
    const client = new WebSocketTmuxClient({
      url,
      autoConnect: true,
      onState: (s) => this.onLibState(s),
      onError: (err) => this.emitError(err.message),
    });
    client.on("*", this.clientEventHandler);
    this.client = client;
  }

  disconnect(): void {
    const client = this.client;
    if (client === null) return;
    this.client = null;
    client.off("*", this.clientEventHandler);
    void client.close();
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
    invoker: (client: WebSocketTmuxClient) => Promise<CommandResponse>,
  ): Promise<CommandResponse> {
    const client = this.client;
    if (client === null) {
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
      const response = await invoker(client);
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

  /**
   * Map the library client's seven-state machine onto the demo's
   * four-state `ConnState` (per `src/connectors/types.ts:38-52`).
   *
   * - `idle` is pre-connect; treat as `connecting` so the UI shows
   *   "Connecting" instead of nothing during the brief window before
   *   the socket opens.
   * - `draining` and `reconnecting` are transient socket-level states
   *   that the consumer-facing four-state contract folds into
   *   `closed` — the user-visible truth is "tmux is not currently
   *   reachable" until `ready` returns.
   *
   * [LAW:dataflow-not-control-flow] One indexed lookup; the library's
   * state value selects the consumer-state value. No `if`-skipping.
   */
  private onLibState(s: WebSocketTmuxClientState): void {
    this.setState(LIB_STATE_TO_CONN[s]);
  }

  private setState(s: ConnState): void {
    if (this.state === s) return;
    this.state = s;
    this.stateHandlers.forEach((h) => h(s));
  }

  private emitError(message: string, id?: string): void {
    this.errorHandlers.forEach((h) => h(message, id));
  }

  private emitWire(entry: WireEntry): void {
    this.wireHandlers.forEach((h) => h(entry));
  }

  private allocId(): string {
    this.nextId += 1;
    return `r${this.nextId}`;
  }
}

const LIB_STATE_TO_CONN: Readonly<Record<WebSocketTmuxClientState, ConnState>> =
  Object.freeze({
    idle: "connecting",
    connecting: "connecting",
    open: "open",
    ready: "ready",
    draining: "closed",
    reconnecting: "closed",
    closed: "closed",
  });
