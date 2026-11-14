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
//   - Close the socket when the upstream TmuxClient closes (tmux died, its
//     transport failed, or it was disposed), so the browser learns of it the
//     way it learns any other disconnect instead of holding a `ready`
//     connection whose every call answers BRIDGE_CLOSED.
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
import type { ConnectionState as TmuxConnectionState } from "../../connection-state.js";
import type { EmitterMessage } from "../../emitter.js";
import type { BytesSink, ChunkPayload } from "../../pane-output.js";

import {
  BridgeError,
  toBridgeProtocolError,
  encodePaneOutput,
  encodeServerFrame,
  parseClientFrame,
  truncateCloseReason,
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
  SocketEnd,
  UpgradeRequest,
} from "./types.js";
import { WEBSOCKET_OPEN } from "./types.js";
import { RateLimiter, parseRateLimit, type RateLimit } from "./rate-limiter.js";
import { Heartbeat, type HeartbeatCadence } from "./heartbeat.js";
import {
  parseDurationMs,
  parseHeartbeatInterval,
  parsePositiveInt,
  type DurationMs,
  type PositiveInt,
} from "./limits.js";
import { CallPump } from "./call-pump.js";
import { Handshake } from "./handshake.js";
import {
  GOING_AWAY,
  INTERNAL_ERROR,
  NORMAL_CLOSURE,
  type ServerCloseCode,
} from "./close-code.js";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULTS = Object.freeze({
  heartbeatIntervalMs: 30_000,
  heartbeatTimeoutMs: 10_000,
  requestTimeoutMs: 30_000,
  helloTimeoutMs: 5_000,
  drainMs: 10_000,
  maxInflight: 64,
}) satisfies Record<string, number>;

// The reason a draining bridge gives every peer it refuses, before or
// mid-handshake.
const SHUTTING_DOWN = "bridge is shutting down";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ConnectionContext {
  readonly identity: ConnectionIdentity;
  readonly request?: UpgradeRequest;
}

export interface WebSocketBridgeOptions {
  /**
   * Produce (or look up) the TmuxClient backing a new connection. The client
   * must be live: one whose `connectionState` is already `closed` is refused
   * at hello with BRIDGE_CLOSED, and when a client closes later (tmux died,
   * its transport failed, or it was disposed) every connection on it is
   * closed with BRIDGE_CLOSED. A shared client therefore has to be replaced
   * by the factory once its tmux is gone.
   */
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

  /** Sliding-window rate limit per connection: `maxCalls` and `windowMs`
   *  each an integer >= 1, or `createWebSocketBridge` throws
   *  `BRIDGE_INVALID_ARG` naming `rateLimit.<field>` and the value.
   *  Default: unlimited. */
  readonly rateLimit?: RateLimitConfig;

  /** Ping period. The heartbeat is the one liveness bound the bridge owns:
   *  a peer that misses a pong is closed, and a peer that then never answers
   *  the close frame is terminated at the next pong deadline. `0` turns the
   *  heartbeat off, and with it both bounds; otherwise an integer number of
   *  ms in [1, 2^31-1], or `createWebSocketBridge` throws `BRIDGE_INVALID_ARG`.
   *  Default 30s. */
  readonly heartbeatIntervalMs?: number;
  /** How long after a ping its pong may arrive: an integer number of ms in
   *  [1, 2^31-1], or `createWebSocketBridge` throws `BRIDGE_INVALID_ARG`.
   *  Default 10s. */
  readonly heartbeatTimeoutMs?: number;
  /** How long a call may wait for its tmux reply before the bridge answers
   *  `BRIDGE_TIMEOUT`: an integer number of ms in [1, 2^31-1], or
   *  `createWebSocketBridge` throws `BRIDGE_INVALID_ARG`. Default 30s. */
  readonly requestTimeoutMs?: number;
  /** Calls a connection may have in flight at once: an integer >= 1, or
   *  `createWebSocketBridge` throws `BRIDGE_INVALID_ARG`. Default 64. */
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
   * `drainMs` elapses (after which sockets are force-terminated). `drainMs`
   * is an integer number of ms in [1, 2^31-1], or the returned promise
   * rejects with `BRIDGE_INVALID_ARG` before any connection is told anything.
   * Default 10s. The first call owns the drain: a later call settles with it,
   * and its `drainMs` does not move the deadline the peers were told.
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
  // [LAW:one-source-of-truth] The drain in flight is the bridge's draining
  // state: set once, by the first shutdown, and never a second race.
  let drain:
    | { readonly deadlineMs: number; readonly settled: Promise<void> }
    | undefined;

  async function handleConnection(
    ws: ServerWebSocketLike,
    request?: UpgradeRequest,
  ): Promise<void> {
    if (drain) {
      sendFatal(ws, "BRIDGE_CLOSED", SHUTTING_DOWN);
      ws.close(GOING_AWAY, "shutting down");
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

  // [LAW:parse-dont-validate] The drain bound is parsed before any peer is
  // told anything, so a value no timer honors rejects the returned promise —
  // the one failure channel the signature declares — and no connection is
  // left holding a deadline in the past.
  // [LAW:no-ambient-temporal-coupling] A later call joins the first call's
  // drain, so the deadline peers were told is the one the bridge enforces.
  // The drain is recorded before any peer is told, so anything a peer's
  // notice reaches synchronously (a socket's send, an onEvent hook) already
  // sees the bridge draining. Telling peers is idempotent per connection, so
  // every call tells them the same deadline.
  async function shutdown(drainMs: number = DEFAULTS.drainMs): Promise<void> {
    const bound = parseDurationMs("drainMs", drainMs);
    const joined = drain !== undefined;
    drain ??= { deadlineMs: Date.now() + bound, settled: settleWithin(bound) };
    // [LAW:nothing-unseen] A joined call's bound is set aside; the event says
    // so, beside the deadline that does hold.
    emitObservability(opts, {
      kind: "shutdown-requested",
      drainMs: bound,
      deadlineMs: drain.deadlineMs,
      joined,
    });
    for (const conn of connections) conn.beginDrain(drain.deadlineMs);
    return drain.settled;
  }

  async function settleWithin(bound: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      allClosed(connections),
      new Promise<void>((r) => {
        timer = setTimeout(r, bound);
        timer.unref?.();
      }),
    ]);
    clearTimeout(timer);
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
      readonly bridge: BridgeConnection<false>;
      readonly peer: Peer;
    }
  /** Drain initiated; existing in-flight calls finish, new calls rejected. */
  | {
      readonly kind: "draining";
      readonly client: TmuxClient;
      readonly ctx: ConnectionContext;
      readonly bridge: BridgeConnection<false>;
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
        readonly bridge: BridgeConnection<false>;
        readonly peer: Peer;
      } | null;
    };

type RunningState = Extract<ConnectionState, { kind: "running" }>;

interface ResolvedDefaults {
  readonly heartbeat: HeartbeatCadence;
  readonly requestTimeoutMs: DurationMs;
  readonly helloTimeoutMs: DurationMs;
  readonly maxInflight: PositiveInt;
  readonly rateLimit: RateLimit | undefined;
}

// [LAW:parse-dont-validate] The consumer's timing and capacity options cross
// the border once, here, at bridge construction: a timeout no reply could ever
// meet, or a cap no call could ever fit under, fails with the option's name
// and value instead of as a verdict against every peer. The results are in
// the shapes Heartbeat, CallPump, Handshake and RateLimiter take, so no caller
// re-packs them and none checks again.
function resolveDefaults(opts: WebSocketBridgeOptions): ResolvedDefaults {
  return {
    heartbeat: {
      intervalMs: parseHeartbeatInterval(
        "heartbeatIntervalMs",
        opts.heartbeatIntervalMs ?? DEFAULTS.heartbeatIntervalMs,
      ),
      timeoutMs: parseDurationMs(
        "heartbeatTimeoutMs",
        opts.heartbeatTimeoutMs ?? DEFAULTS.heartbeatTimeoutMs,
      ),
    },
    requestTimeoutMs: parseDurationMs(
      "requestTimeoutMs",
      opts.requestTimeoutMs ?? DEFAULTS.requestTimeoutMs,
    ),
    helloTimeoutMs: parseDurationMs("helloTimeoutMs", DEFAULTS.helloTimeoutMs),
    maxInflight: parsePositiveInt(
      "maxInflight",
      opts.maxInflight ?? DEFAULTS.maxInflight,
    ),
    rateLimit: parseRateLimit(opts.rateLimit),
  };
}

class Connection {
  // [LAW:one-source-of-truth] Single state field; (client, ctx) live inside
  // the variant that needs them, not as parallel nullable fields.
  private state: ConnectionState = { kind: "pending-hello" };
  private identity: ConnectionIdentity = undefined;
  // Set by sendFatalAndClose; read by the "close" listener once the real
  // close event lands, so finalize's one connection-closed emission can
  // carry the BridgeErrorCode a peer-initiated close never has.
  // [LAW:single-enforcer]
  private fatal: BridgeError | undefined = undefined;

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
    this.onAnyEventRef = (msg: EmitterMessage): void => {
      this.onUpstreamEvent(msg);
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

    this.rateLimiter = new RateLimiter(defaults.rateLimit);

    this.heartbeat = new Heartbeat(defaults.heartbeat, {
      onTick: () => this.maybeFlushBuffered(),
      ping: () => this.ws.ping(),
      onTimeout: () => this.onPongDeadline(),
    });

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
      // [LAW:single-enforcer] A frame delivered after finalize meets the
      // closed state here, before either branch can open a close handshake
      // (sendFatalAndClose starts the heartbeat finalize already stopped).
      if (this.state.kind === "closed") return;
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
      // [LAW:single-enforcer] `this.fatal` carries the BridgeErrorCode when
      // this close was triggered by sendFatalAndClose rather than a
      // peer-initiated disconnect — set there, read here, so the one
      // existing emission site (finalize) can report it without a second,
      // manually-paired event at each sendFatalAndClose call site.
      this.finalize(undefined, {
        kind: "close-event",
        code,
        reason: typeof reason === "string" ? reason : reason.toString("utf8"),
      });
    });

    this.ws.on("error", (err: Error) => {
      this.finalize(
        new BridgeError("BRIDGE_INTERNAL", `socket error: ${err.message}`),
        { kind: "error", message: err.message },
      );
    });

    this.ws.on("pong", () => this.heartbeat.onPong());

    // No inbound-ping listener: `ws` auto-replies with pong, and a no-op
    // handler would only read as "something happens here". The outbound
    // heartbeat (this.ws.ping + the "pong" deadline above) is the liveness
    // mechanism this server actually owns.
  }

  private onFrame(raw: string): void {
    let frame: ClientFrame;
    try {
      frame = parseClientFrame(raw);
    } catch (err) {
      // [LAW:single-enforcer] Normalization lives in toBridgeProtocolError.
      // The parser only throws BridgeProtocolError, whose `.message` already
      // carries the `[BRIDGE_PROTOCOL_ERROR]` prefix — the value this event
      // and the fatal frame have always carried.
      const msg = toBridgeProtocolError(err).message;
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
    this.ws.close(NORMAL_CLOSURE, "bye");
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

  // True once this connection's one close-enforcer (sendFatalAndClose /
  // finalize) has been claimed — either the real close already ran, or an
  // earlier fatal is pending and sendFatalAndClose's write-once guard will
  // suppress a second one. A failure discovered past this point has no live
  // channel to route through and must self-report. [LAW:single-enforcer]
  private isTearingDown(): boolean {
    return this.isClosed() || this.fatal !== undefined;
  }

  private emitUnreportedHandshakeFailure(
    code: BridgeErrorCode,
    message: string,
  ): void {
    this.emit({
      kind: "handshake-failure-unreported",
      identity: this.identity,
      code,
      message,
    });
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
      if (this.isTearingDown()) {
        // An earlier, unrelated fatal (e.g. a racing duplicate hello) is
        // already pending — sendFatalAndClose's write-once guard would
        // otherwise silently drop this denial. [LAW:no-silent-failure]
        this.emitUnreportedHandshakeFailure(
          "BRIDGE_AUTH_DENIED",
          authResult.reason,
        );
        return;
      }
      this.sendFatalAndClose(
        "BRIDGE_AUTH_DENIED",
        authResult.reason,
        authResult.closeCode,
      );
      return;
    }
    this.identity = authResult.identity;
    const ctx: ConnectionContext = {
      identity: this.identity,
      request: this.request,
    };

    // [LAW:single-enforcer] [LAW:carrying-cost] onHello acquires a strict
    // prefix of { client, bridge, peer+listeners } and must leave nothing
    // committed-but-unreleased on any exit before the atomic `state =
    // running` transition below. Rather than one hand-unwound catch per
    // acquisition step — which re-copies and extends the same release
    // sequence at every step (tmux-lifecycle-zng.s5u added the bridge step,
    // tmux-lifecycle-zng.7k0 found the peer/listener step missing it) —
    // each acquisition pushes its own release onto `releases` the instant
    // it succeeds. One `unwind()` at the bottom releases exactly the prefix
    // that was actually acquired, in reverse order, however far onHello got.
    // Adding the epic's next resource to this chain is a `releases.push(...)`
    // at its acquisition site, not a new catch block.
    const releases: (() => void)[] = [];
    const unwind = (): void => {
      let release: (() => void) | undefined;
      while ((release = releases.pop()) !== undefined) {
        // Each release tears down one resource independently of the others
        // — a throw here must not skip the releases still below it on the
        // stack (most importantly disposeClientSafely, pushed first and so
        // popped last). [LAW:no-silent-failure]
        try {
          release();
        } catch (err) {
          this.emit({
            kind: "release-failed",
            identity: this.identity,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
    };

    // createClient()
    let client: TmuxClient;
    try {
      client = await this.opts.createClient(ctx);
    } catch (err) {
      const message = `createClient failed: ${err instanceof Error ? err.message : String(err)}`;
      if (this.isTearingDown()) {
        // Either finalize already ran for an unrelated reason (the peer
        // disconnected while createClient() was still in flight, reporting
        // that closure with no failure info) or an earlier fatal is already
        // pending (write-once guard would silently drop this one too).
        // [LAW:no-silent-failure]
        this.emitUnreportedHandshakeFailure("BRIDGE_INTERNAL", message);
        return;
      }
      this.sendFatalAndClose("BRIDGE_INTERNAL", message);
      return;
    }
    releases.push(() => this.disposeClientSafely(client, ctx));
    if (this.isTearingDown()) {
      // Either finalize ran while createClient() was in flight, or an
      // earlier fatal is already pending (same race the auth-denied and
      // createClient-catch branches above now guard against) — this
      // connection's outcome is already fixed to something other than
      // "running". `client` exists but was never committed to `state`, so
      // finalize's disposal (which only fires for running/draining) never
      // saw it — unwind here, the same way finalize would have, and stop
      // before wiring any listener, sink, or "connection-opened" onto a
      // connection that is not actually opening. [LAW:no-silent-failure]
      unwind();
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
    let bridge: BridgeConnection<false>;
    try {
      bridge = createBridgeConnection({
        client,
        forwardsLifecycle: false,
        outputHighWatermark: this.opts.outputHighWatermark,
        outputLowWatermark: this.opts.outputLowWatermark,
        // [LAW:effects-at-boundaries] The bridge DESCRIBES a stranded resume;
        // the transport PERFORMS the emission on its own observability channel.
        reportResumeFailure: (f) =>
          this.emit({
            kind: "pane-resume-failed",
            identity: this.identity,
            paneId: f.paneId,
            code: f.error.code,
            message: f.error.message,
          }),
        reportCoverageReleaseFailure: (e) =>
          this.emit({
            kind: "cross-session-layout-release-failed",
            identity: this.identity,
            code: e.code,
            message: e.message,
          }),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      unwind();
      this.sendFatalAndClose("BRIDGE_INTERNAL", msg);
      return;
    }
    releases.push(() => bridge.dispose());

    // registerPeer() and the fan-out wiring below run after the bridge
    // exists but before anything is committed to `state`, so a throw here
    // needs the same unwind as every step above it — otherwise client AND
    // bridge leak with no disposeClient call and no sendFatalAndClose
    // (tmux-lifecycle-zng.7k0). registerPeer() mints a fresh Peer token per
    // call, so SubscriptionLedger/BackpressureLedger's own re-register
    // guards are unreachable in practice; client.on and attachBytesSink are
    // ordinary synchronous registration calls not documented to throw.
    // None of that makes the throw impossible by type, so it is guarded
    // rather than assumed away. [LAW:no-silent-failure]
    let peer: Peer;
    try {
      peer = bridge.registerPeer();
      // Wire up tmux event fan-out. The state channel rides the wildcard
      // emitter; the byte channel rides the all-panes sink — two disjoint
      // attachments because they are two disjoint channels.
      client.on("*", this.onAnyEventRef);
      releases.push(() => client.off("*", this.onAnyEventRef));
      this.detachByteForwarder = client.attachBytesSink(this.byteForwarder);
      releases.push(() => {
        this.detachByteForwarder?.();
        this.detachByteForwarder = null;
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      unwind();
      this.sendFatalAndClose("BRIDGE_INTERNAL", msg);
      return;
    }

    // createClient() is caller-supplied and may hand back a shared client
    // that already closed: its terminal `connection-state` was emitted
    // before this connection's wildcard listener existed, so onUpstreamEvent
    // would never hear it and the connection would open onto a dead tmux.
    // Read after the listener is wired: every transition after this read
    // reaches the listener whatever runs in between, and this one read
    // covers everything before it. [LAW:no-ambient-temporal-coupling]
    const upstream = client.connectionState;
    if (upstream.status === "closed") {
      unwind();
      this.closeForUpstream(upstream);
      return;
    }

    // Atomic state transition: pending-hello → running. From here on, every
    // call site that needs `client`/`ctx`/`bridge`/`peer` reads them off
    // `this.state`, narrowed by `kind`.
    this.state = { kind: "running", client, ctx, bridge, peer };

    this.sendFrame({
      k: "welcome",
      limits: {
        requestTimeoutMs: this.defaults.requestTimeoutMs,
        heartbeatIntervalMs: this.defaults.heartbeat.intervalMs,
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
  // transport-specific half. `ok` replies with its response, `tmux-error`
  // with a `tmuxError` frame the client rethrows as TmuxCommandError (as the
  // Electron renderer does), and `bridge-error` with a typed error frame
  // carrying the BridgeError's code. The classification that produced the
  // outcome lives in dispatchBridgeRequest.
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
    const tmuxError = outcome.kind === "tmux-error";
    this.sendFrame(
      tmuxError
        ? { k: "result", id, ok: false, tmuxError: outcome.response }
        : { k: "result", id, ok: true, response: outcome.response },
    );
    // Observability records what the client sees: a tmux %error rejects there.
    this.emit({
      kind: "result",
      identity: this.identity,
      id,
      ...(tmuxError ? { ok: false, code: "TMUX_ERROR" } : { ok: true }),
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
  //   - `onUpstreamEvent` receives every emitter event. The upstream's
  //     terminal `connection-state` is this connection's own death notice
  //     and is consumed here; everything else goes to `onWireEvent`, which
  //     asks the bridge who it reaches. Built with `forwardsLifecycle:
  //     false`, the bridge's delivered route can only be a tmux message, a
  //     reply-stream report or a cross-session-layout event, so the JSON
  //     event frame never sees a lifecycle or byte message — the route type
  //     enforces it.
  //   - `onByteOutput` handles `PaneOutputMessage` via the binary
  //     side-channel. Bytes are routed here via
  //     `client.attachBytesSink`, not through `client.on('*', …)`,
  //     because the emitter no longer carries byte messages.
  // -------------------------------------------------------------------------

  // [LAW:one-source-of-truth] `connectionState` is the one authority for
  // "the transport told us it closed" (src/client.ts); `closed` is terminal
  // and emitted once. `exit` is not consulted: it can precede the close and
  // already rides the wire as data for the browser to interpret.
  private onUpstreamEvent(msg: EmitterMessage): void {
    if (msg.type === "connection-state" && msg.state.status === "closed") {
      this.closeForUpstream(msg.state);
      return;
    }
    this.onWireEvent(msg);
  }

  // [LAW:single-enforcer] Upstream death routes through the same fatal-close
  // enforcer as every other fatal; the close event it provokes drives
  // `finalize`, which emits the one connection-closed event.
  // [LAW:one-type-per-behavior] BRIDGE_CLOSED is the code bridge-dispatch
  // already assigns to a call the upstream's close rejected; all three close
  // reasons take this one path and the reason rides in the message.
  // [LAW:no-silent-failure] Replaces a connection that stayed `ready` with
  // no events and every call answered BRIDGE_CLOSED, indistinguishable from
  // an idle tmux.
  private closeForUpstream(
    state: Extract<TmuxConnectionState, { status: "closed" }>,
  ): void {
    // Emitted ahead of the fatal rather than behind its write-once guard:
    // when an earlier fatal already holds the wire, the upstream's death is
    // still a fact about this connection and still lands on its panel.
    // [LAW:nothing-unseen]
    this.emit({
      kind: "upstream-closed",
      identity: this.identity,
      reason: state.reason,
    });
    this.sendFatalAndClose(
      "BRIDGE_CLOSED",
      `upstream tmux connection closed (${state.reason})`,
    );
  }

  private onWireEvent(msg: EmitterMessage): void {
    if (this.ws.readyState !== WEBSOCKET_OPEN) return;
    if (this.state.kind !== "running" && this.state.kind !== "draining") {
      return;
    }
    // [LAW:single-enforcer] The bridge decides who an event reaches.
    const bridge = this.state.bridge;
    const route = bridge.routeEvent(msg);
    if (!bridge.deliversTo(this.state.peer, route)) return;
    const encoded = encodeServerFrame({ k: "event", msg: route.msg });
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
    switch (this.state.kind) {
      // Never welcomed, so there is no work to drain and no deadline to
      // keep: refused as a connection arriving now is. onHello's teardown
      // check unwinds whatever it builds before it could commit to running.
      case "pending-hello":
      case "handshaking":
        this.sendFatalAndClose("BRIDGE_CLOSED", SHUTTING_DOWN, GOING_AWAY);
        return;
      case "running":
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
        return;
      case "draining":
      case "closed":
        return;
    }
  }

  terminate(): void {
    this.terminateWith(
      new BridgeError("BRIDGE_CLOSED", "terminated by server shutdown"),
      "shutdown",
    );
  }

  // [LAW:single-enforcer] The heartbeat is the liveness mechanism this
  // server owns, and the close handshake is a liveness question: once
  // sendFatalAndClose has issued `ws.close()`, the peer's close frame is
  // the only thing finalize is waiting on, and this deadline bounds that
  // wait (RFC 6455 §7.1.1's "reasonable time"). `this.fatal` is the
  // discriminator of which phase the connection is in: no fatal pending
  // means the peer missed a pong on a live connection and the fatal close
  // starts; a fatal pending means the peer is not answering the close
  // handshake either, so the socket is terminated with that fatal intact.
  // The bound is one heartbeat cycle, the same a live connection gets; a
  // transport with its own close timer (ws destroys the socket 30s after
  // close()) may win the race, and its close event reports the same fatal.
  private onPongDeadline(): void {
    if (this.fatal === undefined) {
      this.sendFatalAndClose(
        "BRIDGE_CLOSED",
        `heartbeat timeout after ${this.defaults.heartbeat.timeoutMs}ms`,
      );
      return;
    }
    this.terminateWith(this.fatal, "heartbeat");
  }

  // [LAW:one-type-per-behavior] Forced close, from either caller: tear the
  // socket down without waiting for the peer's close frame, and run the
  // one cleanup path now. The `close` event `ws.terminate()` later emits
  // finds the connection already closed. Who forced it is a value on the
  // one event, so a shutdown and a stuck close handshake stay tellable
  // apart in the observability stream. [LAW:nothing-unseen]
  private terminateWith(
    reasonIfNoFatal: BridgeError,
    by: Extract<SocketEnd, { kind: "terminated" }>["by"],
  ): void {
    if (this.state.kind === "closed") return;
    try {
      this.ws.terminate();
    } catch {
      // already gone
    }
    this.finalize(reasonIfNoFatal, { kind: "terminated", by });
  }

  // -------------------------------------------------------------------------
  // Reply helpers
  // -------------------------------------------------------------------------
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
    wsCode: ServerCloseCode = INTERNAL_ERROR,
  ): void {
    // write-once: `ws.close()` itself is one-shot at the wire — a second
    // call can't change the code/reason already sent to the peer — so a
    // second sendFatalAndClose before the real "close" event lands must not
    // overwrite the BridgeError the first call already fixed. Without this
    // guard, two synchronous fatal paths (e.g. a malformed frame immediately
    // followed by a binary frame, both landing before any await yields)
    // would report the second's code against the first's wire-level close.
    // [LAW:single-enforcer] [LAW:one-source-of-truth]
    if (this.fatal !== undefined) return;
    sendFatal(this.ws, code, message);
    this.fatal = new BridgeError(code, message);
    // [LAW:dataflow-not-control-flow] Every close handshake this connection
    // opens runs under the heartbeat's deadline (see onPongDeadline),
    // whatever state the connection was in: a fatal before hello has no
    // heartbeat running yet, and start() is idempotent for one that does.
    // Started before close(), so a close() that throws is under it too.
    this.heartbeat.start();
    // [LAW:no-silent-failure] A stamped code and a truncated reason are what
    // close() accepts, so a throw from it is a defect and propagates.
    this.ws.close(wsCode, truncateCloseReason(message));
  }

  // -------------------------------------------------------------------------
  // Finalize — the single cleanup path.
  // -------------------------------------------------------------------------
  // [LAW:one-source-of-truth] A pending fatal is the reason the peer was
  // already given (sendFatalAndClose is write-once), so it is the reason
  // connection-closed reports, however the socket then ended. Callers pass
  // only the reason for an ending nothing preceded: a socket error, a
  // shutdown termination, or nothing at all for a peer's own close.
  private finalize(
    reasonIfNoFatal: BridgeError | undefined,
    socketEnd: SocketEnd,
  ): void {
    if (this.state.kind === "closed") return;
    const fatal = this.fatal ?? reasonIfNoFatal;

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
      this.disposeClientSafely(final.client, final.ctx);
    }

    const closeFrame = socketEnd.kind === "close-event" ? socketEnd : undefined;
    // The close frame's own text rides on socketEnd; here the fatal's message
    // comes first so a transport's empty-reason close (ws's 1006 "") cannot
    // blank the reason the peer was given.
    this.emit({
      kind: "connection-closed",
      identity: this.identity,
      code: closeFrame?.code,
      reason: fatal?.message ?? closeFrame?.reason,
      errorCode: fatal?.code,
      socketEnd,
    });

    this.closed();
  }

  private emit(ev: BridgeObservabilityEvent): void {
    emitObservability(this.opts, ev);
  }

  // [LAW:composability] [LAW:carrying-cost] Single place for "dispose the
  // client if the caller configured a hook" — every call site (orphaned
  // mid-handshake-race, orphaned by a bridge-construction failure, and the
  // normal finalize teardown) needs the same guard. disposeClient is
  // caller-supplied, arbitrary code: a throw or rejection here must not
  // propagate into the caller of this method (same rule as emit()), but
  // swallowing it outright would be the exact silent failure this method
  // exists to prevent — so a failing hook is surfaced as
  // client-dispose-failed instead. [LAW:no-silent-failure]
  private disposeClientSafely(
    client: TmuxClient,
    ctx: ConnectionContext,
  ): void {
    if (this.opts.disposeClient === undefined) return;
    const onFailure = (err: unknown): void => {
      this.emit({
        kind: "client-dispose-failed",
        identity: this.identity,
        message: err instanceof Error ? err.message : String(err),
      });
    };
    try {
      void Promise.resolve(this.opts.disposeClient(client, ctx)).catch(
        onFailure,
      );
    } catch (err) {
      onFailure(err);
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

// [LAW:single-enforcer] The one place an onEvent hook is called, for the
// bridge's own events and every connection's.
function emitObservability(
  opts: WebSocketBridgeOptions,
  ev: BridgeObservabilityEvent,
): void {
  if (opts.onEvent === undefined) return;
  try {
    opts.onEvent(ev);
  } catch {
    // Swallow — observability hooks must never break the bridge.
  }
}

async function allClosed(conns: Set<Connection>): Promise<void> {
  await Promise.all([...conns].map((c) => c.whenClosed));
}
