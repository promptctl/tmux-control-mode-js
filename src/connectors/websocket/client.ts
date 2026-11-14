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
  emit(msg: EmitterMessage): void;
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
import { invalidCommand } from "../../errors.js";
import {
  BridgeError,
  decodePaneOutput,
  encodeClientFrame,
  isPaneOutputFrame,
  parseServerFrame,
  toBridgeProtocolError,
  truncateCloseReason,
  type ReceivedResultFrame,
  type ReceivedServerFrame,
  type RpcMethod,
  type WelcomeFrame,
  type WelcomeLimits,
  type WireSyntheticMessage,
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

// The close codes the client sends. A browser's close() throws for any code
// other than 1000 or 3000-4999, so the client's own faults use the 4xxx
// private-use range.
const CLOSE_NORMAL = 1000;
const CLOSE_HEARTBEAT_TIMEOUT = 4000;
const CLOSE_PROTOCOL_ERROR = 4002;

// ---------------------------------------------------------------------------
// Socket routing
//
// [LAW:dataflow-not-control-flow] A socket's listeners stay attached for the
// socket's whole life and dispatch through its connection's route. Finalize
// points the route at RETIRED, so a socket whose connection has ended reaches
// nothing: the variability is which table the route holds, not whether a
// listener exists. Listeners are never removed: the `ws` package ignores
// addEventListener's `{ signal }`, and a ws socket with no 'error' listener
// throws its next error (close() while CONNECTING emits one) as an uncaught
// exception. A retired socket's error is dropped; its connection already
// ended with the reason the client gave it.
// ---------------------------------------------------------------------------

interface SocketHandlers {
  open(): void;
  message(data: unknown): void;
  close(event: { code?: number; reason?: string }): void;
  error(): void;
}

const RETIRED: SocketHandlers = Object.freeze({
  open: () => undefined,
  message: () => undefined,
  close: () => undefined,
  error: () => undefined,
});

// ---------------------------------------------------------------------------
// WebSocketTmuxClient
// ---------------------------------------------------------------------------

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
  // The route the current socket's listeners dispatch through (see Socket
  // routing). openSocket gives each socket a fresh live one; finalize retires
  // it. Retired before any socket exists.
  private route: { handlers: SocketHandlers } = { handlers: RETIRED };
  private readonly live: SocketHandlers = {
    open: () => this.onOpen(),
    message: (data) => this.onMessage(data),
    close: (event) => this.onClose(event),
    // Error events in the browser are opaque. Treat as a connection error;
    // the 'close' that follows will drive the actual teardown.
    error: () =>
      this.emitError(new BridgeError("BRIDGE_INTERNAL", "websocket error")),
  };
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
      onRetry: () => this.openSocket(),
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
    // [LAW:one-source-of-truth] Contract: when this resolves, no pending
    // promise remains in flight. The pre-fix bug (M3) left pending alive
    // until the async ws.onclose fired, giving callers a window where
    // `await client.close()` returned but their promises were unsettled.
    // Driving finalize inline closes that window; the later close event
    // reaches the socket's retired route.
    this.userRequestedClose = true;
    // [LAW:single-enforcer] The controller is the sole owner of the retry
    // timer's teardown; cancelling here guarantees no scheduled retry fires
    // after this close.
    this.reconnect.cancel();
    // rawSend gates on OPEN internally — bye only goes on a live socket.
    this.rawSend(encodeClientFrame({ k: "bye" }));
    // Closes the socket whatever its readyState: on a CONNECTING socket
    // ws.close() aborts the handshake per the WebSocket spec.
    this.abortSocket(
      new BridgeError("BRIDGE_CLOSED", "client close"),
      CLOSE_NORMAL,
    );
  }

  // [LAW:single-enforcer] The one way the client ends a socket on its own
  // initiative: close(), or a fault (failConnection). Finalize runs first so
  // the outbox and the state see `err` whether the runtime fires the close
  // event inside ws.close() or later; by then the socket's route is retired,
  // so that event reaches nothing. The socket is absent during reconnect
  // backoff, when close() has only the retry to cancel.
  // [LAW:no-silent-failure] No catch around ws.close(): the code is one of
  // the constants above and truncateCloseReason makes the reason legal, so a
  // throw is a defect, and swallowing it would leave the socket open after
  // finalize.
  private abortSocket(err: BridgeError, code: number): void {
    const ws = this.ws;
    this.finalizeConnection(err);
    ws?.close(code, truncateCloseReason(err.toPayload().message));
  }

  // [LAW:single-enforcer] The one way a fault the client finds ends the
  // connection: a failed handshake, a heartbeat timeout, a socket the factory
  // could not create. The fault is recorded first, so the state finalize
  // publishes reads it ("transport-error", or reconnecting with lastError),
  // and reported last.
  // [LAW:no-ambient-temporal-coupling] onError may close() or connect(); the
  // connection it acts on is already the next one, so nothing after the
  // report touches the connection the fault ended.
  private failConnection(err: BridgeError, code: number): void {
    this.lastError = err;
    this.abortSocket(err, code);
    this.emitError(err);
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
  private replayCrossSessionLayoutEnables(): void {
    for (let i = 0; i < this.crossSessionLayoutEnables; i++) {
      this.call("enableCrossSessionLayoutChange", []).catch((err: unknown) =>
        this.emitError(
          err instanceof BridgeError
            ? err
            : new BridgeError(
                "BRIDGE_INTERNAL",
                `re-enabling cross-session layout coverage after reconnect failed: ${err instanceof Error ? err.message : typeof err}`,
              ),
        ),
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
      // The attempt was made and failed. No socket exists, so the close code
      // is never sent.
      this.setConnectionState({ status: "connecting" });
      this.failConnection(
        new BridgeError(
          "BRIDGE_INTERNAL",
          `failed to create WebSocket: ${err instanceof Error ? err.message : String(err)}`,
        ),
        CLOSE_NORMAL,
      );
      return;
    }
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    // [LAW:locality-or-seam] The route IS the seam binding this socket's
    // events to its connection: once finalize retires it, nothing this
    // socket fires reaches the client.
    const route = { handlers: this.live };
    this.route = route;
    ws.addEventListener("open", () => route.handlers.open());
    ws.addEventListener("message", (event: { data: unknown }) =>
      route.handlers.message(event.data),
    );
    ws.addEventListener("close", (event: { code?: number; reason?: string }) =>
      route.handlers.close(event),
    );
    ws.addEventListener("error", () => route.handlers.error());
    // Announced once the socket is routed: a listener that close()s on
    // "connecting" ends this socket, not a client that would open one after.
    this.setConnectionState({ status: "connecting" });
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
    this.onProtocolError(
      new BridgeError(
        "BRIDGE_PROTOCOL_ERROR",
        `unexpected frame type: ${Object.prototype.toString.call(data)}`,
      ),
    );
  }

  private onBinary(buf: Uint8Array): void {
    if (!isPaneOutputFrame(buf)) {
      this.onProtocolError(
        new BridgeError("BRIDGE_PROTOCOL_ERROR", "unknown binary frame magic"),
      );
      return;
    }
    let msg: TmuxMessage;
    try {
      msg = decodePaneOutput(buf);
    } catch (err) {
      // [LAW:single-enforcer] Normalization lives in toBridgeProtocolError.
      this.onProtocolError(toBridgeProtocolError(err));
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
      this.onProtocolError(toBridgeProtocolError(err));
      return;
    }
    this.handleFrame(frame);
  }

  // [LAW:single-enforcer] Every protocol fault the client finds in what the
  // server sent lands here. On a ready connection it is one bad frame: report
  // it, keep serving. Before ready the welcome is the only frame that can move
  // the connection on, so a fault there is a failed handshake: report it, then
  // end the socket so finalize runs and reconnect (or the consumer) sees a
  // closed connection, not an open one that never answers. A retired socket's
  // route reaches nothing, so a fault only ever arrives in "connecting" or
  // "ready".
  // [LAW:dataflow-not-control-flow] The branch is the connection-state enum.
  private onProtocolError(err: BridgeError): void {
    if (this.currentConnectionState.status === "ready") {
      this.emitError(err);
    } else {
      this.failConnection(err, CLOSE_PROTOCOL_ERROR);
    }
  }

  // [LAW:dataflow-not-control-flow] One indexed lookup; the variant in
  // ReceivedServerFrame is what decides which handler runs. Mapped-type table forces
  // exhaustiveness — same shape as VALIDATORS in ../rpc.ts and the
  // CLIENT_FRAME_HANDLERS table on the server side.
  private handleFrame(frame: ReceivedServerFrame): void {
    SERVER_FRAME_HANDLERS[frame.k](this, frame as never);
  }

  onWelcome(frame: WelcomeFrame): void {
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
    // Restore this client's coverage on the new peer before anything queued
    // during the outage, so a queued disable lands after the enables it undoes.
    this.replayCrossSessionLayoutEnables();
    this.outbox.flush();
    // [LAW:one-source-of-truth] TopologyRouter owns bootstrap and sink-registry management.
    //   Called after setConnectionState("ready") so execute() accepts calls from within bootstrap.
    this.routerRun = (cmd) => this.execute(cmd);
    this.router.onTransportReady(this.routerRun);
  }

  onResult(frame: ReceivedResultFrame): void {
    const violation = this.outbox.settle(frame);
    if (violation !== undefined) this.onProtocolError(violation);
  }

  onPong(id: string): void {
    this.heartbeat?.onPong(id);
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

  // Synthetic events carry no topology or bytes, so they bypass the router.
  emitSynthetic(msg: WireSyntheticMessage): void {
    this.emitter.emit(msg);
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
    // [LAW:single-enforcer] Idempotency guard: a close() on a client that is
    // already closed finalizes nothing.
    // [LAW:one-source-of-truth] The guard derives from the one state field:
    // "closed" is exactly the condition under which a second finalize must
    // be a no-op; openSocket() re-arms by entering "connecting".
    if (this.currentConnectionState.status === "closed") return;

    // [LAW:single-enforcer] One operation tears down everything connection-
    // scoped: the socket's route, timers, pending, ws ref.
    // Retiring the route happens first because it severs the inbound event
    // stream — no late event from this socket reaches the client after
    // this line.
    this.route.handlers = RETIRED;
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
        ping: () => {
          const id = this.id();
          this.rawSend(encodeClientFrame({ k: "ping", id }));
          return id;
        },
        // No pong: the peer is dead now, not when the runtime's close
        // handshake gives up on it, so pending calls settle here. It is a
        // fault, so it is reported and the close reads "transport-error".
        onTimeout: () =>
          this.failConnection(
            new BridgeError("BRIDGE_CLOSED", "heartbeat timeout"),
            CLOSE_HEARTBEAT_TIMEOUT,
          ),
      },
    );
    this.heartbeat = heartbeat;
    heartbeat.start();
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
        attempt: this.reconnect.currentAttempt,
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
  readonly [K in ReceivedServerFrame["k"]]: (
    self: WebSocketTmuxClient,
    frame: Extract<ReceivedServerFrame, { k: K }>,
  ) => void;
};

const SERVER_FRAME_HANDLERS: ServerFrameHandlers = Object.assign(
  Object.create(null) as ServerFrameHandlers,
  {
    welcome: (self, f: WelcomeFrame) => self.onWelcome(f),
    event: (self, f) =>
      isTmuxMessage(f.msg)
        ? self.dispatchEvent(f.msg)
        : self.emitSynthetic(f.msg),
    result: (self, f: ReceivedResultFrame) => self.onResult(f),
    pong: (self, f) => self.onPong(f.id),
    draining: (self, f) => self.onDraining(f.deadlineMs),
    error: (self, f) => self.emitError(BridgeError.fromPayload(f.error)),
  } satisfies ServerFrameHandlers,
);
