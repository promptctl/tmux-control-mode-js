// src/connectors/websocket/types.ts
// Structural WebSocket types for the bridge.
//
// We refuse to depend on @types/ws or lib.dom. Instead, the server and
// client each describe the minimum surface they need, structurally typed,
// so the environments that implement each surface satisfy it without an
// adapter: the client's, any WebSocket (browser, Node 22+ native, Bun/Deno);
// the server's, Node's `ws` (see `ServerWebSocketLike.close`).
//
// [LAW:one-source-of-truth] These interfaces are the single contract. If a
// bridge implementation wants a new method on the underlying socket, it
// extends the relevant *Like interface here.

import type { ConnectionState as TmuxConnectionState } from "../../connection-state.js";
import type { BridgeErrorCode } from "../errors.js";
import type { ServerCloseCode } from "./close-code.js";

// ---------------------------------------------------------------------------
// Common constants
// ---------------------------------------------------------------------------

/** readyState value for an OPEN WebSocket per the WHATWG standard. */
export const WEBSOCKET_OPEN = 1 as const;
/** readyState value for a CLOSING WebSocket. */
export const WEBSOCKET_CLOSING = 2 as const;
/** readyState value for a CLOSED WebSocket. */
export const WEBSOCKET_CLOSED = 3 as const;

// ---------------------------------------------------------------------------
// Browser-side WebSocket (used by the browser proxy)
//
// Satisfied by:
//   - the browser WebSocket global,
//   - Node.js 22+ built-in WebSocket,
//   - the `ws` package's WebSocket (client mode).
// ---------------------------------------------------------------------------

export interface BrowserWebSocketLike {
  readonly readyState: number;
  /** `"blob"` or `"arraybuffer"`. The browser client sets this to `"arraybuffer"`. */
  binaryType: "blob" | "arraybuffer";

  send(data: string | ArrayBufferLike | ArrayBufferView | Blob): void;
  /** Does not throw for code 1000 or 3000–4999 with a reason of at most 123
   *  UTF-8 bytes, in any readyState — the WHATWG contract. The client closes
   *  only with those, and lets anything this throws propagate. */
  close(code?: number, reason?: string): void;

  // [LAW:locality-or-seam] removeEventListener, matched by handler identity,
  // is the one listener teardown both runtimes honor: `ws` ignores an
  // addEventListener `{ signal }`. A socket may still emit 'error' after its
  // consumer has removed its listeners (`ws` does on a handshake aborted by
  // close()), and an EventEmitter-based socket throws in the host on an
  // 'error' nobody hears — so a consumer that lets a socket go leaves an
  // 'error' listener on it.
  addEventListener(
    type: "open" | "error",
    listener: (event: unknown) => void,
  ): void;
  addEventListener(
    type: "message",
    listener: (event: { data: unknown }) => void,
  ): void;
  addEventListener(
    type: "close",
    listener: (event: { code?: number; reason?: string }) => void,
  ): void;
  removeEventListener(
    type: "open" | "error",
    listener: (event: unknown) => void,
  ): void;
  removeEventListener(
    type: "message",
    listener: (event: { data: unknown }) => void,
  ): void;
  removeEventListener(
    type: "close",
    listener: (event: { code?: number; reason?: string }) => void,
  ): void;
}

// ---------------------------------------------------------------------------
// Server-side WebSocket (used by the bridge)
//
// Satisfied by the `ws` package's WebSocket (server mode). The server bridge
// needs `ping`/`pong` lifecycle + synchronous buffered-bytes visibility for
// backpressure, which only server-side WS implementations expose reliably.
//
// Node.js-first: the built-in Node 22 WebSocket does not expose ping/pong
// APIs to userland, so a production server using this bridge should use the
// `ws` package. We do not ship a dependency on `ws` — consumers bring it.
// ---------------------------------------------------------------------------

export interface ServerWebSocketLike {
  readonly readyState: number;
  /** Best-effort count of bytes queued by the implementation, used for
   *  backpressure heuristics. `ws` exposes this as `bufferedAmount`. */
  readonly bufferedAmount?: number;

  send(
    data: string | ArrayBufferLike | ArrayBufferView,
    cb?: (err?: Error) => void,
  ): void;

  /** Send a transport-level ping. May throw: the bridge treats a ping the
   *  transport refuses as one the peer never answered, so it ends the
   *  connection under the heartbeat's pong deadline. `ws` drops a ping on a
   *  closing socket silently, which the bridge handles the same way. */
  ping(data?: unknown, mask?: boolean, cb?: (err?: Error) => void): void;

  /** Does not throw for a `ServerCloseCode` with a reason of at most 123
   *  UTF-8 bytes, in any readyState; `ws`'s meets this. The bridge closes
   *  only with those, and lets anything this throws propagate. A WHATWG-style
   *  `close()`, which throws for anything but 1000 and 3000–4999, needs an
   *  adapter. */
  close(code?: ServerCloseCode, reason?: string): void;
  terminate(): void;

  on(
    event: "message",
    listener: (data: unknown, isBinary: boolean) => void,
  ): void;
  on(
    event: "close",
    listener: (code: number, reason: Buffer | string) => void,
  ): void;
  on(event: "error", listener: (err: Error) => void): void;
  on(event: "pong" | "ping", listener: () => void): void;
}

// ---------------------------------------------------------------------------
// Upgrade request (what gets passed to authenticate())
//
// A structural view over a Node `http.IncomingMessage`. The bridge reads
// headers + URL only — it never touches the request body. Consumers can
// fabricate their own shape if they're running on a non-Node runtime.
// ---------------------------------------------------------------------------

export interface UpgradeRequest {
  /** Request URL path + query (as supplied in the HTTP request line). */
  readonly url?: string;
  /** HTTP headers. Keys are case-insensitive per RFC 7230; the adapter
   *  normalizes them to lowercase for lookup. */
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  /** Remote peer address (for logging / rate limiting). */
  readonly remoteAddress?: string;
}

// ---------------------------------------------------------------------------
// Auth + authorize hooks
// ---------------------------------------------------------------------------

/** Opaque identity attached by `authenticate()` and handed back to authorize
 *  and to createClient. Type-parameterized so apps can carry their own shape. */
export type ConnectionIdentity = unknown;

export type AuthResult =
  | { readonly ok: true; readonly identity?: ConnectionIdentity }
  | {
      readonly ok: false;
      /** The code the denied socket closes with: one a server may send
       *  (see `ServerCloseCode`). Default 4401. Any other number is
       *  the hook's defect: the socket closes with 4401 and the denial's
       *  reason names the value. */
      readonly code?: number;
      readonly reason: string;
    };

export interface AuthorizeRequest {
  readonly identity: ConnectionIdentity;
  readonly method: string;
  readonly args: readonly unknown[];
}

export type AuthorizeResult =
  | { readonly allow: true; readonly args?: readonly unknown[] }
  | { readonly allow: false; readonly reason: string };

// ---------------------------------------------------------------------------
// Observability event (server-side)
// ---------------------------------------------------------------------------

/**
 * How the socket under a connection ended. `connection-closed` carries the
 * reason the bridge gave the peer (`errorCode`/`reason`); this carries how the
 * transport actually came down, which is a separate fact: the same fatal can
 * end with the peer's close frame, with a socket error, or with the bridge
 * tearing the socket down because the peer never answered.
 * [LAW:types-are-the-program] [LAW:nothing-unseen]
 */
export type SocketEnd =
  /** The socket's own close event: the peer's close frame, or the transport's
   *  report of an abnormal closure (ws uses code 1006 for the latter). */
  | {
      readonly kind: "close-event";
      readonly code: number;
      readonly reason: string;
    }
  /** The socket's error event. */
  | { readonly kind: "error"; readonly message: string }
  /** The bridge forced the socket down without a close frame from the peer:
   *  `shutdown`'s drain deadline passed, or the `heartbeat`'s pong deadline
   *  passed while the bridge's close handshake was pending. */
  | { readonly kind: "terminated"; readonly by: "shutdown" | "heartbeat" };

export type BridgeObservabilityEvent =
  | {
      // One per `shutdown` call that parsed. `deadlineMs` is the drain's
      // deadline: the first call's, which every peer was told. A call that
      // found a drain in flight is `joined`, and its `drainMs` moved nothing.
      // [LAW:nothing-unseen]
      readonly kind: "shutdown-requested";
      readonly drainMs: number;
      readonly deadlineMs: number;
      readonly joined: boolean;
    }
  | {
      readonly kind: "connection-opened";
      readonly identity: ConnectionIdentity;
      readonly remoteAddress?: string;
    }
  | {
      readonly kind: "connection-closed";
      readonly identity: ConnectionIdentity;
      readonly code?: number;
      readonly reason?: string;
      // Set when the close was triggered by sendFatalAndClose rather than a
      // peer-initiated disconnect — the BridgeErrorCode the caller already
      // had in hand at the fatal-close site. [LAW:single-enforcer]
      readonly errorCode?: BridgeErrorCode;
      readonly socketEnd: SocketEnd;
    }
  | {
      readonly kind: "call";
      readonly identity: ConnectionIdentity;
      readonly id: string;
      readonly method: string;
      readonly allowed: boolean;
      readonly denyReason?: string;
    }
  | {
      readonly kind: "result";
      readonly identity: ConnectionIdentity;
      readonly id: string;
      readonly ok: boolean;
      readonly code?: string;
      readonly durationMs: number;
    }
  | {
      readonly kind: "event-out";
      readonly identity: ConnectionIdentity;
      readonly type: string;
      readonly bytes: number;
    }
  | {
      readonly kind: "protocol-error";
      readonly identity: ConnectionIdentity;
      readonly message: string;
    }
  | {
      // The TmuxClient behind this connection closed (tmux died, its
      // transport failed, or it was disposed), so the bridge is closing the
      // connection with BRIDGE_CLOSED. The upstream's typed close reason
      // rides here; the `connection-closed` that follows shares its
      // BRIDGE_CLOSED code with heartbeat timeout and shutdown, so this event
      // is what tells a tmux death apart from a silent browser.
      // [LAW:nothing-unseen]
      readonly kind: "upstream-closed";
      readonly identity: ConnectionIdentity;
      readonly reason: Extract<
        TmuxConnectionState,
        { status: "closed" }
      >["reason"];
    }
  | {
      // A pane's resume (Continue) was refused by a live tmux while the
      // watermark loop wanted it flowing — the pane is still paused in tmux.
      // The bridge keeps retrying on the next watermark crossing; this event
      // is the observable signal that a live pane was stranded, replacing the
      // silent swallow that made a stuck pane indistinguishable from a quiet
      // one. [LAW:no-silent-failure]
      readonly kind: "pane-resume-failed";
      readonly identity: ConnectionIdentity;
      readonly paneId: number;
      readonly code: BridgeErrorCode;
      readonly message: string;
    }
  | {
      // A departed peer's cross-session layout release was refused by a live
      // tmux; the relay's subscription may outlive every peer that wanted it.
      // [LAW:no-silent-failure]
      readonly kind: "cross-session-layout-release-failed";
      readonly identity: ConnectionIdentity;
      readonly code: BridgeErrorCode;
      readonly message: string;
    }
  | {
      // An onHello failure (auth denial or createClient rejection)
      // discovered after this connection's one close-enforcer
      // (sendFatalAndClose/finalize) was already claimed — either a real
      // peer-initiated close already ran finalize with no failure info to
      // carry, or an earlier, unrelated fatal is already pending and
      // sendFatalAndClose's write-once guard would otherwise silently drop
      // this one. Surfaced on its own rather than lost.
      // [LAW:no-silent-failure]
      readonly kind: "handshake-failure-unreported";
      readonly identity: ConnectionIdentity;
      readonly code: BridgeErrorCode;
      readonly message: string;
    }
  | {
      // The caller-supplied disposeClient hook threw or rejected while this
      // connection was disposing a client (orphaned mid-handshake, orphaned
      // by a bridge-construction failure, or the normal finalize teardown).
      // The client leaks either way; swallowing the hook's failure or
      // letting it become an unhandled rejection would hide that from the
      // caller who configured the hook. [LAW:no-silent-failure]
      readonly kind: "client-dispose-failed";
      readonly identity: ConnectionIdentity;
      readonly message: string;
    }
  | {
      // One release in onHello's acquire-then-unwind stack threw while
      // unwinding a partially-acquired connection. Each release tears down
      // one resource independently of the others, so a throw here must not
      // stop the releases still below it on the stack from running (a
      // skipped disposeClientSafely leaks the client; a skipped
      // sendFatalAndClose leaves the peer with no fatal frame) — swallowing
      // it outright would hide that from the caller instead.
      // [LAW:no-silent-failure]
      readonly kind: "release-failed";
      readonly identity: ConnectionIdentity;
      readonly message: string;
    };

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

export interface RateLimitConfig {
  /** Max calls permitted per `windowMs`: an integer >= 1. */
  readonly maxCalls: number;
  /** Window size in ms (sliding): an integer >= 1. */
  readonly windowMs: number;
}

// ---------------------------------------------------------------------------
// Reconnect policy (client side)
// ---------------------------------------------------------------------------

/**
 * Exponential backoff with jitter for the client's reconnect. Every field is
 * parsed when the client is constructed; one outside its shape makes the
 * constructor throw `BRIDGE_INVALID_ARG` naming `reconnect.<field>` and the
 * value, since a delay no timer honors is an immediate retry storm.
 */
export interface ReconnectPolicy {
  /** Max attempts: `0` (no reconnect), a positive integer, or `Infinity` for
   *  unlimited. */
  readonly maxAttempts: number;
  /** First retry delay: an integer number of ms in [1, 2^31-1]. Default: 250. */
  readonly initialDelayMs?: number;
  /**
   * Ceiling on the exponential *base* delay, before jitter: an integer number
   * of ms in [1, 2^31-1]. Default: 10_000. `jitterMs` is added on top, so the
   * effective maximum delay is `maxDelayMs + jitterMs`, which must itself fit
   * the timer's range — the cap bounds the exponential growth; jitter then
   * de-synchronizes reconnecting clients.
   */
  readonly maxDelayMs?: number;
  /** Exponential backoff factor: a finite number >= 1. Default: 2. */
  readonly factor?: number;
  /** Random jitter added on top of the (capped) base delay: `0` (no jitter)
   *  or an integer number of ms in [1, 2^31-1]. Default: 250. */
  readonly jitterMs?: number;
}
