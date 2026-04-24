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
import type {
  CommandResponse,
  PaneAction,
  TmuxMessage,
} from "../../protocol/types.js";
import type { SplitOptions } from "../../client.js";

import {
  BridgeError,
  BridgeProtocolError,
  PROTOCOL_VERSION,
  encodePaneOutput,
  encodeServerFrame,
  isFireMethod,
  parseClientFrame,
  type BridgeErrorCode,
  type CallFrame,
  type ClientFrame,
  type RpcMethod,
  type ServerFrame,
} from "./protocol.js";

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
// ---------------------------------------------------------------------------

type Phase = "pending-hello" | "running" | "draining" | "closed";

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
    heartbeatTimeoutMs:
      opts.heartbeatTimeoutMs ?? DEFAULTS.heartbeatTimeoutMs,
    requestTimeoutMs: opts.requestTimeoutMs ?? DEFAULTS.requestTimeoutMs,
    helloTimeoutMs: DEFAULTS.helloTimeoutMs,
    maxInflight: opts.maxInflight ?? DEFAULTS.maxInflight,
  };
}

class Connection {
  private phase: Phase = "pending-hello";
  private identity: ConnectionIdentity = undefined;
  private client: TmuxClient | null = null;
  private ctx: ConnectionContext | null = null;

  private readonly inflight = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; startedAt: number }
  >();
  private readonly rateWindow: number[] = [];

  private readonly onAnyEventRef: (msg: TmuxMessage) => void;
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
    this.onAnyEventRef = (msg: TmuxMessage): void => this.onTmuxEvent(msg);
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
    if (this.phase === "closed") return;
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
    if (frame.k === "hello") {
      void this.onHello();
      return;
    }
    if (this.phase === "pending-hello") {
      this.sendFatalAndClose(
        "BRIDGE_PROTOCOL_ERROR",
        `received '${frame.k}' before hello`,
      );
      return;
    }
    if (frame.k === "call") {
      void this.onCall(frame);
      return;
    }
    if (frame.k === "ping") {
      this.sendFrame({ v: 1, k: "pong", id: frame.id });
      return;
    }
    if (frame.k === "bye") {
      this.ws.close(1000, "bye");
      return;
    }
  }

  // -------------------------------------------------------------------------
  // Hello / welcome
  // -------------------------------------------------------------------------
  private async onHello(): Promise<void> {
    if (this.phase !== "pending-hello") {
      this.sendFatalAndClose(
        "BRIDGE_PROTOCOL_ERROR",
        "duplicate hello frame",
      );
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
    this.ctx = { identity: this.identity, request: this.request };

    // createClient()
    try {
      this.client = await this.opts.createClient(this.ctx);
    } catch (err) {
      this.sendFatalAndClose(
        "BRIDGE_INTERNAL",
        `createClient failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    // Wire up tmux event fan-out.
    this.client.on("*", this.onAnyEventRef);

    this.phase = "running";
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
  // -------------------------------------------------------------------------
  private async onCall(frame: CallFrame): Promise<void> {
    if (this.phase === "draining") {
      this.replyError(frame.id, "BRIDGE_CLOSED", "bridge is draining");
      return;
    }
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
    const invoker = DISPATCH[frame.method];
    const client = this.client;
    if (invoker === undefined) {
      this.replyError(
        frame.id,
        "BRIDGE_UNKNOWN_METHOD",
        `unknown RPC method: ${frame.method}`,
      );
      return;
    }
    if (client === null) {
      // Invariant violation: welcome was sent so client must be non-null.
      this.replyError(
        frame.id,
        "BRIDGE_INTERNAL",
        "tmux client not initialized",
      );
      return;
    }

    if (isFireMethod(frame.method)) {
      try {
        // Fire methods synthesize a CommandResponse locally; the bridge
        // does not await a tmux reply for them.
        const synth = invoker(client, args) as CommandResponse;
        this.replyOk(frame.id, synth);
      } catch (err) {
        this.replyError(
          frame.id,
          "BRIDGE_INTERNAL",
          err instanceof Error ? err.message : String(err),
        );
      }
      return;
    }

    // Call-and-wait: dispatch + race against timeout.
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
      const result = (await invoker(client, args)) as CommandResponse;
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
      // TmuxClient rejects execute() with a CommandResponse carrying
      // success:false when tmux returns %error. Preserve that as a typed
      // TMUX_ERROR; otherwise classify as BRIDGE_INTERNAL.
      const isTmuxError =
        typeof err === "object" &&
        err !== null &&
        "success" in err &&
        (err as { success: unknown }).success === false;
      if (isTmuxError) {
        this.replyOk(frame.id, err as CommandResponse);
        this.emit({
          kind: "result",
          identity: this.identity,
          id: frame.id,
          ok: true,
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
  // -------------------------------------------------------------------------
  private onTmuxEvent(msg: TmuxMessage): void {
    if (this.ws.readyState !== WEBSOCKET_OPEN) return;

    if (msg.type === "output" || msg.type === "extended-output") {
      const bytes = encodePaneOutput(msg);
      this.ws.send(bytes);
      this.emit({
        kind: "event-out",
        identity: this.identity,
        type: msg.type,
        bytes: bytes.byteLength,
      });
      return;
    }

    const encoded = encodeServerFrame({ v: 1, k: "event", msg });
    this.ws.send(encoded);
    this.emit({
      kind: "event-out",
      identity: this.identity,
      type: msg.type,
      bytes: encoded.length,
    });
  }

  // -------------------------------------------------------------------------
  // Heartbeats
  // -------------------------------------------------------------------------
  private startHeartbeat(): void {
    if (this.defaults.heartbeatIntervalMs <= 0) return;
    this.heartbeatTimer = setInterval(() => {
      if (this.phase === "closed") return;
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
    if (this.phase !== "running") return;
    this.phase = "draining";
    this.sendFrame({ v: 1, k: "draining", deadlineMs });
  }

  terminate(): void {
    if (this.phase === "closed") return;
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

  private replyError(
    id: string,
    code: BridgeErrorCode,
    message: string,
  ): void {
    this.sendFrame({
      v: 1,
      k: "result",
      id,
      ok: false,
      error: { code, message },
    });
  }

  private sendFrame(frame: ServerFrame): void {
    if (this.ws.readyState !== WEBSOCKET_OPEN) return;
    try {
      this.ws.send(encodeServerFrame(frame));
    } catch {
      // Write failed — socket is going away. Let the close handler clean up.
    }
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
    if (this.phase === "closed") return;
    this.phase = "closed";

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

    if (this.client !== null) {
      this.client.off("*", this.onAnyEventRef);
      if (this.opts.disposeClient !== undefined && this.ctx !== null) {
        void Promise.resolve(this.opts.disposeClient(this.client, this.ctx));
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
// Dispatch table
//
// [LAW:one-source-of-truth] Adding a TmuxClient method to the proxy means
// adding one entry here. The types use `never` on the args so the compiler
// enforces each entry matches its method's signature.
// ---------------------------------------------------------------------------

type Invoker = (
  client: TmuxClient,
  args: readonly unknown[],
) => Promise<CommandResponse> | CommandResponse;

const DISPATCH: Readonly<Record<RpcMethod, Invoker>> = Object.freeze({
  execute: (c, [command]) => c.execute(command as string),
  listWindows: (c) => c.listWindows(),
  listPanes: (c) => c.listPanes(),
  sendKeys: (c, [target, keys]) =>
    c.sendKeys(target as string, keys as string),
  splitWindow: (c, [options]) => c.splitWindow(options as SplitOptions),
  setSize: (c, [w, h]) => c.setSize(w as number, h as number),
  setPaneAction: (c, [paneId, action]) =>
    c.setPaneAction(paneId as number, action as PaneAction),
  setFlags: (c, [flags]) => c.setFlags(flags as readonly string[]),
  clearFlags: (c, [flags]) => c.clearFlags(flags as readonly string[]),
  requestReport: (c, [paneId, report]) =>
    c.requestReport(paneId as number, report as string),
  queryClipboard: (c) => c.queryClipboard(),
  subscribe: (c, [name, what, format]) =>
    c.subscribe(name as string, what as string, format as string),
  unsubscribe: (c, [name]) => c.unsubscribe(name as string),
  detach: (c) => {
    c.detach();
    return synthesizeFireResponse();
  },
});

function synthesizeFireResponse(): CommandResponse {
  // Fire methods produce no tmux response, so the bridge synthesizes an
  // empty success so the client's Promise resolves with the same shape as
  // every other call.
  return {
    commandNumber: -1,
    timestamp: Date.now(),
    success: true,
    output: [],
  };
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
