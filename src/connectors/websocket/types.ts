// src/connectors/websocket/types.ts
// Structural WebSocket types for the bridge.
//
// We refuse to depend on @types/ws or lib.dom. Instead, the server and
// client each describe the minimum surface they need, structurally typed,
// so any environment (browser WebSocket, Node `ws` package, Node 22+
// native WebSocket, Bun/Deno) satisfies the contract without an adapter.
//
// [LAW:one-source-of-truth] These interfaces are the single contract. If a
// bridge implementation wants a new method on the underlying socket, it
// extends the relevant *Like interface here.

import type { ConnectionState as TmuxConnectionState } from "../../connection-state.js";
import type { BridgeErrorCode } from "../errors.js";

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
  close(code?: number, reason?: string): void;

  // [LAW:locality-or-seam] The `{ signal }` option is the seam between
  // "register listener" and "tear listener down" — its lifetime IS the
  // listener's lifetime. WebSocketTmuxClient passes an AbortSignal per
  // connection; aborting the controller in finalizeConnection removes
  // every listener atomically, so events from a no-longer-current socket
  // simply find no listener to invoke (instead of requiring a runtime
  // guard inside every listener). Both the standard browser WebSocket
  // (inherited from EventTarget) and the `ws` package's WebSocket (8.x+)
  // honor this option.
  addEventListener(
    type: "open" | "error",
    listener: (event: unknown) => void,
    options?: { signal?: AbortSignal },
  ): void;
  addEventListener(
    type: "message",
    listener: (event: { data: unknown }) => void,
    options?: { signal?: AbortSignal },
  ): void;
  addEventListener(
    type: "close",
    listener: (event: { code?: number; reason?: string }) => void,
    options?: { signal?: AbortSignal },
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

  ping(data?: unknown, mask?: boolean, cb?: (err?: Error) => void): void;

  close(code?: number, reason?: string): void;
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
  | { readonly ok: false; readonly code?: number; readonly reason: string };

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

export type BridgeObservabilityEvent =
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
  /** Max calls permitted per `windowMs`. */
  readonly maxCalls: number;
  /** Window size in ms (sliding). */
  readonly windowMs: number;
}

// ---------------------------------------------------------------------------
// Reconnect policy (client side)
// ---------------------------------------------------------------------------

export interface ReconnectPolicy {
  /** Max attempts; Infinity for unlimited. Default: 0 (no reconnect). */
  readonly maxAttempts: number;
  /** First retry delay ms. Default: 250. */
  readonly initialDelayMs?: number;
  /**
   * Ceiling on the exponential *base* delay ms, before jitter. Default: 10_000.
   * `jitterMs` is added on top, so the effective maximum delay is
   * `maxDelayMs + jitterMs` — the cap bounds the exponential growth; jitter then
   * de-synchronizes reconnecting clients.
   */
  readonly maxDelayMs?: number;
  /** Exponential backoff factor. Default: 2. */
  readonly factor?: number;
  /** Random jitter ms added on top of the (capped) base delay. Default: 250. */
  readonly jitterMs?: number;
}
