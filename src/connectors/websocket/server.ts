// src/connectors/websocket/server.ts
// WebSocket bridge — server side.
//
// `createWebSocketBridge({createClient, ...hooks})` returns an object whose
// `handleConnection(ws, req)` method plugs an upgraded WebSocket into a
// TmuxClient and speaks the wire protocol defined in `./protocol.ts`.
//
// Library responsibilities:
//   - Run the `hello`/`welcome` handshake (auth + client setup gate).
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

import { bytesToLatin1 } from "../../protocol/byte-codec.js";
import type { TmuxClient } from "../../client.js";
import {
  isTmuxMessage,
  type EmitterMessage,
  type EmitterTmuxMessage,
} from "../../emitter.js";
import type { BytesSink, ChunkPayload } from "../../pane-output.js";
import type { CommandResponse } from "../../protocol/types.js";

import {
  BridgeError,
  BridgeProtocolError,
  encodePaneOutput,
  encodeServerFrame,
  parseClientFrame,
  type BridgeErrorCode,
  type CallFrame,
  type ClientFrame,
  type ServerFrame,
} from "./protocol.js";

import {
  mapRpcCode,
  parseRpcRequest,
  RpcError,
  type RpcRequest,
} from "../rpc.js";
import {
  type BridgeOutcome,
  dispatchBridgeRequest,
} from "../bridge-dispatch.js";
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
import { RateLimiter } from "./rate-limiter.js";
import { Heartbeat } from "./heartbeat.js";
import { CallPump } from "./call-pump.js";
import { Handshake } from "./handshake.js";

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
  /**
   * Hello frame accepted; authenticate()/createClient() in flight. No
   * resources exist yet — everything onHello builds lives in its own local
   * scope until it commits to `running`. A second hello arriving in this
   * window is a protocol error (the `!== "pending-hello"` guard in onHello
   * covers it); `finalize` running while in this phase correctly captures
   * nothing (`final = null`) — onHello itself checks for closed on each
   * resume and disposes whatever it already built. [LAW:no-ambient-temporal-coupling]
   */
  | { readonly kind: "handshaking" }
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
   * finalize time if we ever reached running; null if we closed before that
   * (including mid-handshake), in which case onHello's own resume-time check
   * is responsible for disposing whatever it had already built.
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

  private readonly onAnyEventRef: (msg: EmitterMessage) => void;
  private readonly byteForwarder: BytesSink;
  // Disposer for `client.attachBytesSink(this.byteForwarder)`, populated
  // on hello (alongside `client.on('*', this.onAnyEventRef)`) and cleared
  // in finalize. Mirrors the off-pair for the state channel.
  private detachByteForwarder: (() => void) | null = null;

  // [LAW:decomposition] These four collaborators each own one concern that
  // was previously fused into Connection's private fields. Connection wires
  // them with callbacks and delegates; it owns no timer or rate-window state.
  private readonly rateLimiter: RateLimiter;
  private readonly heartbeat: Heartbeat;
  private readonly callPump: CallPump;
  private readonly handshake: Handshake;

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
    // [LAW:single-enforcer] Byte channel is multiplexer-shaped; the bridge
    //   attaches one all-panes sink instead of inspecting every wildcard
    //   event for pane output. The emitter no longer carries byte messages,
    //   so this is the only path bytes reach the wire.
    this.byteForwarder = {
      write: (msg) => this.onByteOutput(msg),
      // [LAW:types-are-the-program] end() is required by BytesSink contract;
      // forwarding sink has no per-pane state to flush.
      end(): void {
        /* stateless sink */
      },
    };

    this.rateLimiter = new RateLimiter(opts.rateLimit);

    this.heartbeat = new Heartbeat(
      defaults.heartbeatIntervalMs,
      defaults.heartbeatTimeoutMs,
      {
        onTick: () => this.maybeFlushBuffered(),
        ping: () => this.ws.ping(),
        onTimeout: () =>
          this.sendFatalAndClose(
            "BRIDGE_CLOSED",
            `heartbeat timeout after ${defaults.heartbeatTimeoutMs}ms`,
          ),
      },
    );

    this.callPump = new CallPump(
      defaults.maxInflight,
      defaults.requestTimeoutMs,
      {
        onTimeout: (id, startedAt) => {
          this.replyError(
            id,
            "BRIDGE_TIMEOUT",
            `request timed out after ${defaults.requestTimeoutMs}ms`,
          );
          this.emit({
            kind: "result",
            identity: this.identity,
            id,
            ok: false,
            code: "BRIDGE_TIMEOUT",
            durationMs: Date.now() - startedAt,
          });
        },
      },
    );

    this.handshake = new Handshake(
      defaults.helloTimeoutMs,
      request,
      opts.authenticate,
    );
  }

  async run(): Promise<void> {
    this.installWsListeners();
    this.handshake.arm(() =>
      this.sendFatalAndClose(
        "BRIDGE_PROTOCOL_ERROR",
        `no hello frame within ${this.defaults.helloTimeoutMs}ms`,
      ),
    );
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
            ? bytesToLatin1(data)
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

    this.ws.on("pong", () => this.heartbeat.onPong());

    // No inbound-ping listener: `ws` auto-replies with pong, and a no-op
    // handler would only read as "something happens here". The outbound
    // heartbeat (this.ws.ping + the "pong" deadline above) is the liveness
    // mechanism this server actually owns.
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
    // is absorbed by CLIENT_FRAME_HANDLERS below. "handshaking" counts as
    // pre-hello too — the handshake in flight hasn't produced a client yet.
    if (
      frame.k !== "hello" &&
      (this.state.kind === "pending-hello" || this.state.kind === "handshaking")
    ) {
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
    this.sendFrame({ k: "pong", id });
  }

  closeBye(): void {
    this.ws.close(1000, "bye");
  }

  // -------------------------------------------------------------------------
  // Hello / welcome
  // -------------------------------------------------------------------------

  // Wrapped in a method (rather than `this.state.kind === "closed"` inline)
  // so TypeScript's control-flow narrowing of `this.state` from the
  // synchronous assignment above the first `await` in onHello doesn't get
  // carried across the `await` — the compiler can't see that `finalize` may
  // have reassigned `this.state` on the event loop while onHello was
  // suspended, so it otherwise treats the two checks below as comparing
  // literal types with no overlap. This call boundary forces a fresh read.
  private isClosed(): boolean {
    return this.state.kind === "closed";
  }

  async onHello(): Promise<void> {
    if (this.state.kind !== "pending-hello") {
      this.sendFatalAndClose("BRIDGE_PROTOCOL_ERROR", "duplicate hello frame");
      return;
    }
    // [LAW:no-ambient-temporal-coupling] Commit to the handshake synchronously,
    // before the first await, so a second hello arriving while this one is in
    // flight sees a state other than "pending-hello" and is rejected above —
    // no race window between the guard and the transition.
    this.state = { kind: "handshaking" };
    this.handshake.clear();

    // authenticate()
    const authResult = await this.handshake.authenticate();
    if (this.isClosed()) {
      // finalize ran while we were suspended (mid-handshake disconnect).
      // Nothing was created yet — just stop.
      return;
    }
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
      if (this.isClosed()) return;
      this.sendFatalAndClose(
        "BRIDGE_INTERNAL",
        `createClient failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    if (this.isClosed()) {
      // finalize ran while createClient() was in flight. `client` exists but
      // was never committed to `state`, so finalize's disposal (which only
      // fires for running/draining) never saw it — dispose it here, the same
      // way finalize would have, and stop before wiring any listener or sink
      // onto the shared client.
      if (this.opts.disposeClient !== undefined) {
        void Promise.resolve(this.opts.disposeClient(client, ctx));
      }
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

    // Wire up tmux event fan-out. The state channel rides the wildcard
    // emitter; the byte channel rides the all-panes sink — two disjoint
    // attachments because they are two disjoint channels.
    client.on("*", this.onAnyEventRef);
    this.detachByteForwarder = client.attachBytesSink(this.byteForwarder);

    // Atomic state transition: pending-hello → running. From here on, every
    // call site that needs `client`/`ctx`/`bridge`/`peer` reads them off
    // `this.state`, narrowed by `kind`.
    this.state = { kind: "running", client, ctx, bridge, peer };

    this.sendFrame({
      k: "welcome",
      limits: {
        requestTimeoutMs: this.defaults.requestTimeoutMs,
        heartbeatIntervalMs: this.defaults.heartbeatIntervalMs,
        maxInflight: this.defaults.maxInflight,
      },
    });

    this.heartbeat.start();
    this.emit({
      kind: "connection-opened",
      identity: this.identity,
      remoteAddress: this.request?.remoteAddress,
    });
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
    if (this.callPump.isFull()) {
      this.replyError(
        frame.id,
        "BRIDGE_RATE_LIMITED",
        `max in-flight exceeded (${this.defaults.maxInflight})`,
      );
      return;
    }
    if (!this.rateLimiter.check()) {
      this.replyError(
        frame.id,
        "BRIDGE_RATE_LIMITED",
        `rate limit exceeded${this.rateLimiter.describe()}`,
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

    // [LAW:no-ambient-temporal-coupling] Track the call before dispatch;
    // CallPump owns the timeout race. If dispatch completes first, complete()
    // returns timing and clears the timer. If the timer fires first, it
    // replies and deletes the id; complete() then returns undefined and we
    // skip the double-reply.
    this.callPump.track(frame.id);

    // [LAW:single-enforcer] dispatchBridgeRequest owns the subscribe/unsubscribe
    // interception + the tmux/bridge/internal classification, shared with the
    // Electron main. It never throws — every result is a BridgeOutcome value.
    const outcome = await dispatchBridgeRequest(
      state.bridge,
      state.client,
      state.peer,
      req,
    );

    const timing = this.callPump.complete(frame.id);
    if (timing === undefined) return; // timeout already replied
    this.encodeOutcome(frame.id, outcome, timing.startedAt);
  }

  // [LAW:decomposition] WS wire encoding of a BridgeOutcome — the
  // transport-specific half. `ok` and `tmux-error` both reply with a
  // CommandResponse frame (a tmux %error is a successful bridge call whose
  // response carries success:false, not a transport error); `bridge-error`
  // replies with a typed error frame carrying the BridgeError's code. The
  // classification that produced the outcome lives in dispatchBridgeRequest.
  private encodeOutcome(
    id: string,
    outcome: BridgeOutcome,
    startedAt: number,
  ): void {
    if (outcome.kind === "bridge-error") {
      this.replyError(id, outcome.error.code, outcome.error.message);
      this.emit({
        kind: "result",
        identity: this.identity,
        id,
        ok: false,
        code: outcome.error.code,
        durationMs: Date.now() - startedAt,
      });
      return;
    }
    this.replyOk(id, outcome.response);
    this.emit({
      kind: "result",
      identity: this.identity,
      id,
      ok: true,
      durationMs: Date.now() - startedAt,
    });
  }

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
  //
  // Two channels, disjoint by message type:
  //   - `onTmuxEvent` handles non-byte tmux messages via the JSON event
  //     frame. `EmitterTmuxMessage` excludes `PaneOutputMessage` by
  //     construction, so a byte message cannot reach this method — the
  //     type system enforces it.
  //   - `onByteOutput` handles `PaneOutputMessage` via the binary
  //     side-channel. Bytes are routed here via
  //     `client.attachBytesSink`, not through `client.on('*', …)`,
  //     because the emitter no longer carries byte messages.
  // -------------------------------------------------------------------------
  private onTmuxEvent(msg: EmitterTmuxMessage): void {
    if (this.ws.readyState !== WEBSOCKET_OPEN) return;
    if (this.state.kind !== "running" && this.state.kind !== "draining") {
      return;
    }
    const encoded = encodeServerFrame({ k: "event", msg });
    this.wsSend(encoded);
    this.emit({
      kind: "event-out",
      identity: this.identity,
      type: msg.type,
      bytes: encoded.length,
    });
  }

  private onByteOutput(msg: ChunkPayload): void {
    if (this.ws.readyState !== WEBSOCKET_OPEN) return;
    // Backpressure runs only after hello — pre-hello we don't have a peer
    // registered with the bridge. The attach-all-panes sink is wired in
    // onHello, so this is a structural invariant; the early-return is
    // defensive against future refactors that might wire fan-out earlier.
    if (this.state.kind !== "running" && this.state.kind !== "draining") {
      return;
    }
    const { bridge, peer } = this.state;
    const bytes = encodePaneOutput(msg);
    bridge.accountOutput(peer, msg.paneId, bytes.byteLength);
    this.wsSend(bytes);
    this.emit({
      kind: "event-out",
      identity: this.identity,
      type: "output",
      bytes: bytes.byteLength,
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
    this.sendFrame({ k: "draining", deadlineMs });
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
    this.sendFrame({ k: "result", id, ok: true, response });
  }

  private replyError(id: string, code: BridgeErrorCode, message: string): void {
    this.sendFrame({
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

    this.handshake.clear();
    this.heartbeat.stop();
    this.callPump.drain((id) => {
      this.replyError(
        id,
        "BRIDGE_CLOSED",
        fatal?.message ?? "connection closed",
      );
    });

    if (final !== null) {
      final.client.off("*", this.onAnyEventRef);
      this.detachByteForwarder?.();
      this.detachByteForwarder = null;
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
