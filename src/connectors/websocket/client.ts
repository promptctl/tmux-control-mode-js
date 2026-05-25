// src/connectors/websocket/client.ts
// WebSocket bridge — browser side.
//
// `WebSocketTmuxClient` exposes the bridged subset of `TmuxClient` — every
// method on `RpcProxyApi` (derived from `RpcRequest`) is implemented as a
// Promise that rides the bridge. The class declares `implements RpcProxyApi`
// so adding a new RpcRequest variant on the wire is a compile error here
// until the proxy method is added too. The full TmuxClient surface (e.g.
// admin operations like `detach()` and any non-bridged helpers) is NOT
// proxied — those stay server-side by design.
//
// Production-oriented behaviors baked in:
//   - hello/welcome handshake
//   - request timeouts (per-call deadline surfaced as typed BridgeError)
//   - app-level ping/pong heartbeats (complements transport-level WS pings,
//     which browsers hide from userland)
//   - outbound queue during connection setup and reconnection
//   - reconnect with exponential backoff + jitter (opt-in)
//   - typed BridgeError rejections — consumers branch on `error.code`
//   - graceful `draining` handling: no new calls accepted after drain signal
//
// [LAW:one-source-of-truth] Request correlation lives in `pending`, period.
// The same `pending` Map is also the queue of un-transmitted call frames —
// each Pending carries its encoded frame and a `transmitted` flag. No
// separate outbox exists, because two structures that must agree are an
// invariant the type cannot enforce; one structure makes drift impossible.
// [LAW:single-enforcer] `finalizeConnection` is the only cleanup site; every
// close/error/reconnect flows through it. Teardown timers + pending rejection
// live there together so callers cannot observe a half-closed client.

import {
  sameConnectionState,
  type ConnectionState,
} from "../../connection-state.js";
import {
  TypedEmitter,
  type EmitterMessage,
  type TmuxEventMap,
} from "../../emitter.js";

// Internal structural view of TypedEmitter's untyped implementation signature.
// TypedEmitter's public API uses typed overloads; the WebSocket client deals
// in strings (method name → event name) and needs to invoke the underlying
// implementation signature without re-implementing the overload set.
interface EmitterImpl {
  on(event: string, handler: (ev: never) => void): void;
  off(event: string, handler: (ev: never) => void): void;
  emit(msg: EmitterMessage): void;
}
import type {
  CommandResponse,
  PaneAction,
  TmuxMessage,
} from "../../protocol/types.js";
import type { SplitOptions } from "../../client.js";

import type { RpcProxyApi } from "../rpc.js";
import type { TmuxClientLike } from "../../client.js";
import {
  attachPaneSinkViaEmitter,
  type PaneByteSink,
} from "../../pane-sink.js";
import {
  BridgeError,
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

import type { BrowserWebSocketLike, ReconnectPolicy } from "./types.js";
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

// [LAW:one-source-of-truth] A Pending entry IS the queue entry. `frame` is
// the encoded wire frame, re-sendable on reconnect; `transmitted` flips to
// true the moment the underlying ws accepts the frame. flushOutbox iterates
// pending in insertion order (FIFO) and re-tries any entry still untransmitted.
// finalizeConnection clears the whole Map in one operation — there is no
// second structure that can drift out of sync.
interface Pending {
  readonly method: RpcMethod;
  readonly frame: string;
  resolve(r: CommandResponse): void;
  reject(e: BridgeError): void;
  timer: ReturnType<typeof setTimeout>;
  transmitted: boolean;
}

export class WebSocketTmuxClient implements RpcProxyApi, TmuxClientLike {
  private readonly emitter = new TypedEmitter();
  private readonly pending = new Map<string, Pending>();

  private ws: BrowserWebSocketLike | null = null;
  // [LAW:single-enforcer] One controller per connection scopes the lifetime
  // of every listener attached to its ws. finalizeConnection aborts it; the
  // ws library removes all listeners in one operation. No per-listener
  // staleness check exists or is needed.
  private connectionAbort: AbortController | null = null;
  private nextId = 0;
  private currentState: WebSocketTmuxClientState = "idle";
  private attempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPingId: string | null = null;
  private serverLimits: WelcomeLimits | null = null;
  private userRequestedClose = false;
  // [LAW:one-source-of-truth] Unified ConnectionState lives here; the legacy
  // `currentState` (WebSocketTmuxClientState) maps onto it via mapToUnified
  // and stays available through the @deprecated `state` getter for one minor.
  private currentConnectionState: ConnectionState = { status: "connecting" };
  private hasReachedReadyOnce = false;
  private lastError: Error | undefined = undefined;

  constructor(private readonly opts: WebSocketTmuxClientOptions) {
    if (opts.autoConnect ?? true) {
      void this.connect();
    }
  }

  // -------------------------------------------------------------------------
  // Public state
  // -------------------------------------------------------------------------
  /**
   * @deprecated Use `connectionState` instead. The legacy
   * `WebSocketTmuxClientState` exposes connector-internal state names that
   * differ across transports; `ConnectionState` is the unified shape every
   * `TmuxClient`-shaped class produces. Will be removed in the next minor.
   */
  get state(): WebSocketTmuxClientState {
    return this.currentState;
  }

  get connectionState(): ConnectionState {
    return this.currentConnectionState;
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
    // [LAW:one-source-of-truth] Contract: when this resolves, no pending
    // promise remains in flight. The pre-fix bug (M3) left pending alive
    // until the async ws.onclose fired, giving callers a window where
    // `await client.close()` returned but their promises were unsettled.
    // Driving finalize inline closes that window; the later ws.onclose hits
    // finalize's idempotency guard and returns.
    this.userRequestedClose = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    // rawSend gates on OPEN internally — bye only goes on a live socket.
    this.rawSend(encodeClientFrame({ k: "bye" }));
    // [LAW:single-enforcer] Abort the underlying socket regardless of
    // readyState. ws.close() on a CONNECTING socket aborts the handshake
    // per the WebSocket spec; without this, a close() during CONNECTING
    // left the underlying socket alive, and its eventual open event would
    // still fire — the per-socket stale guard in openSocket() catches it
    // defensively, but freeing the underlying resource is the right move.
    if (this.ws !== null) {
      try {
        this.ws.close(1000, "client close");
      } catch {
        // ignore
      }
    }
    this.finalizeConnection(new BridgeError("BRIDGE_CLOSED", "client close"));
  }

  // -------------------------------------------------------------------------
  // Event subscription — matches TmuxClient.on / off exactly
  // -------------------------------------------------------------------------
  on<K extends keyof TmuxEventMap>(
    event: K,
    handler: (ev: TmuxEventMap[K]) => void,
  ): void;
  on(event: "*", handler: (ev: EmitterMessage) => void): void;
  on(event: string, handler: (ev: never) => void): void {
    (this.emitter as unknown as EmitterImpl).on(event, handler);
  }

  off<K extends keyof TmuxEventMap>(
    event: K,
    handler: (ev: TmuxEventMap[K]) => void,
  ): void;
  off(event: "*", handler: (ev: EmitterMessage) => void): void;
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

  setPaneAction(paneId: number, action: PaneAction): Promise<CommandResponse> {
    return this.call("setPaneAction", [paneId, action]);
  }

  subscribeRaw(
    name: string,
    what: string,
    format: string,
  ): Promise<CommandResponse> {
    return this.call("subscribeRaw", [name, what, format]);
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

  // [LAW:locality-or-seam] WS pane-output frames arrive as parsed
  //   `output` / `extended-output` messages dispatched through the emitter
  //   (see `onBinary` → `dispatchEvent`). The emitter is therefore the byte
  //   fan-out point and `attachPaneSinkViaEmitter` is the canonical adapter
  //   onto the `PaneByteSink` seam — the same one every emitter-backed
  //   bridge uses.
  // [LAW:single-enforcer] One implementation across all emitter-backed
  //   clients. No parallel registry.
  attachPaneSink(paneId: number, sink: PaneByteSink): () => void {
    return attachPaneSinkViaEmitter(this, paneId, sink);
  }

  // detach() is intentionally NOT exposed: it tears down the tmux client for
  // every browser sharing the bridge, which is an admin operation owned by
  // the server-side host. Browsers can `close()` to drop their own session.

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
    const frame = encodeClientFrame({ k: "call", id, method, args });
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

      const entry: Pending = {
        method,
        frame,
        resolve,
        reject,
        timer,
        transmitted: false,
      };
      this.pending.set(id, entry);
      this.transmit(entry);
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
        new (
          globalThis as {
            WebSocket: new (
              url: string,
              protocols?: string | string[],
            ) => BrowserWebSocketLike;
          }
        ).WebSocket(url, subprotocol));
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
    // [LAW:locality-or-seam] AbortSignal IS the seam binding listener
    // lifetime to connection lifetime. Aborted by finalizeConnection;
    // the ws library removes every listener atomically.
    // [LAW:dataflow-not-control-flow] No `if (stale) return` guard in any
    // listener — the variability ("is this socket still attached") lives
    // in the AbortSignal's state, not in branching inside each handler.
    const abort = new AbortController();
    this.connectionAbort = abort;
    const opts = { signal: abort.signal };

    ws.addEventListener("open", () => this.onOpen(), opts);
    ws.addEventListener(
      "message",
      (event: { data: unknown }) => this.onMessage(event.data),
      opts,
    );
    ws.addEventListener(
      "close",
      (event: { code?: number; reason?: string }) => this.onClose(event),
      opts,
    );
    ws.addEventListener(
      "error",
      // Error events in the browser are opaque. Treat as a connection error;
      // the 'close' that follows will drive the actual teardown.
      () =>
        this.emitError(new BridgeError("BRIDGE_INTERNAL", "websocket error")),
      opts,
    );
  }

  private onOpen(): void {
    this.transition("open");
    this.rawSend(encodeClientFrame({ k: "hello" }));
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
        new BridgeError("BRIDGE_PROTOCOL_ERROR", "unknown binary frame magic"),
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
    // [LAW:one-source-of-truth] lastError describes the current reconnecting
    // episode only. Wiping it on entry into ready means any *subsequent* close
    // maps from a clean slate — a clean exit can't be misreported as
    // transport-error because of a stale error from before the last reconnect.
    this.lastError = undefined;
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
    // [LAW:single-enforcer] Idempotency guard. close() calls finalize
    // synchronously to settle pending before returning; the async ws.onclose
    // that follows hits this guard and returns. Also makes finalize safe to
    // call from any state without checking "did the socket already close".
    if (this.currentState === "closed") return;

    // [LAW:single-enforcer] One operation tears down everything connection-
    // scoped: listeners (via AbortController), timers, pending, ws ref.
    // The abort happens first because it severs the inbound event stream
    // — no late event can re-enter the client through the closure-bound
    // `this` after this line.
    if (this.connectionAbort !== null) {
      this.connectionAbort.abort();
      this.connectionAbort = null;
    }
    this.teardownTimers();

    // [LAW:one-source-of-truth] pending is the only structure holding
    // in-flight calls or queued frames; clearing it drops both. The
    // pre-fix bug (M2) was a separate outbox surviving this loop, then
    // re-sending frames whose pending was already rejected.
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
  // Internal: send paths
  //
  // Two send paths exist because frames have different lifecycles:
  //   - Call frames carry a pending caller. They must persist across
  //     reconnect attempts until either delivered or finalized. They live
  //     on the Pending entry and are transmitted via `transmit()`.
  //   - Hello / ping / bye are connection-scoped fire-and-forget. They
  //     make no sense across a connection boundary (a stale hello on a new
  //     socket would be a protocol error; a stale ping would corrupt the
  //     pong correlation). They go through `rawSend()` and are dropped if
  //     the socket is not OPEN — the next reconnect emits fresh ones.
  // -------------------------------------------------------------------------

  // [LAW:single-enforcer] Sole transmitter of call frames. transmitted=true
  // means the ws has accepted the frame; finalize will still reject the
  // pending caller if the server never replies, but the frame is not
  // re-sent on reconnect because the caller is already gone by then.
  //
  // [LAW:one-source-of-truth] The gate is `state === "ready"`, not just
  // `ws.readyState === OPEN`. The ws may be OPEN in the brief window
  // between onOpen (transition to "open") and onWelcome (transition to
  // "ready"), but the server rejects any non-hello frame while it is
  // pending-hello (server.ts:423) and would close the connection with a
  // protocol error. "ready" is the canonical "handshake complete, server
  // accepting calls" predicate; checking ws.readyState is a belt-and-
  // suspenders sanity check after that.
  private transmit(p: Pending): void {
    if (p.transmitted) return;
    if (this.currentState !== "ready") return;
    if (this.ws === null || this.ws.readyState !== WEBSOCKET_OPEN) return;
    try {
      this.ws.send(p.frame);
      p.transmitted = true;
    } catch {
      // Stays untransmitted; flushOutbox will retry on next ready transition.
    }
  }

  // [LAW:dataflow-not-control-flow] Same loop every call: walk pending in
  // FIFO order, ask `transmit` to send each entry. If `transmit` cannot
  // deliver (send threw inside its own try/catch, so p.transmitted stays
  // false), stop — preserving FIFO ordering for the next ready transition.
  private flushOutbox(): void {
    if (this.ws === null || this.ws.readyState !== WEBSOCKET_OPEN) return;
    for (const p of this.pending.values()) {
      this.transmit(p);
      if (!p.transmitted) return;
    }
  }

  // Fire-and-forget for hello/ping/bye. No retry, no queue — if the socket
  // is not OPEN the frame is simply dropped. The caller (onOpen / sendPing /
  // close) treats success as best-effort.
  private rawSend(frame: string): void {
    if (this.ws === null || this.ws.readyState !== WEBSOCKET_OPEN) return;
    try {
      this.ws.send(frame);
    } catch {
      // ignore — connection-scoped failure surfaces via onClose.
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
    this.rawSend(encodeClientFrame({ k: "ping", id }));
    const timeout = this.opts.heartbeatTimeoutMs ?? DEFAULTS.heartbeatTimeoutMs;
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
    this.publishUnified();
  }

  emitError(err: BridgeError): void {
    this.lastError = err;
    this.opts.onError?.(err);
    // Re-publish so a reconnecting state's lastError reflects the latest error
    // even when the legacy state didn't change.
    this.publishUnified();
  }

  // [LAW:one-source-of-truth] Single mapping from the legacy state machine
  // onto the unified ConnectionState. Called after every legacy transition
  // and after every emitError so the unified shape stays in lock-step.
  private publishUnified(): void {
    const next = this.mapToUnified();
    if (sameConnectionState(this.currentConnectionState, next)) return;
    this.currentConnectionState = next;
    this.emitter.emit({ type: "connection-state", state: next });
    if (next.status === "ready") {
      // [LAW:one-source-of-truth] 'reconnected' fires on every transition into
      // ready AFTER the first such transition — not just from "reconnecting".
      // Manual close→connect cycles count as a reconnect.
      if (this.hasReachedReadyOnce) {
        this.emitter.emit({ type: "reconnected" });
      } else {
        this.hasReachedReadyOnce = true;
      }
    }
    // lastError lifetime is owned by onWelcome (cleared on entry into ready).
    // Any error while in ready/reconnecting is the cause of the *current*
    // episode and is consumed by mapToUnified for closed-reason disambiguation.
  }

  private mapToUnified(): ConnectionState {
    switch (this.currentState) {
      case "idle":
      case "connecting":
      case "open":
        return { status: "connecting" };
      case "ready":
        return { status: "ready" };
      case "reconnecting":
        return this.lastError !== undefined
          ? {
              status: "reconnecting",
              attempt: this.attempts,
              lastError: this.lastError,
            }
          : { status: "reconnecting", attempt: this.attempts };
      case "draining":
      case "closed":
        return {
          status: "closed",
          reason: this.userRequestedClose
            ? "disposed"
            : this.lastError !== undefined
              ? "transport-error"
              : "exit",
        };
    }
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
