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
  off?(event: string, listener: (...args: unknown[]) => void): void;
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
  /** Ceiling on retry delay ms. Default: 10_000. */
  readonly maxDelayMs?: number;
  /** Exponential backoff factor. Default: 2. */
  readonly factor?: number;
  /** Random jitter ms added to each delay. Default: 250. */
  readonly jitterMs?: number;
}
