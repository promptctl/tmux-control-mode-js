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
import {
  isPaneOutput,
  type CommandResponse,
  type PaneAction,
  type TmuxMessage,
} from "../../protocol/types.js";
import type { SplitOptions, TmuxConnection } from "../../client.js";

import type { RpcProxyApi } from "../rpc.js";
import { type AttachOptions, type BytesSink } from "../../pane-output.js";
import { TopologyRouter } from "../../topology-router.js";
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

export class WebSocketTmuxClient implements RpcProxyApi, TmuxConnection {
  private readonly emitter = new TypedEmitter();
  // [LAW:one-source-of-truth] All byte routing, topology, and bootstrap logic
  //   lives in TopologyRouter. This client injects execute() as the command runner.
  // [LAW:effects-at-boundaries] The router describes a bootstrap failure; this
  //   adapter performs the emission (emitter is declared above, so its
  //   initializer has already run when this one does).
  private readonly router = new TopologyRouter((error) =>
    this.emitter.emit({ type: "topology-error", error }),
  );
  private readonly pending = new Map<string, Pending>();

  private ws: BrowserWebSocketLike | null = null;
  // [LAW:single-enforcer] One controller per connection scopes the lifetime
  // of every listener attached to its ws. finalizeConnection aborts it; the
  // ws library removes all listeners in one operation. No per-listener
  // staleness check exists or is needed.
  private connectionAbort: AbortController | null = null;
  private nextId = 0;
  private attempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPingId: string | null = null;
  private serverLimits: WelcomeLimits | null = null;
  private userRequestedClose = false;
  // [LAW:one-source-of-truth] Single ConnectionState field — sole authority
  // for all connection state. setConnectionState() is the only writer.
  private currentConnectionState: ConnectionState = { status: "connecting" };
  // [LAW:one-source-of-truth] A server-announced drain is a fact about the
  // server's intent, not a lifecycle phase of this connection — the unified
  // ConnectionState deliberately has no draining variant. The socket stays
  // open (status "ready") until the server actually closes it; this flag
  // only gates new calls. Connection-scoped: finalizeConnection clears it,
  // so a drain notice never outlives the connection that carried it.
  private draining = false;
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
  get connectionState(): ConnectionState {
    return this.currentConnectionState;
  }

  // -------------------------------------------------------------------------
  // Connection lifecycle
  // -------------------------------------------------------------------------
  async connect(): Promise<void> {
    // [LAW:one-source-of-truth] Gate on the physical connection facts — a
    // live socket or an armed retry timer — not on connectionState. The
    // initial state is "connecting" before any socket exists (the unified
    // union has no idle variant), so a status guard would make connect() a
    // permanent no-op under autoConnect: false.
    // [LAW:no-ambient-temporal-coupling] During reconnect backoff the timer
    // owns the retry; the timer check keeps a manual connect() from opening
    // a second socket underneath it.
    if (this.ws !== null || this.reconnectTimer !== null) {
      return;
    }
    this.userRequestedClose = false;
    // [LAW:no-ambient-temporal-coupling] connect() is the consumer-initiated
    // episode boundary: the retry budget and the episode's error belong to
    // the previous episode and must not leak into this one. openSocket() is
    // NOT the reset point — the reconnect timer also calls it, and resetting
    // there would make maxAttempts unreachable.
    this.attempts = 0;
    this.lastError = undefined;
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
  // Event subscription — matches TmuxClient.on / off exactly.
  //
  // `TmuxEventMap` does not contain `'output'` or `'extended-output'`;
  // pane bytes flow through `attachBytesSink` only.
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

  // [LAW:one-source-of-truth] All sink registration, topology bootstrap,
  //   and scope dispatch is owned by TopologyRouter — no duplication here.
  attachBytesSink(sink: BytesSink, options?: AttachOptions): () => void {
    return this.router.attachBytesSink(sink, options);
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
    if (
      this.currentConnectionState.status === "closed" ||
      this.userRequestedClose
    ) {
      return Promise.reject(
        new BridgeError("BRIDGE_CLOSED", "client is closed"),
      );
    }
    if (this.draining) {
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
    this.setConnectionState({ status: "connecting" });
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
    this.setConnectionState({ status: "ready" });
    this.startHeartbeat();
    this.flushOutbox();
    // [LAW:one-source-of-truth] TopologyRouter owns bootstrap and sink-registry management.
    //   Called after setConnectionState("ready") so execute() accepts calls from within bootstrap.
    this.router.onTransportReady((cmd) => this.execute(cmd));
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
    // The server keeps serving in-flight calls until the deadline, so the
    // connection stays "ready"; only new calls are refused (see call()).
    this.draining = true;
    this.opts.onDraining?.(deadlineMs);
  }

  dispatchEvent(msg: TmuxMessage): void {
    // [LAW:single-enforcer] Pane bytes flow exclusively through the router's
    //   byte-dispatch path. ChunkPayload strips wire discriminator fields before
    //   dispatch — sinks receive only {paneId, data}.
    if (isPaneOutput(msg)) {
      this.router.dispatchBytes({ paneId: msg.paneId, data: msg.data });
      return;
    }
    // [LAW:one-source-of-truth] Topology mutations live in TopologyRouter.
    //   This adapter remains unaware of topology update logic.
    this.router.handleNotification(msg);
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
    // that follows hits this guard and returns.
    // [LAW:one-source-of-truth] The guard derives from the one state field:
    // "closed" is exactly the condition under which a second finalize must
    // be a no-op; openSocket() re-arms by entering "connecting".
    if (this.currentConnectionState.status === "closed") return;

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
    // The drain notice was scoped to the connection that just ended; calls
    // made during reconnect backoff must queue for the new connection, not
    // be refused with a stale drain reason.
    this.draining = false;

    if (this.userRequestedClose) {
      // [LAW:no-ambient-temporal-coupling] Permanent close: end all sinks and
      //   clear runCommand. NOT called on reconnect — sinks survive reconnect.
      this.router.onTransportClose();
      this.setConnectionState({ status: "closed", reason: "disposed" });
      return;
    }

    // Decide whether to reconnect.
    const policy = this.opts.reconnect;
    if (policy === undefined || policy.maxAttempts <= 0) {
      this.router.onTransportClose();
      // [LAW:one-source-of-truth] lastError distinguishes an error-driven
      // close from a clean exit; onWelcome clears it on entry into ready.
      this.setConnectionState({
        status: "closed",
        reason: this.lastError !== undefined ? "transport-error" : "exit",
      });
      return;
    }
    if (this.attempts >= policy.maxAttempts) {
      this.emitError(
        new BridgeError(
          "BRIDGE_CLOSED",
          `reconnect gave up after ${policy.maxAttempts} attempts`,
        ),
      );
      this.router.onTransportClose();
      this.setConnectionState({ status: "closed", reason: "transport-error" });
      return;
    }
    this.attempts += 1;
    const delay = this.backoffDelay(policy);
    this.setConnectionState({
      status: "reconnecting",
      attempt: this.attempts,
      ...(this.lastError !== undefined ? { lastError: this.lastError } : {}),
    });
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
  // [LAW:one-source-of-truth] The gate is `connectionState.status === "ready"`,
  // not just `ws.readyState === OPEN`. The ws may be OPEN in the brief window
  // between onOpen and onWelcome, but the server rejects any non-hello frame
  // while it is pending-hello (server.ts) and would close the connection with
  // a protocol error. "ready" is the canonical "handshake complete, server
  // accepting calls" predicate; checking ws.readyState is a belt-and-
  // suspenders sanity check after that.
  private transmit(p: Pending): void {
    if (p.transmitted) return;
    if (this.currentConnectionState.status !== "ready") return;
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

  // [LAW:one-source-of-truth] Sole writer for currentConnectionState. Emits
  // the connection-state event and the reconnected event when transitioning
  // into ready for the second or later time.
  private setConnectionState(next: ConnectionState): void {
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
  }

  emitError(err: BridgeError): void {
    this.lastError = err;
    this.opts.onError?.(err);
    // Re-publish so a reconnecting state's lastError reflects the latest error.
    if (this.currentConnectionState.status === "reconnecting") {
      this.setConnectionState({
        status: "reconnecting",
        attempt: this.attempts,
        lastError: err,
      });
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
