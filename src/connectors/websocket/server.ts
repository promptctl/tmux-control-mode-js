// src/connectors/websocket/server.ts
// WebSocket bridge — server side.
//
// `createWebSocketBridge({createClient, ...hooks})` returns an object whose
// `handleConnection(ws, req)` method plugs an upgraded WebSocket into a
// TmuxClient and speaks the wire protocol defined in `./protocol.ts`.
//
// Library responsibilities:
//   - Negotiate `hello`/`welcome` handshake; reject wrong protocol versions.
//   - Route RPC calls from the browser into TmuxClient methods.
//   - Fan out TmuxClient events back to the browser (pane output as binary).
//   - Enforce request timeouts, max in-flight, rate limits, heartbeats.
//   - Call authenticate() and authorize() at the right moments — the hooks
//     are the only place policy lives; the library provides the seam.
//   - Translate TmuxClient failures into structured BridgeError payloads.
//   - Drain on shutdown: stop accepting new calls, let pending complete,
//     then close every live connection.
//
// What the bridge is NOT responsible for:
//   - Creating the WebSocket server. Consumers bring `ws` (or any impl) and
//     hand us the upgraded socket plus the HTTP request.
//   - Deciding who may connect — that's `authenticate()`.
//   - Deciding which commands are safe — that's `authorize()`.
//   - Closing the TmuxClient — by default the bridge does not close it, so
//     shared TmuxClients just work. Pass `disposeClient` to override.
//
// [LAW:one-source-of-truth] This file owns per-connection state. The
// dispatch table, the pending-call map, the rate-limit window, and the
// heartbeat timers live here and nowhere else.
// [LAW:single-enforcer] Exactly one place (`finalize`) tears a connection
// down. Every error path funnels through it.

import type { TmuxClient } from "../../client.js";
import { isTmuxMessage, type EmitterMessage } from "../../emitter.js";
import { TmuxCommandError } from "../../errors.js";
import {
  isPaneOutput,
  type CommandResponse,
  type TmuxMessage,
} from "../../protocol/types.js";

import {
  BridgeError,
  BridgeProtocolError,
  PROTOCOL_VERSION,
  encodePaneOutput,
  encodeServerFrame,
  parseClientFrame,
  type BridgeErrorCode,
  type CallFrame,
  type ClientFrame,
  type ServerFrame,
} from "./protocol.js";

import {
  parseRpcRequest,
  RpcError,
  type RpcErrorCode,
  type RpcRequest,
} from "../rpc.js";
import { dispatchRpcRequest } from "../rpc-dispatch.js";
import {
  createBridgeConnection,
  DEFAULT_OUTPUT_LOW_WATERMARK,
  type BridgeConnection,
  type Peer,
} from "../bridge-connection.js";

import type {
  AuthResult,
  AuthorizeRequest,
  AuthorizeResult,
  BridgeObservabilityEvent,
  ConnectionIdentity,
  RateLimitConfig,
  ServerWebSocketLike,
  UpgradeRequest,
} from "./types.js";
import { WEBSOCKET_OPEN } from "./types.js";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULTS = Object.freeze({
  heartbeatIntervalMs: 30_000,
  heartbeatTimeoutMs: 10_000,
  requestTimeoutMs: 30_000,
  helloTimeoutMs: 5_000,
  maxInflight: 64,
}) satisfies {
  readonly heartbeatIntervalMs: number;
  readonly heartbeatTimeoutMs: number;
  readonly requestTimeoutMs: number;
  readonly helloTimeoutMs: number;
  readonly maxInflight: number;
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ConnectionContext {
  readonly identity: ConnectionIdentity;
  readonly request?: UpgradeRequest;
}

export interface WebSocketBridgeOptions {
  /** Produce (or look up) the TmuxClient backing a new connection. */
  readonly createClient: (
    ctx: ConnectionContext,
  ) => Promise<TmuxClient> | TmuxClient;

  /**
   * Dispose the TmuxClient after the connection closes. Default: no-op, so a
   * shared `TmuxClient` survives connection churn. Override when each
   * connection owns its own `TmuxClient`.
   */
  readonly disposeClient?: (
    client: TmuxClient,
    ctx: ConnectionContext,
  ) => Promise<void> | void;

  /** Pre-handshake auth. Default: accept all. */
  readonly authenticate?: (
    req: UpgradeRequest,
  ) => Promise<AuthResult> | AuthResult;

  /** Per-call authorization. Default: allow all. */
  readonly authorize?: (
    req: AuthorizeRequest,
  ) => Promise<AuthorizeResult> | AuthorizeResult;

  /** Sliding-window rate limit per connection. Default: unlimited. */
  readonly rateLimit?: RateLimitConfig;

  readonly heartbeatIntervalMs?: number;
  readonly heartbeatTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly maxInflight?: number;

  /**
   * Per-pane outstanding-byte threshold (summed across all peers connected
   * to the same TmuxClient) at which the bridge issues
   * `setPaneAction(paneId, Pause)`. The threshold is also tripped by the
   * underlying `ws.bufferedAmount` exceeding it for connections whose OS
   * send buffer is filling up — without a per-call ack frame in protocol
   * v1, `bufferedAmount` is the only "in-flight bytes" signal the WS path
   * can read. Default: 1 MiB (see `DEFAULT_OUTPUT_HIGH_WATERMARK`).
   */
  readonly outputHighWatermark?: number;
  /**
   * Per-pane outstanding-byte threshold at which a paused pane is resumed.
   * Must be < `outputHighWatermark`. Also serves as the
   * `ws.bufferedAmount` threshold below which the bridge treats the OS
   * send buffer as drained (and clears that peer's outstanding accounting,
   * triggering resume). Default: 256 KiB.
   */
  readonly outputLowWatermark?: number;

  /** Observability hook fired for every notable event. */
  readonly onEvent?: (ev: BridgeObservabilityEvent) => void;
}

export interface WebSocketBridge {
  /**
   * Take ownership of an upgraded WebSocket. The returned promise resolves
   * when the connection closes (normally or with a fatal error).
   */
  handleConnection(
    ws: ServerWebSocketLike,
    request?: UpgradeRequest,
  ): Promise<void>;

  /**
   * Begin graceful shutdown. Every live connection is told to drain;
   * new connections are rejected. Resolves once all connections close or
   * `drainMs` elapses (after which sockets are force-terminated).
   */
  shutdown(drainMs?: number): Promise<void>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export function createWebSocketBridge(
  opts: WebSocketBridgeOptions,
): WebSocketBridge {
  const defaults = resolveDefaults(opts);
  const connections = new Set<Connection>();
  let draining = false;

  async function handleConnection(
    ws: ServerWebSocketLike,
    request?: UpgradeRequest,
  ): Promise<void> {
    if (draining) {
      sendFatal(ws, "BRIDGE_CLOSED", "bridge is shutting down");
      ws.close(1001, "shutting down");
      return;
    }

    const conn = new Connection(ws, request, opts, defaults);
    connections.add(conn);
    try {
      await conn.run();
    } finally {
      connections.delete(conn);
    }
  }

  async function shutdown(drainMs = 10_000): Promise<void> {
    draining = true;
    const deadlineMs = Date.now() + drainMs;
    for (const conn of connections) {
      conn.beginDrain(deadlineMs);
    }
    await Promise.race([
      allClosed(connections),
      new Promise<void>((r) => setTimeout(r, drainMs).unref?.()),
    ]);
    for (const conn of connections) conn.terminate();
  }

  return { handleConnection, shutdown };
}

// ---------------------------------------------------------------------------
// Connection state machine
//
// [LAW:dataflow-not-control-flow] State is a discriminated union, not an
// enum + nullable side-data. The only path to a TmuxClient reference is
// through the `running`/`draining` variants; the type system makes
// `client === null` unrepresentable inside `onCall`. The previous shape
// (nullable `client` + `phase` enum + a defensive `if (client === null)`
// "invariant violation" guard) is gone — the invariant lives on the type.
// ---------------------------------------------------------------------------

type ConnectionState =
  /** No hello received yet; no client. Initial state. */
  | { readonly kind: "pending-hello" }
  /** Hello accepted, client created, accepting calls. */
  | {
      readonly kind: "running";
      readonly client: TmuxClient;
      readonly ctx: ConnectionContext;
      /** Shared bookkeeping: subscription refcount + per-pane outstanding
       *  bytes. The connection acts as a single peer inside this helper —
       *  every subscribe/unsubscribe and every pane-output send routes
       *  through the same instance the Electron bridge uses. */
      readonly bridge: BridgeConnection;
      readonly peer: Peer;
    }
  /** Drain initiated; existing in-flight calls finish, new calls rejected. */
  | {
      readonly kind: "draining";
      readonly client: TmuxClient;
      readonly ctx: ConnectionContext;
      readonly bridge: BridgeConnection;
      readonly peer: Peer;
      readonly deadlineMs: number;
    }
  /**
   * Terminal state. `final` is the (client, ctx, bridge, peer) captured at
   * finalize time if we ever reached running; null if we closed before
   * hello, in which case there is no client to dispose and no bridge to
   * tear down.
   */
  | {
      readonly kind: "closed";
      readonly final: {
        readonly client: TmuxClient;
        readonly ctx: ConnectionContext;
        readonly bridge: BridgeConnection;
        readonly peer: Peer;
      } | null;
    };

type RunningState = Extract<ConnectionState, { kind: "running" }>;

interface ResolvedDefaults {
  readonly heartbeatIntervalMs: number;
  readonly heartbeatTimeoutMs: number;
  readonly requestTimeoutMs: number;
  readonly helloTimeoutMs: number;
  readonly maxInflight: number;
}

function resolveDefaults(opts: WebSocketBridgeOptions): ResolvedDefaults {
  return {
    heartbeatIntervalMs:
      opts.heartbeatIntervalMs ?? DEFAULTS.heartbeatIntervalMs,
    heartbeatTimeoutMs: opts.heartbeatTimeoutMs ?? DEFAULTS.heartbeatTimeoutMs,
    requestTimeoutMs: opts.requestTimeoutMs ?? DEFAULTS.requestTimeoutMs,
    helloTimeoutMs: DEFAULTS.helloTimeoutMs,
    maxInflight: opts.maxInflight ?? DEFAULTS.maxInflight,
  };
}

class Connection {
  // [LAW:one-source-of-truth] Single state field; (client, ctx) live inside
  // the variant that needs them, not as parallel nullable fields.
  private state: ConnectionState = { kind: "pending-hello" };
  private identity: ConnectionIdentity = undefined;

  private readonly inflight = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; startedAt: number }
  >();
  private readonly rateWindow: number[] = [];

  private readonly onAnyEventRef: (msg: EmitterMessage) => void;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pongDeadline: ReturnType<typeof setTimeout> | null = null;
  private helloDeadline: ReturnType<typeof setTimeout> | null = null;

  private closed!: () => void;
  readonly whenClosed: Promise<void> = new Promise<void>((resolve) => {
    this.closed = resolve;
  });

  constructor(
    private readonly ws: ServerWebSocketLike,
    private readonly request: UpgradeRequest | undefined,
    private readonly opts: WebSocketBridgeOptions,
    private readonly defaults: ResolvedDefaults,
  ) {
    // The WS server forwards parsed tmux events over the wire; synthetic
    // lifecycle events are bridge-internal and the peer has its own
    // connection-state via the welcome handshake.
    this.onAnyEventRef = (msg: EmitterMessage): void => {
      if (isTmuxMessage(msg)) this.onTmuxEvent(msg);
    };
  }

  async run(): Promise<void> {
    this.installWsListeners();
    this.helloDeadline = setTimeout(() => {
      this.sendFatalAndClose(
        "BRIDGE_PROTOCOL_ERROR",
        `no hello frame within ${this.defaults.helloTimeoutMs}ms`,
      );
    }, this.defaults.helloTimeoutMs);
    this.helloDeadline.unref?.();
    await this.whenClosed;
  }

  // -------------------------------------------------------------------------
  // WS event wiring
  //
  // [LAW:dataflow-not-control-flow] Same pipeline on every frame: parse →
  // dispatch. The dispatch table branches on typed discriminators, not raw
  // strings. Binary frames are rejected — the protocol has no client→server
  // binary messages in v1.
  // -------------------------------------------------------------------------
  private installWsListeners(): void {
    this.ws.on("message", (data: unknown, isBinary: boolean) => {
      if (isBinary) {
        this.sendFatalAndClose(
          "BRIDGE_PROTOCOL_ERROR",
          "binary frames are not accepted from the client in protocol v1",
        );
        return;
      }
      const text =
        typeof data === "string"
          ? data
          : data instanceof Uint8Array
            ? new TextDecoder().decode(data)
            : String(data);
      this.onFrame(text);
    });

    this.ws.on("close", (code: number, reason: Buffer | string) => {
      this.finalize(undefined, {
        code,
        reason: typeof reason === "string" ? reason : reason.toString("utf8"),
      });
    });

    this.ws.on("error", (err: Error) => {
      this.finalize(
        new BridgeError("BRIDGE_INTERNAL", `socket error: ${err.message}`),
        undefined,
      );
    });

    this.ws.on("pong", () => {
      // Peer is alive — clear any outstanding pong deadline.
      if (this.pongDeadline !== null) {
        clearTimeout(this.pongDeadline);
        this.pongDeadline = null;
      }
    });

    this.ws.on("ping", () => {
      // `ws` auto-replies with pong by default, but defending against
      // surprising implementations is cheap.
    });
  }

  private onFrame(raw: string): void {
    if (this.state.kind === "closed") return;
    let frame: ClientFrame;
    try {
      frame = parseClientFrame(raw);
    } catch (err) {
      const msg =
        err instanceof BridgeProtocolError
          ? err.message
          : `protocol error: ${err instanceof Error ? err.message : String(err)}`;
      this.emit({
        kind: "protocol-error",
        identity: this.identity,
        message: msg,
      });
      this.sendFatalAndClose("BRIDGE_PROTOCOL_ERROR", msg);
      return;
    }
    this.dispatch(frame);
  }

  private dispatch(frame: ClientFrame): void {
    // Hello is the one frame allowed pre-hello; this single guard is the only
    // load-bearing protocol invariant left in this function. Everything else
    // is absorbed by CLIENT_FRAME_HANDLERS below.
    if (frame.k !== "hello" && this.state.kind === "pending-hello") {
      this.sendFatalAndClose(
        "BRIDGE_PROTOCOL_ERROR",
        `received '${frame.k}' before hello`,
      );
      return;
    }
    CLIENT_FRAME_HANDLERS[frame.k](this, frame as never);
  }

  // [LAW:dataflow-not-control-flow] Per-kind handlers. State narrowing for
  // `call` happens in routeCall, the only place that needs it.
  routeCall(frame: CallFrame): void {
    if (this.state.kind === "draining") {
      this.replyError(frame.id, "BRIDGE_CLOSED", "bridge is draining");
      return;
    }
    if (this.state.kind === "running") {
      void this.onCall(frame, this.state);
      return;
    }
    // pending-hello is excluded by the dispatch gate; closed drops silently —
    // the close handler will tear down inflight.
  }

  replyPong(id: string): void {
    this.sendFrame({ v: 1, k: "pong", id });
  }

  closeBye(): void {
    this.ws.close(1000, "bye");
  }

  // -------------------------------------------------------------------------
  // Hello / welcome
  // -------------------------------------------------------------------------
  async onHello(): Promise<void> {
    if (this.state.kind !== "pending-hello") {
      this.sendFatalAndClose("BRIDGE_PROTOCOL_ERROR", "duplicate hello frame");
      return;
    }
    if (this.helloDeadline !== null) {
      clearTimeout(this.helloDeadline);
      this.helloDeadline = null;
    }

    // authenticate()
    const authResult = await this.safeAuthenticate();
    if (!authResult.ok) {
      this.sendFatalAndClose(
        "BRIDGE_AUTH_DENIED",
        authResult.reason,
        authResult.code ?? 4401,
      );
      return;
    }
    this.identity = authResult.identity;
    const ctx: ConnectionContext = {
      identity: this.identity,
      request: this.request,
    };

    // createClient()
    let client: TmuxClient;
    try {
      client = await this.opts.createClient(ctx);
    } catch (err) {
      this.sendFatalAndClose(
        "BRIDGE_INTERNAL",
        `createClient failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    // [LAW:single-enforcer] One BridgeConnection per Connection. It owns the
    // subscription refcount + per-pane outstanding-byte accounting + the
    // watermark-driven setPaneAction loop — the same bookkeeping the
    // Electron bridge uses, so neither transport re-implements any of it.
    //
    // SCOPE NOTE: per-connection scope satisfies the qz5.5 audit
    // findings (C2 cross-peer unsubscribe rejection — UNKNOWN_SUBSCRIPTION;
    // C3 OOM hazard prevention via watermark + bufferedAmount drain
    // signal). It does NOT close the cross-WS analog of C1: when two WS
    // connections share a TmuxClient and subscribe the same name with
    // divergent (what, format), each Connection's helper has its own
    // record, both call client.subscribeRaw, and tmux's last-write-wins
    // semantics overwrite the first binding's format. A future lift to
    // factory-scope (Map<TmuxClient, BridgeConnection> with refcount)
    // would close this gap; the qz5.5 ticket scoped C1 to Electron and
    // explicitly documented this as a follow-up — see IMPL.md §7. Tracked
    // as tmux-connectors-qz5.5.1.
    //
    // [LAW:locality-or-seam] Bridge construction MUST precede client.on so
    // a watermark-config validation failure does not leak the event
    // listener. If createBridgeConnection throws, the event listener was
    // never wired and finalize's `final === null` branch correctly skips
    // cleanup.
    let bridge: BridgeConnection;
    try {
      bridge = createBridgeConnection({
        client,
        outputHighWatermark: this.opts.outputHighWatermark,
        outputLowWatermark: this.opts.outputLowWatermark,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.sendFatalAndClose("BRIDGE_INTERNAL", msg);
      return;
    }
    const peer = bridge.registerPeer();

    // Wire up tmux event fan-out.
    client.on("*", this.onAnyEventRef);

    // Atomic state transition: pending-hello → running. From here on, every
    // call site that needs `client`/`ctx`/`bridge`/`peer` reads them off
    // `this.state`, narrowed by `kind`.
    this.state = { kind: "running", client, ctx, bridge, peer };

    this.sendFrame({
      v: 1,
      k: "welcome",
      protocol: PROTOCOL_VERSION,
      limits: {
        requestTimeoutMs: this.defaults.requestTimeoutMs,
        heartbeatIntervalMs: this.defaults.heartbeatIntervalMs,
        maxInflight: this.defaults.maxInflight,
      },
    });

    this.startHeartbeat();
    this.emit({
      kind: "connection-opened",
      identity: this.identity,
      remoteAddress: this.request?.remoteAddress,
    });
  }

  private async safeAuthenticate(): Promise<AuthResult> {
    const hook = this.opts.authenticate;
    if (hook === undefined) return { ok: true, identity: undefined };
    const req: UpgradeRequest = this.request ?? { headers: {} };
    try {
      return await hook(req);
    } catch (err) {
      return {
        ok: false,
        reason: `authenticate threw: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // -------------------------------------------------------------------------
  // Call dispatch
  //
  // [LAW:dataflow-not-control-flow] Narrowing is done by the caller
  // (`dispatch`) — onCall receives a running-state value, so `state.client`
  // is non-null by type. The previous `if (this.client === null)` guard with
  // the "invariant violation" comment is gone: that case is structurally
  // unrepresentable.
  // -------------------------------------------------------------------------
  private async onCall(frame: CallFrame, state: RunningState): Promise<void> {
    if (this.inflight.size >= this.defaults.maxInflight) {
      this.replyError(
        frame.id,
        "BRIDGE_RATE_LIMITED",
        `max in-flight exceeded (${this.defaults.maxInflight})`,
      );
      return;
    }
    if (!this.checkRate()) {
      const cfg = this.opts.rateLimit;
      const detail =
        cfg !== undefined ? ` (${cfg.maxCalls}/${cfg.windowMs}ms)` : "";
      this.replyError(
        frame.id,
        "BRIDGE_RATE_LIMITED",
        `rate limit exceeded${detail}`,
      );
      return;
    }

    const authResult = await this.safeAuthorize(frame);
    this.emit({
      kind: "call",
      identity: this.identity,
      id: frame.id,
      method: frame.method,
      allowed: authResult.allow,
      denyReason: authResult.allow ? undefined : authResult.reason,
    });
    if (!authResult.allow) {
      this.replyError(frame.id, "BRIDGE_COMMAND_DENIED", authResult.reason);
      return;
    }

    const args = authResult.args ?? frame.args;

    // [LAW:single-enforcer] One validation site for the {method, args}
    // payload — parseRpcRequest from ../rpc.ts. Bad shapes raise a per-call
    // BRIDGE_UNKNOWN_METHOD or BRIDGE_PROTOCOL_ERROR; the connection stays
    // open. Per-method arg validation is handled by the same call.
    let req: RpcRequest;
    try {
      req = parseRpcRequest({ method: frame.method, args });
    } catch (e: unknown) {
      if (e instanceof RpcError) {
        this.replyError(frame.id, mapRpcCode(e.code), e.message);
        return;
      }
      throw e;
    }

    // Call-and-wait: dispatch + race against timeout. Every bridged method
    // resolves to a CommandResponse, so the timing path is uniform across
    // the dispatch table.
    const startedAt = Date.now();
    const timer = setTimeout(() => {
      if (!this.inflight.has(frame.id)) return;
      this.inflight.delete(frame.id);
      this.replyError(
        frame.id,
        "BRIDGE_TIMEOUT",
        `request timed out after ${this.defaults.requestTimeoutMs}ms`,
      );
      this.emit({
        kind: "result",
        identity: this.identity,
        id: frame.id,
        ok: false,
        code: "BRIDGE_TIMEOUT",
        durationMs: Date.now() - startedAt,
      });
    }, this.defaults.requestTimeoutMs);
    timer.unref?.();
    this.inflight.set(frame.id, { timer, startedAt });

    try {
      const result = await this.runDispatch(state, req);
      if (!this.inflight.has(frame.id)) return;
      this.inflight.delete(frame.id);
      clearTimeout(timer);
      this.replyOk(frame.id, result);
      this.emit({
        kind: "result",
        identity: this.identity,
        id: frame.id,
        ok: true,
        durationMs: Date.now() - startedAt,
      });
    } catch (err) {
      if (!this.inflight.has(frame.id)) return;
      this.inflight.delete(frame.id);
      clearTimeout(timer);
      // [LAW:single-enforcer] TmuxCommandError is the typed receipt for a
      // tmux-side %error reply (see src/errors.ts). Replying ok with the
      // structured response preserves the wire contract — clients see a
      // CommandResponse with success:false instead of a transport error.
      if (err instanceof TmuxCommandError) {
        this.replyOk(frame.id, err.response);
        this.emit({
          kind: "result",
          identity: this.identity,
          id: frame.id,
          ok: true,
          durationMs: Date.now() - startedAt,
        });
        return;
      }
      // [LAW:single-enforcer] BridgeError raised by the shared helper
      // (BRIDGE_UNKNOWN_SUBSCRIPTION, BRIDGE_SUBSCRIPTION_FORMAT_CONFLICT,
      // ...) carries a typed code already — surface it verbatim instead of
      // collapsing into BRIDGE_INTERNAL. Without this, a renderer reading
      // `.code` would see every helper-rejection as the same opaque code.
      if (err instanceof BridgeError) {
        this.replyError(frame.id, err.code, err.message);
        this.emit({
          kind: "result",
          identity: this.identity,
          id: frame.id,
          ok: false,
          code: err.code,
          durationMs: Date.now() - startedAt,
        });
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      this.replyError(frame.id, "BRIDGE_INTERNAL", message);
      this.emit({
        kind: "result",
        identity: this.identity,
        id: frame.id,
        ok: false,
        code: "BRIDGE_INTERNAL",
        durationMs: Date.now() - startedAt,
      });
    }
  }

  // [LAW:single-enforcer] Subscribe/unsubscribe go through the shared
  // BridgeConnection helper so subscription ownership + refcount + the
  // divergent-re-subscribe rejection (BRIDGE_SUBSCRIPTION_FORMAT_CONFLICT)
  // are enforced exactly once across both transports. Every other RPC
  // dispatches verbatim through dispatchRpcRequest.
  private runDispatch(
    state: RunningState,
    req: RpcRequest,
  ): Promise<CommandResponse> {
    if (req.method === "subscribeRaw") {
      const [name, what, format] = req.args;
      return state.bridge.subscribeForPeer(state.peer, name, what, format);
    }
    if (req.method === "unsubscribe") {
      const [name] = req.args;
      return state.bridge.unsubscribeForPeer(state.peer, name);
    }
    return dispatchRpcRequest(state.client, req);
  }

  // [LAW:dataflow-not-control-flow] Single-arm mapping function for
  // parse-time errors. Each RpcErrorCode maps to one BridgeErrorCode for
  // the wire reply.
  // (Defined here as a private helper so it stays close to its single caller.)
  // (See `mapRpcCode` below the class definition.)

  private async safeAuthorize(frame: CallFrame): Promise<AuthorizeResult> {
    const hook = this.opts.authorize;
    if (hook === undefined) return { allow: true };
    const req: AuthorizeRequest = {
      identity: this.identity,
      method: frame.method,
      args: frame.args,
    };
    try {
      return await hook(req);
    } catch (err) {
      return {
        allow: false,
        reason: `authorize threw: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  private checkRate(): boolean {
    const cfg = this.opts.rateLimit;
    if (cfg === undefined) return true;
    const now = Date.now();
    const cutoff = now - cfg.windowMs;
    while (this.rateWindow.length > 0 && this.rateWindow[0] < cutoff) {
      this.rateWindow.shift();
    }
    if (this.rateWindow.length >= cfg.maxCalls) return false;
    this.rateWindow.push(now);
    return true;
  }

  // -------------------------------------------------------------------------
  // Event fan-out
  //
  // Pane output rides a binary frame to skip base64. Every other notification
  // rides a JSON event frame.
  //
  // [LAW:dataflow-not-control-flow] Backpressure runs the same shape on
  // every send: account bytes against this peer for the pane (the helper
  // fires setPaneAction(Pause) when the per-pane sum crosses the high
  // watermark), then sample `ws.bufferedAmount` to detect that the OS send
  // buffer has drained — the only "in-flight bytes" signal protocol v1
  // exposes. When the buffered amount is below the low watermark, the
  // helper clears this peer's outstanding so paused panes resume. There is
  // no special "fast-client" branch — fast clients drain to 0 every send,
  // which keeps the per-pane sum at 0, and pause never fires.
  // -------------------------------------------------------------------------
  private onTmuxEvent(msg: TmuxMessage): void {
    if (this.ws.readyState !== WEBSOCKET_OPEN) return;

    // Backpressure runs only after hello — pre-hello we don't have a peer
    // registered with the bridge. By construction the WS server never fans
    // events before reaching `running` (client.on('*', ...) is wired in
    // onHello), so this is a structural invariant; the early-return is
    // defensive against future refactors that might wire fan-out earlier.
    if (this.state.kind !== "running" && this.state.kind !== "draining") {
      return;
    }
    const { bridge, peer } = this.state;

    // [LAW:single-enforcer] Discriminator lives in isPaneOutput. The
    // remaining branch is genuinely load-bearing — pane output rides the
    // binary side-channel; everything else rides the JSON event frame. The
    // type predicate also narrows the else branch to SerializedEventMessage,
    // so encodeServerFrame's typed payload is satisfied without re-checking.
    if (isPaneOutput(msg)) {
      const bytes = encodePaneOutput(msg);
      bridge.accountOutput(peer, msg.paneId, bytes.byteLength);
      this.wsSend(bytes);
      this.emit({
        kind: "event-out",
        identity: this.identity,
        type: msg.type,
        bytes: bytes.byteLength,
      });
      return;
    }

    const encoded = encodeServerFrame({ v: 1, k: "event", msg });
    this.wsSend(encoded);
    this.emit({
      kind: "event-out",
      identity: this.identity,
      type: msg.type,
      bytes: encoded.length,
    });
  }

  // [LAW:dataflow-not-control-flow] Single chokepoint for outbound writes.
  // Every JSON frame and every binary pane-output frame routes through here
  // so the OS-buffer drain sample fires on a uniform shape regardless of
  // payload. This closes a deadlock surface: previously the drain sample
  // only fired after pane-output sends, so once every active pane was
  // paused tmux stopped emitting their output, no further sends ran, and
  // `bufferedAmount` was never re-observed even when the OS buffer drained
  // — panes stuck paused indefinitely. Routing JSON event frames, RPC
  // results, and pongs through the same chokepoint keeps the resume signal
  // alive on any outbound traffic. Heartbeat ticks add a final backstop
  // for genuinely idle connections.
  private wsSend(payload: string | Uint8Array): void {
    if (this.ws.readyState !== WEBSOCKET_OPEN) return;
    try {
      this.ws.send(payload);
    } catch {
      // Write failed — socket is going away. Let the close handler clean up.
      return;
    }
    this.maybeFlushBuffered();
  }

  // [LAW:dataflow-not-control-flow] One sampling site for the OS send
  // buffer. Without an ack frame in protocol v1, `bufferedAmount === 0`
  // (or below the low watermark) is the only "everything I sent has been
  // flushed" signal the bridge can read. When the buffer is drained the
  // helper clears this peer's outstanding, which fires
  // setPaneAction(Continue) on any pane the watermark loop had paused.
  private maybeFlushBuffered(): void {
    if (this.state.kind !== "running" && this.state.kind !== "draining") {
      return;
    }
    const buffered = this.ws.bufferedAmount;
    if (buffered === undefined) return;
    if (buffered > this.lowWatermark()) return;
    this.state.bridge.clearPeerOutstanding(this.state.peer);
  }

  private lowWatermark(): number {
    return this.opts.outputLowWatermark ?? DEFAULT_OUTPUT_LOW_WATERMARK;
  }

  // -------------------------------------------------------------------------
  // Heartbeats
  // -------------------------------------------------------------------------
  private startHeartbeat(): void {
    if (this.defaults.heartbeatIntervalMs <= 0) return;
    this.heartbeatTimer = setInterval(() => {
      if (this.state.kind === "closed") return;
      // [LAW:dataflow-not-control-flow] Heartbeat tick is the idle-path
      // backstop for the drain sample — when no events flow in either
      // direction (every active pane paused, no JSON traffic), neither the
      // tmux event fan-out nor `sendFrame` runs, so the OS-buffer drain
      // would never be re-observed. Sampling here keeps panes recoverable
      // on idle connections; it's a passive read so it's safe to fire
      // before/after the ping regardless of the inflight pong state.
      this.maybeFlushBuffered();
      if (this.pongDeadline !== null) return;
      try {
        this.ws.ping();
      } catch {
        return;
      }
      this.pongDeadline = setTimeout(() => {
        this.sendFatalAndClose(
          "BRIDGE_CLOSED",
          `heartbeat timeout after ${this.defaults.heartbeatTimeoutMs}ms`,
        );
      }, this.defaults.heartbeatTimeoutMs);
      this.pongDeadline.unref?.();
    }, this.defaults.heartbeatIntervalMs);
    this.heartbeatTimer.unref?.();
  }

  // -------------------------------------------------------------------------
  // Drain / terminate
  // -------------------------------------------------------------------------
  beginDrain(deadlineMs: number): void {
    if (this.state.kind !== "running") return;
    // Carry client/ctx/bridge/peer forward into the draining variant —
    // they're still needed for in-flight calls and final disposal.
    this.state = {
      kind: "draining",
      client: this.state.client,
      ctx: this.state.ctx,
      bridge: this.state.bridge,
      peer: this.state.peer,
      deadlineMs,
    };
    this.sendFrame({ v: 1, k: "draining", deadlineMs });
  }

  terminate(): void {
    if (this.state.kind === "closed") return;
    try {
      this.ws.terminate();
    } catch {
      // already gone
    }
    this.finalize(
      new BridgeError("BRIDGE_CLOSED", "terminated by server shutdown"),
      undefined,
    );
  }

  // -------------------------------------------------------------------------
  // Reply helpers
  // -------------------------------------------------------------------------
  private replyOk(id: string, response: CommandResponse): void {
    this.sendFrame({ v: 1, k: "result", id, ok: true, response });
  }

  private replyError(id: string, code: BridgeErrorCode, message: string): void {
    this.sendFrame({
      v: 1,
      k: "result",
      id,
      ok: false,
      error: { code, message },
    });
  }

  private sendFrame(frame: ServerFrame): void {
    // [LAW:single-enforcer] Routes through `wsSend`, the single chokepoint
    // that samples the OS send buffer after every write. RPC results and
    // events that don't carry pane-output bytes still pump the drain
    // signal — see `wsSend` for the deadlock context.
    this.wsSend(encodeServerFrame(frame));
  }

  private sendFatalAndClose(
    code: BridgeErrorCode,
    message: string,
    wsCode = 1011,
  ): void {
    sendFatal(this.ws, code, message);
    try {
      this.ws.close(wsCode, message.slice(0, 123));
    } catch {
      // ignore
    }
  }

  // -------------------------------------------------------------------------
  // Finalize — the single cleanup path.
  // -------------------------------------------------------------------------
  private finalize(
    fatal: BridgeError | undefined,
    closeInfo: { code: number; reason: string } | undefined,
  ): void {
    if (this.state.kind === "closed") return;

    // Capture client/ctx/bridge/peer (if we ever reached running) into the
    // closed variant so disposal can reach them after the transition. The
    // discriminator alone tells us whether there's anything to clean up.
    const final =
      this.state.kind === "running" || this.state.kind === "draining"
        ? {
            client: this.state.client,
            ctx: this.state.ctx,
            bridge: this.state.bridge,
            peer: this.state.peer,
          }
        : null;
    this.state = { kind: "closed", final };

    if (this.helloDeadline !== null) clearTimeout(this.helloDeadline);
    if (this.heartbeatTimer !== null) clearInterval(this.heartbeatTimer);
    if (this.pongDeadline !== null) clearTimeout(this.pongDeadline);

    for (const [id, pending] of this.inflight) {
      clearTimeout(pending.timer);
      this.replyError(
        id,
        "BRIDGE_CLOSED",
        fatal?.message ?? "connection closed",
      );
    }
    this.inflight.clear();

    if (final !== null) {
      final.client.off("*", this.onAnyEventRef);
      // [LAW:single-enforcer] Single shutdown path: removePeer drops this
      // connection's outstanding-byte accounting (resuming any panes paused
      // only because of this peer's lag) and refcount-decrements every
      // subscription this peer owned (firing client.unsubscribe on last
      // drop). bridge.dispose() then resumes any panes the helper had
      // paused, since the helper is per-Connection and is going away.
      final.bridge.removePeer(final.peer);
      final.bridge.dispose();
      if (this.opts.disposeClient !== undefined) {
        void Promise.resolve(this.opts.disposeClient(final.client, final.ctx));
      }
    }

    this.emit({
      kind: "connection-closed",
      identity: this.identity,
      code: closeInfo?.code,
      reason: closeInfo?.reason ?? fatal?.message,
    });

    this.closed();
  }

  private emit(ev: BridgeObservabilityEvent): void {
    if (this.opts.onEvent === undefined) return;
    try {
      this.opts.onEvent(ev);
    } catch {
      // Swallow — observability hooks must never break the connection.
    }
  }
}

// ---------------------------------------------------------------------------
// Per-kind ClientFrame handlers.
//
// [LAW:dataflow-not-control-flow] One entry per ClientFrame variant; the
// dispatcher (Connection.dispatch) does a single indexed lookup. The mapped
// type forces exhaustiveness — adding a new ClientFrame kind without a
// handler is a compile-time error, not a runtime "unknown kind" branch.
// [LAW:single-enforcer] Connection.dispatch is the only call site.
// ---------------------------------------------------------------------------

type ClientFrameHandlers = {
  readonly [K in ClientFrame["k"]]: (
    self: Connection,
    frame: Extract<ClientFrame, { k: K }>,
  ) => void;
};

const CLIENT_FRAME_HANDLERS: ClientFrameHandlers = Object.assign(
  Object.create(null) as ClientFrameHandlers,
  {
    hello: (self) => void self.onHello(),
    call: (self, f) => self.routeCall(f),
    ping: (self, f) => self.replyPong(f.id),
    bye: (self) => self.closeBye(),
  } satisfies ClientFrameHandlers,
);

// ---------------------------------------------------------------------------
// RpcError → BridgeErrorCode mapping (single arm function — Connection.onCall
// uses this to translate parser failures into the wire error taxonomy).
// ---------------------------------------------------------------------------

const RPC_ERROR_TO_BRIDGE: Readonly<Record<RpcErrorCode, BridgeErrorCode>> = {
  UNKNOWN_METHOD: "BRIDGE_UNKNOWN_METHOD",
  INVALID_REQUEST: "BRIDGE_INVALID_REQUEST",
  INVALID_ARG: "BRIDGE_INVALID_ARG",
};

function mapRpcCode(code: RpcErrorCode): BridgeErrorCode {
  return RPC_ERROR_TO_BRIDGE[code];
}

// ---------------------------------------------------------------------------
// Helpers visible to the factory
// ---------------------------------------------------------------------------

function sendFatal(
  ws: ServerWebSocketLike,
  code: BridgeErrorCode,
  message: string,
): void {
  if (ws.readyState !== WEBSOCKET_OPEN) return;
  try {
    ws.send(
      encodeServerFrame({
        v: 1,
        k: "error",
        fatal: true,
        error: { code, message },
      }),
    );
  } catch {
    // ignore
  }
}

async function allClosed(conns: Set<Connection>): Promise<void> {
  await Promise.all([...conns].map((c) => c.whenClosed));
}
