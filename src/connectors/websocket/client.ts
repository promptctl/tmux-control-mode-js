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
// [LAW:decomposition] Three collaborators each own one concern that was
// previously fused into this class: `Outbox` (call correlation + timeout + the
// un-transmitted send queue), `Heartbeat` (ping/pong liveness), and
// `ReconnectController` (retry budget + backoff + retry timer). This class is
// the wiring shell + protocol spine: it owns connection-state authority, frame
// ingress/dispatch, socket open/close, and the RPC-proxy facade.
// [LAW:single-enforcer] `finalizeConnection` is the only cleanup site; every
// close/error/reconnect flows through it. It drains the outbox and stops the
// heartbeat together so callers cannot observe a half-closed client.

import {
  sameConnectionState,
  type ConnectionState,
} from "../../connection-state.js";
import {
  TypedEmitter,
  isTmuxMessage,
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
}
import {
  isPaneOutput,
  type CommandResponse,
  type PaneAction,
  type PaneRecord,
  type SessionRecord,
  type TmuxMessage,
  type WindowRecord,
} from "../../protocol/types.js";
import type { SplitOptions, TmuxConnection } from "../../client.js";

import type { RpcProxyApi, RpcResponseMap } from "../rpc.js";
import { type AttachOptions, type BytesSink } from "../../pane-output.js";
import { TopologyRouter, type RunCommand } from "../../topology-router.js";
import { DeliveryQueue } from "../../delivery-queue.js";
import { invalidCommand } from "../../errors.js";
import {
  BridgeError,
  decodePaneOutput,
  encodeClientFrame,
  isPaneOutputFrame,
  parseServerFrame,
  toBridgeProtocolError,
  type ReceivedResultFrame,
  type ReceivedServerFrame,
  type RpcMethod,
  type WelcomeFrame,
  type WelcomeLimits,
} from "./protocol.js";

import type { BrowserWebSocketLike, ReconnectPolicy } from "./types.js";
import { WEBSOCKET_OPEN } from "./types.js";
import { Heartbeat } from "./heartbeat.js";
import {
  minDurationMs,
  parseDurationMs,
  parseHeartbeatInterval,
  type DurationMs,
  type HeartbeatInterval,
} from "./limits.js";
import { Outbox } from "./outbox.js";
import { ReconnectController } from "./reconnect-controller.js";

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
  /** Reconnect policy; each field's shape is on `ReconnectPolicy`, and one
   *  outside it makes the constructor throw `BRIDGE_INVALID_ARG`. Default: no
   *  reconnect. */
  readonly reconnect?: ReconnectPolicy;
  /** Per-call timeout: an integer number of ms in [1, 2^31-1] or the
   *  constructor throws `BRIDGE_INVALID_ARG`. Default: 30000. The server's
   *  welcome value wins if smaller. */
  readonly requestTimeoutMs?: number;
  /** App-level ping interval ms: `0` disables, otherwise an integer number of
   *  ms in [1, 2^31-1] or the constructor throws `BRIDGE_INVALID_ARG`.
   *  Default: the server's welcome value. */
  readonly heartbeatIntervalMs?: number;
  /** Pong timeout ms: an integer number of ms in [1, 2^31-1] or the
   *  constructor throws `BRIDGE_INVALID_ARG`. Default: 10000. */
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
  heartbeatTimeoutMs: 10_000,
}) satisfies Record<string, number>;

// ---------------------------------------------------------------------------
// WebSocketTmuxClient
// ---------------------------------------------------------------------------

export class WebSocketTmuxClient implements RpcProxyApi, TmuxConnection {
  private readonly emitter = new TypedEmitter();
  // [LAW:single-enforcer] When consumer code runs: every entry point — a
  //   public method, a socket event, a timer, a promise's continuation — is
  //   one step, and the listeners, error handlers and sinks it notified hear
  //   of it once the step has committed. No transition here is ordered for
  //   the sake of a callback that re-enters.
  private readonly delivery = new DeliveryQueue();
  private readonly emit = (msg: EmitterMessage): void => this.emitter.emit(msg);
  private readonly notifyError = (err: BridgeError): void =>
    this.opts.onError?.(err);
  private readonly notifyDraining = (deadlineMs: number): void =>
    this.opts.onDraining?.(deadlineMs);
  // [LAW:one-source-of-truth] All byte routing, topology, and bootstrap logic
  //   lives in TopologyRouter. This client injects execute() as the command runner.
  // [LAW:effects-at-boundaries] The router describes a bootstrap failure; this
  //   adapter performs the emission (emitter and queue are declared above, so
  //   their initializers have already run when this one does).
  private readonly router = new TopologyRouter(this.delivery, (error) =>
    this.emitter.emit({ type: "topology-error", error }),
  );
  // [LAW:decomposition] Call correlation + timeout + the un-transmitted send
  // queue live in one collaborator; this shell holds no in-flight call state.
  private readonly outbox: Outbox;
  // [LAW:decomposition] Reconnect budget + backoff + retry timer.
  private readonly reconnect: ReconnectController;
  // Enables this client holds; the server-side peer forgets them on reconnect.
  private crossSessionLayoutEnables = 0;
  // [LAW:decomposition] Ping/pong liveness. Connection-scoped: a fresh probe is
  // built each welcome (its cadence is only known then, from the server limits)
  // and stopped on finalize, so this shell holds no heartbeat/ping-id state.
  private heartbeat: Heartbeat<string> | null = null;
  // [LAW:parse-dont-validate] The consumer's timing choices, stamped once in
  // the constructor so a bad value fails there with its option's name, not
  // at every welcome or every call. `undefined` for the interval means "the
  // server's".
  private readonly heartbeatIntervalMs: HeartbeatInterval | undefined;
  private readonly heartbeatTimeoutMs: DurationMs;
  private readonly requestTimeoutMs: DurationMs;

  private ws: BrowserWebSocketLike | null = null;
  // [LAW:single-enforcer] One controller per connection scopes the lifetime
  // of every listener attached to its ws. finalizeConnection aborts it; the
  // ws library removes all listeners in one operation. No per-listener
  // staleness check exists or is needed.
  private connectionAbort: AbortController | null = null;
  private nextId = 0;
  private serverLimits: WelcomeLimits | null = null;
  // The runner this connection handed the router; null until welcome and
  // after the drop that retires it.
  private routerRun: RunCommand | null = null;
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
    this.heartbeatIntervalMs =
      opts.heartbeatIntervalMs === undefined
        ? undefined
        : parseHeartbeatInterval(
            "heartbeatIntervalMs",
            opts.heartbeatIntervalMs,
          );
    this.heartbeatTimeoutMs = parseDurationMs(
      "heartbeatTimeoutMs",
      opts.heartbeatTimeoutMs ?? DEFAULTS.heartbeatTimeoutMs,
    );
    this.requestTimeoutMs = parseDurationMs(
      "requestTimeoutMs",
      opts.requestTimeoutMs ?? DEFAULTS.requestTimeoutMs,
    );
    // [LAW:decomposition] Wire the collaborators: the outbox transmits through
    // the shell's ready/OPEN gate; the reconnect controller reopens the socket
    // when its backoff timer fires. Neither knows connection state directly.
    this.outbox = new Outbox((frame) => this.transmitFrame(frame));
    this.reconnect = new ReconnectController(opts.reconnect, {
      onRetry: () => this.delivery.step(() => this.openSocket()),
    });
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
    this.delivery.step(() => this.open());
  }

  private open(): void {
    // [LAW:one-source-of-truth] Gate on the physical connection facts — a
    // live socket or an armed retry timer — not on connectionState. The
    // initial state is "connecting" before any socket exists (the unified
    // union has no idle variant), so a status guard would make connect() a
    // permanent no-op under autoConnect: false.
    // [LAW:no-ambient-temporal-coupling] During reconnect backoff the timer
    // owns the retry; the timer check keeps a manual connect() from opening
    // a second socket underneath it.
    if (this.ws !== null || this.reconnect.isPending()) {
      return;
    }
    this.userRequestedClose = false;
    // [LAW:no-ambient-temporal-coupling] connect() is the consumer-initiated
    // episode boundary: the retry budget and the episode's error belong to
    // the previous episode and must not leak into this one. openSocket() is
    // NOT the reset point — the reconnect timer also calls it, and resetting
    // there would make maxAttempts unreachable.
    this.reconnect.reset();
    this.lastError = undefined;
    this.openSocket();
  }

  async close(): Promise<void> {
    this.delivery.step(() => this.dispose());
  }

  private dispose(): void {
    // [LAW:one-source-of-truth] Contract: when this resolves, no pending
    // promise remains in flight. The pre-fix bug (M3) left pending alive
    // until the async ws.onclose fired, giving callers a window where
    // `await client.close()` returned but their promises were unsettled.
    // Driving finalize inline closes that window; the later ws.onclose hits
    // finalize's idempotency guard and returns.
    this.userRequestedClose = true;
    // [LAW:single-enforcer] The controller is the sole owner of the retry
    // timer's teardown; cancelling here guarantees no scheduled retry fires
    // after this close.
    this.reconnect.cancel();
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
    const invalid = invalidCommand(command);
    if (invalid !== null) return Promise.reject(invalid);
    return this.call("execute", [command]);
  }

  listWindows(): Promise<readonly WindowRecord[]> {
    return this.call("listWindows", []);
  }

  listPanes(): Promise<readonly PaneRecord[]> {
    return this.call("listPanes", []);
  }

  listSessions(): Promise<readonly SessionRecord[]> {
    return this.call("listSessions", []);
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

  // Coverage is held by this connection's server-side peer, which a
  // reconnect replaces with a fresh one holding none. The client owns the
  // count of outstanding enables and replays it on every welcome, so
  // coverage survives a reconnect the way it does on a direct TmuxClient.
  async enableCrossSessionLayoutChange(): Promise<void> {
    await this.call("enableCrossSessionLayoutChange", []);
    this.crossSessionLayoutEnables += 1;
  }

  async disableCrossSessionLayoutChange(): Promise<void> {
    // The server drops the peer's enable whatever tmux says about cleanup,
    // so the local count follows the call, not its outcome.
    this.crossSessionLayoutEnables = Math.max(
      0,
      this.crossSessionLayoutEnables - 1,
    );
    await this.call("disableCrossSessionLayoutChange", []);
  }

  // [LAW:no-silent-failure] A replay the new server refuses leaves coverage
  // off; the client's error channel says so.
  // [LAW:single-enforcer] A replay belongs to the connection `run` names. One
  //   refused after that connection ended is its end, which `closed` or
  //   `reconnecting` already announced — the router's identity rule for late
  //   evidence about an earlier connection.
  //   An enable sent after it ended would queue for the next connection, whose
  //   welcome replays the full count again.
  private replayCrossSessionLayoutEnables(run: RunCommand): void {
    for (
      let i = 0;
      i < this.crossSessionLayoutEnables && this.routerRun === run;
      i++
    ) {
      void this.delivery.settle(
        () => this.call("enableCrossSessionLayoutChange", []),
        (replayed) => {
          if (replayed.ok || this.routerRun !== run) return;
          const err = replayed.error;
          this.emitError(
            err instanceof BridgeError
              ? err
              : new BridgeError(
                  "BRIDGE_INTERNAL",
                  `re-enabling cross-session layout coverage after reconnect failed: ${err instanceof Error ? err.message : typeof err}`,
                ),
          );
        },
      );
    }
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
  private call<M extends RpcMethod>(
    method: M,
    args: readonly unknown[],
  ): Promise<RpcResponseMap[M]> {
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
    return this.outbox.enqueue(id, method, frame, this.effectiveTimeoutMs());
  }

  private id(): string {
    this.nextId += 1;
    return `r${this.nextId}`;
  }

  // The consumer's bound until a welcome lands (calls queue in the outbox
  // before then), and the stricter of the consumer's and the server's after.
  private effectiveTimeoutMs(): DurationMs {
    return this.serverLimits === null
      ? this.requestTimeoutMs
      : minDurationMs(
          this.requestTimeoutMs,
          this.serverLimits.requestTimeoutMs,
        );
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

    // Every socket event is one step.
    ws.addEventListener("open", () => this.delivery.step(this.onOpen), opts);
    ws.addEventListener(
      "message",
      (event: { data: unknown }) =>
        this.delivery.step(this.onMessage, event.data),
      opts,
    );
    ws.addEventListener(
      "close",
      (event: { code?: number; reason?: string }) =>
        this.delivery.step(this.onClose, event),
      opts,
    );
    ws.addEventListener("error", () => this.delivery.step(this.onError), opts);
  }

  // Socket listeners, bound once: a socket event steps with no closure.
  private readonly onOpen = (): void => {
    this.rawSend(encodeClientFrame({ k: "hello" }));
  };

  // Error events in the browser are opaque. Treat as a connection error; the
  // 'close' that follows will drive the actual teardown.
  private readonly onError = (): void => {
    this.emitError(new BridgeError("BRIDGE_INTERNAL", "websocket error"));
  };

  private readonly onMessage = (data: unknown): void => {
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
  };

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
      // [LAW:single-enforcer] Normalization lives in toBridgeProtocolError.
      this.emitError(toBridgeProtocolError(err));
      return;
    }
    this.dispatchEvent(msg);
  }

  private onText(raw: string): void {
    let frame: ReceivedServerFrame;
    try {
      frame = parseServerFrame(raw);
    } catch (err) {
      // [LAW:single-enforcer] Normalization lives in toBridgeProtocolError.
      this.emitError(toBridgeProtocolError(err));
      return;
    }
    this.handleFrame(frame);
  }

  // [LAW:dataflow-not-control-flow] One indexed lookup; the variant in
  // ReceivedServerFrame is what decides which handler runs. Mapped-type table forces
  // exhaustiveness — same shape as VALIDATORS in ../rpc.ts and the
  // CLIENT_FRAME_HANDLERS table on the server side.
  private handleFrame(frame: ReceivedServerFrame): void {
    WebSocketTmuxClient.frameHandlers[frame.k](this, frame as never);
  }

  // [LAW:dataflow-not-control-flow] One entry per ServerFrame variant; the
  //   mapped type forces exhaustiveness, so a new ServerFrame kind without a
  //   handler is a compile-time error, not a runtime "unknown kind" branch.
  // [LAW:single-enforcer] handleFrame is the only call site. Declared in the
  //   class so the handlers it calls stay private: each runs inside a socket
  //   event's step and posts to it.
  private static readonly frameHandlers: ServerFrameHandlers = Object.assign(
    Object.create(null) as ServerFrameHandlers,
    {
      welcome: (self, f: WelcomeFrame) => self.onWelcome(f),
      // Synthetic events carry no topology or bytes, so they bypass the router.
      event: (self, f) =>
        isTmuxMessage(f.msg) ? self.dispatchEvent(f.msg) : self.announce(f.msg),
      result: (self, f: ReceivedResultFrame) => self.onResult(f),
      pong: (self, f) => self.heartbeat?.onPong(f.id),
      draining: (self, f) => self.onDraining(f.deadlineMs),
      error: (self, f) => self.emitError(BridgeError.fromPayload(f.error)),
    } satisfies ServerFrameHandlers,
  );

  private onWelcome(frame: WelcomeFrame): void {
    this.serverLimits = frame.limits;
    // Reaching ready is the success point: reset the retry budget for the next
    // episode. This is the single reset that covers both entry paths — it is
    // load-bearing for the retry-timer path (onRetry → openSocket → onWelcome,
    // where connect() never ran) and redundant-but-harmless (reset() is
    // idempotent) for the manual connect() path.
    this.reconnect.reset();
    // [LAW:one-source-of-truth] lastError describes the current reconnecting
    // episode only. Wiping it on entry into ready means any *subsequent* close
    // maps from a clean slate — a clean exit can't be misreported as
    // transport-error because of a stale error from before the last reconnect.
    this.lastError = undefined;
    this.setConnectionState({ status: "ready" });
    this.startHeartbeat(frame.limits);
    // The runner names this connection, for the router and for the replay.
    const run: RunCommand = (cmd) => this.execute(cmd);
    this.routerRun = run;
    // [LAW:one-source-of-truth] TopologyRouter owns bootstrap and sink-registry management.
    //   After "ready" is committed, so the bootstrap's execute() is transmitted.
    // [LAW:no-ambient-temporal-coupling] The router holds this connection's
    //   runner before anything is sent on it, so a send that ends the
    //   connection retires the runner the router actually holds.
    this.router.onTransportReady(run);
    // Restore this client's coverage on the new peer before anything queued
    // during the outage, so a queued disable lands after the enables it undoes.
    this.replayCrossSessionLayoutEnables(run);
    this.outbox.flush();
  }

  private onResult(frame: ReceivedResultFrame): void {
    const violation = this.outbox.settle(frame);
    if (violation !== undefined) this.emitError(violation);
  }

  private onDraining(deadlineMs: number): void {
    // The server keeps serving in-flight calls until the deadline, so the
    // connection stays "ready"; only new calls are refused (see call()).
    this.draining = true;
    this.delivery.post(this.notifyDraining, deadlineMs);
  }

  private dispatchEvent(msg: TmuxMessage): void {
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
    this.announce(msg);
  }

  private readonly onClose = (event: {
    code?: number;
    reason?: string;
  }): void => {
    const reason =
      event.reason !== undefined && event.reason.length > 0
        ? event.reason
        : event.code !== undefined
          ? `close ${event.code}`
          : "closed";
    const err = new BridgeError("BRIDGE_CLOSED", reason);
    this.finalizeConnection(err);
  };

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
    this.heartbeat?.stop();
    // [LAW:no-ambient-temporal-coupling] Null the socket BEFORE draining. A
    // rejection handler running synchronously inside drain() must never observe
    // a logically-dead socket — with the reference already cleared, any code
    // that reaches for this.ws sees null, not a zombie. drain() itself only
    // rejects/clears the pending map, so the order is safe.
    this.ws = null;

    // [LAW:one-source-of-truth] The outbox is the only structure holding
    // in-flight calls or queued frames; draining it rejects both. The
    // pre-fix bug (M2) was a separate outbox surviving teardown, then
    // re-sending frames whose caller was already rejected.
    // [LAW:no-ambient-temporal-coupling] The router retires its query runner
    //   first, so the rejections drain delivers read as the drop they are.
    if (this.routerRun !== null) this.router.onTransportLost(this.routerRun);
    this.routerRun = null;
    this.outbox.drain(err);
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

    // [LAW:dataflow-not-control-flow] The controller returns one decision
    // value; this switch maps it onto connection state and does nothing else.
    // The retry timer (if any) is armed inside schedule() — its sole owner.
    const decision = this.reconnect.schedule();
    switch (decision.kind) {
      case "disabled":
        this.router.onTransportClose();
        // [LAW:one-source-of-truth] lastError distinguishes an error-driven
        // close from a clean exit; onWelcome clears it on entry into ready.
        this.setConnectionState({
          status: "closed",
          reason: this.lastError !== undefined ? "transport-error" : "exit",
        });
        return;
      case "exhausted":
        this.emitError(
          new BridgeError(
            "BRIDGE_CLOSED",
            `reconnect gave up after ${decision.maxAttempts} attempts`,
          ),
        );
        this.router.onTransportClose();
        this.setConnectionState({
          status: "closed",
          reason: "transport-error",
        });
        return;
      case "scheduled":
        this.setConnectionState({
          status: "reconnecting",
          attempt: decision.attempt,
          ...(this.lastError !== undefined
            ? { lastError: this.lastError }
            : {}),
        });
        return;
    }
  }

  // -------------------------------------------------------------------------
  // Internal: send paths
  //
  // Two send paths exist because frames have different lifecycles:
  //   - Call frames carry a pending caller. They must persist across
  //     reconnect attempts until either delivered or finalized. The Outbox
  //     owns them and transmits through the `transmitFrame` gate below.
  //   - Hello / ping / bye are connection-scoped fire-and-forget. They
  //     make no sense across a connection boundary (a stale hello on a new
  //     socket would be a protocol error; a stale ping would corrupt the
  //     pong correlation). They go through `rawSend()` and are dropped if
  //     the socket is not OPEN — the next reconnect emits fresh ones.
  // -------------------------------------------------------------------------

  // [LAW:effects-at-boundaries] The ready/OPEN gate the outbox transmits
  // through. Returns true iff the ws accepted the frame; never throws.
  //
  // [LAW:one-source-of-truth] The gate is `connectionState.status === "ready"`,
  // not just `ws.readyState === OPEN`. The ws may be OPEN in the brief window
  // between onOpen and onWelcome, but the server rejects any non-hello frame
  // while it is pending-hello (server.ts) and would close the connection with
  // a protocol error. "ready" is the canonical "handshake complete, server
  // accepting calls" predicate; checking ws.readyState is a belt-and-
  // suspenders sanity check after that.
  private transmitFrame(frame: string): boolean {
    if (this.currentConnectionState.status !== "ready") return false;
    if (this.ws === null || this.ws.readyState !== WEBSOCKET_OPEN) return false;
    try {
      this.ws.send(frame);
      return true;
    } catch {
      return false;
    }
  }

  // Fire-and-forget for hello/ping/bye. No retry, no queue — if the socket
  // is not OPEN the frame is simply dropped. The caller (onOpen / the
  // heartbeat's ping / close) treats success as best-effort.
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
  //
  // [LAW:no-ambient-temporal-coupling] A heartbeat is connection-scoped: its
  // cadence is only known once the server's welcome limits arrive, and its
  // outstanding ping must not survive the socket it was sent on. So a fresh
  // Heartbeat is built per welcome and stopped in finalize — no probe state
  // outlives its connection.
  // -------------------------------------------------------------------------
  private startHeartbeat(limits: WelcomeLimits): void {
    this.heartbeat?.stop();
    // [LAW:one-type-per-behavior] The client's ping correlates its pong by id
    // (Token = string); ping() emits the frame and returns the id the matching
    // pong will carry, so the shell holds no ping-id state.
    // Cadence policy: the consumer's interval when given, else the server's
    // advertised one — both stamped at their borders (constructor, parseWelcome).
    const heartbeat = new Heartbeat<string>(
      {
        intervalMs: this.heartbeatIntervalMs ?? limits.heartbeatIntervalMs,
        timeoutMs: this.heartbeatTimeoutMs,
      },
      {
        // A timer's callback is an entry point: a socket whose send or close
        // fires its events synchronously settles them inside this step.
        ping: () =>
          this.delivery.step(() => {
            const id = this.id();
            this.rawSend(encodeClientFrame({ k: "ping", id }));
            return id;
          }),
        onTimeout: () =>
          this.delivery.step(() => {
            // No pong — kill the socket and let the close/reconnect path run.
            try {
              this.ws?.close(4000, "heartbeat timeout");
            } catch {
              // ignore
            }
          }),
      },
    );
    this.heartbeat = heartbeat;
    heartbeat.start();
  }

  // -------------------------------------------------------------------------
  // Internal: state + error emitters
  // -------------------------------------------------------------------------

  // [LAW:one-source-of-truth] Sole writer for currentConnectionState. Announces
  // the connection-state event and the reconnected event when transitioning
  // into ready for the second or later time.
  private setConnectionState(next: ConnectionState): void {
    if (sameConnectionState(this.currentConnectionState, next)) return;
    this.currentConnectionState = next;
    this.announce({ type: "connection-state", state: next });
    if (next.status === "ready") {
      // [LAW:one-source-of-truth] 'reconnected' fires on every transition into
      // ready AFTER the first such transition — not just from "reconnecting".
      // Manual close→connect cycles count as a reconnect.
      if (this.hasReachedReadyOnce) {
        this.announce({ type: "reconnected" });
      } else {
        this.hasReachedReadyOnce = true;
      }
    }
  }

  private announce(msg: EmitterMessage): void {
    this.delivery.post(this.emit, msg);
  }

  private emitError(err: BridgeError): void {
    this.lastError = err;
    this.delivery.post(this.notifyError, err);
    // Re-publish so a reconnecting state's lastError reflects the latest error.
    if (this.currentConnectionState.status === "reconnecting") {
      this.setConnectionState({
        status: "reconnecting",
        attempt: this.reconnect.currentAttempt,
        lastError: err,
      });
    }
  }
}

// Per-kind ServerFrame handlers: WebSocketTmuxClient.frameHandlers.
type ServerFrameHandlers = {
  readonly [K in ReceivedServerFrame["k"]]: (
    self: WebSocketTmuxClient,
    frame: Extract<ReceivedServerFrame, { k: K }>,
  ) => void;
};
