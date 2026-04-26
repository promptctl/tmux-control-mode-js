// src/connectors/websocket/client.ts
// WebSocket bridge — browser side.
//
// `WebSocketTmuxClient` presents the same public surface as `TmuxClient` but
// every method is a Promise that rides the bridge. Consumers written against
// `TmuxClient` move to the browser by swapping the constructor — no other
// code changes.
//
// Production-oriented behaviors baked in:
//   - hello/welcome handshake, protocol version check
//   - request timeouts (per-call deadline surfaced as typed BridgeError)
//   - app-level ping/pong heartbeats (complements transport-level WS pings,
//     which browsers hide from userland)
//   - outbound queue during connection setup and reconnection
//   - reconnect with exponential backoff + jitter (opt-in)
//   - typed BridgeError rejections — consumers branch on `error.code`
//   - graceful `draining` handling: no new calls accepted after drain signal
//
// [LAW:one-source-of-truth] Request correlation lives in `pending`, period.
// [LAW:single-enforcer] `finalizeConnection` is the only cleanup site; every
// close/error/reconnect flows through it.

import { TypedEmitter, type TmuxEventMap } from "../../emitter.js";

// Internal structural view of TypedEmitter's untyped implementation signature.
// TypedEmitter's public API uses typed overloads; the WebSocket client deals
// in strings (method name → event name) and needs to invoke the underlying
// implementation signature without re-implementing the overload set.
interface EmitterImpl {
  on(event: string, handler: (ev: never) => void): void;
  off(event: string, handler: (ev: never) => void): void;
  emit(msg: TmuxMessage): void;
}
import type {
  CommandResponse,
  PaneAction,
  TmuxMessage,
} from "../../protocol/types.js";
import type { SplitOptions } from "../../client.js";

import {
  BridgeError,
  PROTOCOL_VERSION,
  decodePaneOutput,
  encodeClientFrame,
  isPaneOutputFrame,
  parseServerFrame,
  type ResultFrame,
  type RpcMethod,
  type ServerFrame,
  type WelcomeFrame,
  type WelcomeLimits,
} from "./protocol.js";

import type {
  BrowserWebSocketLike,
  ReconnectPolicy,
} from "./types.js";
import { WEBSOCKET_OPEN } from "./types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type WebSocketTmuxClientState =
  | "idle"
  | "connecting"
  | "open"
  | "ready"
  | "draining"
  | "reconnecting"
  | "closed";

export interface WebSocketTmuxClientOptions {
  /** Endpoint URL. */
  readonly url: string;
  /** Custom WebSocket factory. Default: `new WebSocket(url, subprotocol)`. */
  readonly createWebSocket?: (
    url: string,
    subprotocol?: string | string[],
  ) => BrowserWebSocketLike;
  /** Subprotocol for handshake (useful to carry a bearer token). */
  readonly subprotocol?: string | string[];
  /** Reconnect policy. Default: no reconnect. */
  readonly reconnect?: ReconnectPolicy;
  /** Per-call timeout ms. Default: 30000. Server's welcome value wins if smaller. */
  readonly requestTimeoutMs?: number;
  /** App-level ping interval ms. Default: matches server welcome. 0 disables. */
  readonly heartbeatIntervalMs?: number;
  /** Pong timeout ms. Default: 10000. */
  readonly heartbeatTimeoutMs?: number;
  /** Connect at construction. Default: true. */
  readonly autoConnect?: boolean;
  readonly onState?: (state: WebSocketTmuxClientState) => void;
  readonly onError?: (error: BridgeError) => void;
  readonly onDraining?: (deadlineMs: number) => void;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULTS = Object.freeze({
  requestTimeoutMs: 30_000,
  heartbeatIntervalMs: 30_000,
  heartbeatTimeoutMs: 10_000,
}) satisfies Record<string, number>;

// ---------------------------------------------------------------------------
// WebSocketTmuxClient
// ---------------------------------------------------------------------------

interface Pending {
  readonly method: RpcMethod;
  resolve(r: CommandResponse): void;
  reject(e: BridgeError): void;
  timer: ReturnType<typeof setTimeout>;
}

export class WebSocketTmuxClient {
  private readonly emitter = new TypedEmitter();
  private readonly pending = new Map<string, Pending>();
  private readonly outbox: string[] = [];

  private ws: BrowserWebSocketLike | null = null;
  private nextId = 0;
  private currentState: WebSocketTmuxClientState = "idle";
  private attempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPingId: string | null = null;
  private serverLimits: WelcomeLimits | null = null;
  private userRequestedClose = false;

  constructor(private readonly opts: WebSocketTmuxClientOptions) {
    if (opts.autoConnect ?? true) {
      void this.connect();
    }
  }

  // -------------------------------------------------------------------------
  // Public state
  // -------------------------------------------------------------------------
  get state(): WebSocketTmuxClientState {
    return this.currentState;
  }

  // -------------------------------------------------------------------------
  // Connection lifecycle
  // -------------------------------------------------------------------------
  async connect(): Promise<void> {
    if (
      this.currentState === "open" ||
      this.currentState === "ready" ||
      this.currentState === "connecting"
    ) {
      return;
    }
    this.userRequestedClose = false;
    this.openSocket();
  }

  async close(): Promise<void> {
    this.userRequestedClose = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws !== null && this.ws.readyState === WEBSOCKET_OPEN) {
      try {
        this.ws.send(encodeClientFrame({ v: 1, k: "bye" }));
      } catch {
        // ignore
      }
      try {
        this.ws.close(1000, "client close");
      } catch {
        // ignore
      }
    }
    this.transition("closed");
  }

  // -------------------------------------------------------------------------
  // Event subscription — matches TmuxClient.on / off exactly
  // -------------------------------------------------------------------------
  on<K extends keyof TmuxEventMap>(
    event: K,
    handler: (ev: TmuxEventMap[K]) => void,
  ): void;
  on(event: "*", handler: (ev: TmuxMessage) => void): void;
  on(event: string, handler: (ev: never) => void): void {
    (this.emitter as unknown as EmitterImpl).on(event, handler);
  }

  off<K extends keyof TmuxEventMap>(
    event: K,
    handler: (ev: TmuxEventMap[K]) => void,
  ): void;
  off(event: "*", handler: (ev: TmuxMessage) => void): void;
  off(event: string, handler: (ev: never) => void): void {
    (this.emitter as unknown as EmitterImpl).off(event, handler);
  }

  // -------------------------------------------------------------------------
  // Proxied TmuxClient methods — signatures match exactly
  // -------------------------------------------------------------------------
  execute(command: string): Promise<CommandResponse> {
    return this.call("execute", [command]);
  }

  listWindows(): Promise<CommandResponse> {
    return this.call("listWindows", []);
  }

  listPanes(): Promise<CommandResponse> {
    return this.call("listPanes", []);
  }

  sendKeys(target: string, keys: string): Promise<CommandResponse> {
    return this.call("sendKeys", [target, keys]);
  }

  splitWindow(options: SplitOptions = {}): Promise<CommandResponse> {
    return this.call("splitWindow", [options]);
  }

  setSize(width: number, height: number): Promise<CommandResponse> {
    return this.call("setSize", [width, height]);
  }

  setPaneAction(
    paneId: number,
    action: PaneAction,
  ): Promise<CommandResponse> {
    return this.call("setPaneAction", [paneId, action]);
  }

  subscribe(
    name: string,
    what: string,
    format: string,
  ): Promise<CommandResponse> {
    return this.call("subscribe", [name, what, format]);
  }

  unsubscribe(name: string): Promise<CommandResponse> {
    return this.call("unsubscribe", [name]);
  }

  setFlags(flags: readonly string[]): Promise<CommandResponse> {
    return this.call("setFlags", [flags]);
  }

  clearFlags(flags: readonly string[]): Promise<CommandResponse> {
    return this.call("clearFlags", [flags]);
  }

  requestReport(paneId: number, report: string): Promise<CommandResponse> {
    return this.call("requestReport", [paneId, report]);
  }

  queryClipboard(): Promise<CommandResponse> {
    return this.call("queryClipboard", []);
  }

  detach(): void {
    // detach is fire-and-forget on TmuxClient. The bridge still sends a
    // synthesized result so we `void` it rather than hand the promise out.
    void this.call("detach", []);
  }

  // -------------------------------------------------------------------------
  // Internal: call dispatch
  // -------------------------------------------------------------------------
  private call(
    method: RpcMethod,
    args: readonly unknown[],
  ): Promise<CommandResponse> {
    if (this.currentState === "closed" || this.userRequestedClose) {
      return Promise.reject(
        new BridgeError("BRIDGE_CLOSED", "client is closed"),
      );
    }
    if (this.currentState === "draining") {
      return Promise.reject(
        new BridgeError("BRIDGE_CLOSED", "server is draining"),
      );
    }

    const id = this.id();
    const timeoutMs = this.effectiveTimeoutMs();
    return new Promise<CommandResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        const p = this.pending.get(id);
        if (p === undefined) return;
        this.pending.delete(id);
        reject(
          new BridgeError(
            "BRIDGE_TIMEOUT",
            `request '${method}' timed out after ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);
      (timer as unknown as { unref?: () => void }).unref?.();

      this.pending.set(id, { method, resolve, reject, timer });
      this.send(
        encodeClientFrame({ v: 1, k: "call", id, method, args }),
      );
    });
  }

  private id(): string {
    this.nextId += 1;
    return `r${this.nextId}`;
  }

  private effectiveTimeoutMs(): number {
    const fromOpts = this.opts.requestTimeoutMs ?? DEFAULTS.requestTimeoutMs;
    const fromServer = this.serverLimits?.requestTimeoutMs;
    return fromServer !== undefined ? Math.min(fromOpts, fromServer) : fromOpts;
  }

  // -------------------------------------------------------------------------
  // Internal: socket lifecycle
  // -------------------------------------------------------------------------
  private openSocket(): void {
    this.transition("connecting");
    const factory =
      this.opts.createWebSocket ??
      ((url: string, subprotocol?: string | string[]) =>
        new (globalThis as { WebSocket: new (url: string, protocols?: string | string[]) => BrowserWebSocketLike }).WebSocket(
          url,
          subprotocol,
        ));
    let ws: BrowserWebSocketLike;
    try {
      ws = factory(this.opts.url, this.opts.subprotocol);
    } catch (err) {
      this.finalizeConnection(
        new BridgeError(
          "BRIDGE_INTERNAL",
          `failed to create WebSocket: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
      return;
    }
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.addEventListener("open", () => this.onOpen());
    ws.addEventListener("message", (event: { data: unknown }) =>
      this.onMessage(event.data),
    );
    ws.addEventListener("close", (event: { code?: number; reason?: string }) =>
      this.onClose(event),
    );
    ws.addEventListener("error", () => {
      // Error events in the browser are opaque. Treat as a connection error;
      // the 'close' that follows will drive the actual teardown.
      this.emitError(new BridgeError("BRIDGE_INTERNAL", "websocket error"));
    });
  }

  private onOpen(): void {
    this.transition("open");
    this.send(
      encodeClientFrame({
        v: 1,
        k: "hello",
        protocol: PROTOCOL_VERSION,
      }),
    );
  }

  private onMessage(data: unknown): void {
    if (data instanceof ArrayBuffer) {
      this.onBinary(new Uint8Array(data));
      return;
    }
    if (ArrayBuffer.isView(data)) {
      this.onBinary(
        new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      );
      return;
    }
    if (typeof data === "string") {
      this.onText(data);
      return;
    }
    this.emitError(
      new BridgeError(
        "BRIDGE_PROTOCOL_ERROR",
        `unexpected frame type: ${Object.prototype.toString.call(data)}`,
      ),
    );
  }

  private onBinary(buf: Uint8Array): void {
    if (!isPaneOutputFrame(buf)) {
      this.emitError(
        new BridgeError(
          "BRIDGE_PROTOCOL_ERROR",
          "unknown binary frame magic",
        ),
      );
      return;
    }
    let msg: TmuxMessage;
    try {
      msg = decodePaneOutput(buf);
    } catch (err) {
      this.emitError(
        err instanceof BridgeError
          ? err
          : new BridgeError(
              "BRIDGE_PROTOCOL_ERROR",
              err instanceof Error ? err.message : String(err),
            ),
      );
      return;
    }
    this.dispatchEvent(msg);
  }

  private onText(raw: string): void {
    let frame: ServerFrame;
    try {
      frame = parseServerFrame(raw);
    } catch (err) {
      this.emitError(
        err instanceof BridgeError
          ? err
          : new BridgeError(
              "BRIDGE_PROTOCOL_ERROR",
              err instanceof Error ? err.message : String(err),
            ),
      );
      return;
    }
    this.handleFrame(frame);
  }

  // [LAW:dataflow-not-control-flow] One indexed lookup; the variant in
  // ServerFrame is what decides which handler runs. Mapped-type table forces
  // exhaustiveness — same shape as VALIDATORS in ../rpc.ts and the
  // CLIENT_FRAME_HANDLERS table on the server side.
  private handleFrame(frame: ServerFrame): void {
    SERVER_FRAME_HANDLERS[frame.k](this, frame as never);
  }

  onWelcome(frame: WelcomeFrame): void {
    this.serverLimits = frame.limits;
    this.attempts = 0;
    this.transition("ready");
    this.startHeartbeat();
    this.flushOutbox();
  }

  onResult(frame: ResultFrame): void {
    const p = this.pending.get(frame.id);
    if (p === undefined) return;
    this.pending.delete(frame.id);
    clearTimeout(p.timer);
    if (frame.ok) {
      p.resolve(frame.response);
    } else {
      p.reject(BridgeError.fromPayload(frame.error));
    }
  }

  onPong(id: string): void {
    if (this.lastPingId !== id || this.pongTimer === null) return;
    clearTimeout(this.pongTimer);
    this.pongTimer = null;
    this.lastPingId = null;
  }

  onDraining(deadlineMs: number): void {
    this.transition("draining");
    this.opts.onDraining?.(deadlineMs);
  }

  dispatchEvent(msg: TmuxMessage): void {
    // TypedEmitter.emit uses `msg.type` to route; it fires the typed channel
    // and the "*" wildcard in one call.
    (this.emitter as unknown as EmitterImpl).emit(msg);
  }

  private onClose(event: { code?: number; reason?: string }): void {
    this.teardownTimers();
    const reason =
      event.reason !== undefined && event.reason.length > 0
        ? event.reason
        : event.code !== undefined
          ? `close ${event.code}`
          : "closed";
    const err = new BridgeError("BRIDGE_CLOSED", reason);
    this.finalizeConnection(err);
  }

  private finalizeConnection(err: BridgeError): void {
    // Reject all pending calls.
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      try {
        p.reject(err);
      } catch {
        // ignore
      }
      this.pending.delete(id);
    }
    this.ws = null;
    this.serverLimits = null;

    if (this.userRequestedClose) {
      this.transition("closed");
      return;
    }

    // Decide whether to reconnect.
    const policy = this.opts.reconnect;
    if (policy === undefined || policy.maxAttempts <= 0) {
      this.transition("closed");
      return;
    }
    if (this.attempts >= policy.maxAttempts) {
      this.emitError(
        new BridgeError(
          "BRIDGE_CLOSED",
          `reconnect gave up after ${policy.maxAttempts} attempts`,
        ),
      );
      this.transition("closed");
      return;
    }
    this.attempts += 1;
    const delay = this.backoffDelay(policy);
    this.transition("reconnecting");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.userRequestedClose) return;
      this.openSocket();
    }, delay);
    (this.reconnectTimer as unknown as { unref?: () => void }).unref?.();
  }

  private backoffDelay(policy: ReconnectPolicy): number {
    const initial = policy.initialDelayMs ?? 250;
    const max = policy.maxDelayMs ?? 10_000;
    const factor = policy.factor ?? 2;
    const jitter = policy.jitterMs ?? 250;
    const base = Math.min(initial * Math.pow(factor, this.attempts - 1), max);
    return base + Math.random() * jitter;
  }

  // -------------------------------------------------------------------------
  // Internal: send + outbox
  // -------------------------------------------------------------------------
  private send(frame: string): void {
    if (this.ws !== null && this.ws.readyState === WEBSOCKET_OPEN) {
      try {
        this.ws.send(frame);
        return;
      } catch {
        // fall through to outbox
      }
    }
    this.outbox.push(frame);
  }

  private flushOutbox(): void {
    if (this.ws === null) return;
    if (this.ws.readyState !== WEBSOCKET_OPEN) return;
    while (this.outbox.length > 0) {
      const frame = this.outbox.shift();
      if (frame === undefined) break;
      try {
        this.ws.send(frame);
      } catch {
        // Put the frame back at the head and stop draining; the next
        // open/ready transition will retry.
        this.outbox.unshift(frame);
        return;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Internal: heartbeats
  // -------------------------------------------------------------------------
  private startHeartbeat(): void {
    const interval =
      this.opts.heartbeatIntervalMs ??
      this.serverLimits?.heartbeatIntervalMs ??
      DEFAULTS.heartbeatIntervalMs;
    if (interval <= 0) return;
    this.heartbeatTimer = setInterval(() => {
      this.sendPing();
    }, interval);
    (this.heartbeatTimer as unknown as { unref?: () => void }).unref?.();
  }

  private sendPing(): void {
    if (this.pongTimer !== null) return;
    const id = this.id();
    this.lastPingId = id;
    this.send(encodeClientFrame({ v: 1, k: "ping", id }));
    const timeout =
      this.opts.heartbeatTimeoutMs ?? DEFAULTS.heartbeatTimeoutMs;
    this.pongTimer = setTimeout(() => {
      // No pong — kill the socket and let the close/reconnect path run.
      this.lastPingId = null;
      this.pongTimer = null;
      try {
        this.ws?.close(4000, "heartbeat timeout");
      } catch {
        // ignore
      }
    }, timeout);
    (this.pongTimer as unknown as { unref?: () => void }).unref?.();
  }

  private teardownTimers(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.pongTimer !== null) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
    this.lastPingId = null;
  }

  // -------------------------------------------------------------------------
  // Internal: state + error emitters
  // -------------------------------------------------------------------------
  private transition(next: WebSocketTmuxClientState): void {
    if (this.currentState === next) return;
    this.currentState = next;
    this.opts.onState?.(next);
  }

  emitError(err: BridgeError): void {
    this.opts.onError?.(err);
  }
}

// ---------------------------------------------------------------------------
// Per-kind ServerFrame handlers.
//
// [LAW:dataflow-not-control-flow] One entry per ServerFrame variant; the
// `handleFrame` dispatcher does a single indexed lookup. Mapped type forces
// exhaustiveness — adding a new ServerFrame kind without a handler is a
// compile-time error, not a runtime "unknown kind" branch.
// [LAW:single-enforcer] WebSocketTmuxClient.handleFrame is the only call site.
// ---------------------------------------------------------------------------

type ServerFrameHandlers = {
  readonly [K in ServerFrame["k"]]: (
    self: WebSocketTmuxClient,
    frame: Extract<ServerFrame, { k: K }>,
  ) => void;
};

const SERVER_FRAME_HANDLERS: ServerFrameHandlers = Object.assign(
  Object.create(null) as ServerFrameHandlers,
  {
    welcome: (self, f: WelcomeFrame) => self.onWelcome(f),
    event: (self, f) => self.dispatchEvent(f.msg as TmuxMessage),
    result: (self, f: ResultFrame) => self.onResult(f),
    pong: (self, f) => self.onPong(f.id),
    draining: (self, f) => self.onDraining(f.deadlineMs),
    error: (self, f) => self.emitError(BridgeError.fromPayload(f.error)),
  } satisfies ServerFrameHandlers,
);
