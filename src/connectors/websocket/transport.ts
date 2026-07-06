// src/connectors/websocket/transport.ts
// Thin TmuxTransport adapter over WebSocket.
//
// A browser (or any WebSocket-bearing runtime) can do
//
//     const transport = websocketTransport(ws);
//     const client = new TmuxClient(transport);
//
// against a transparent relay that pumps tmux's stdin/stdout across the
// WebSocket as raw control-mode bytes. The relay is intentionally NOT part
// of this package — it is deployment-specific (~30 lines of `ws` +
// `child_process`). See IMPL.md §6.
//
// Distinct from `WebSocketBridge` / `WebSocketTmuxClient` in the same folder:
// those carry a structured RPC framing with auth, rate limits, and
// observability; this is a transport-layer pipe.

import { bytesToLatin1 } from "../../protocol/byte-codec.js";
import type { TmuxTransport, SendResult } from "../../transport/types.js";
import { createCloseGate } from "../../transport/close-gate.js";
import { WEBSOCKET_OPEN, type BrowserWebSocketLike } from "./types.js";

/**
 * Adapt a WebSocket to the TmuxTransport interface.
 *
 * Accepts any object structurally satisfying `BrowserWebSocketLike` — the
 * browser WebSocket global, Node 22+'s built-in WebSocket, or the `ws`
 * package's WebSocket (client mode). The adapter does not assume the socket
 * is already open: it attaches its listeners synchronously and they will
 * fire once the underlying transport is ready.
 *
 * Outbound bytes go to `ws.send`. Inbound bytes go through `addEventListener`
 * for `message` / `close` / `error`. Binary frames are decoded via the
 * byte-faithful codec (see `byte-codec.ts`) so byte values 0x00-0xFF survive
 * the transport intact.
 *
 * [LAW:single-enforcer] All bytes↔string conversion flows through
 * `bytesToLatin1` from `byte-codec.ts`. No other site in this file derives
 * this conversion independently.
 *
 * [LAW:dataflow-not-control-flow] Listener arrays always exist; dispatch is
 * unconditional. The path through `addEventListener("message", …)` is the
 * same on every frame — only the value (string vs ArrayBuffer) varies.
 */
function websocketTransport(ws: BrowserWebSocketLike): TmuxTransport {
  // [LAW:single-enforcer] Set arraybuffer here so `event.data` is never a
  // Blob — Node `ws` and Deno don't have Blob, and we'd otherwise need a
  // platform-specific async path to read it.
  ws.binaryType = "arraybuffer";

  const dataCallbacks: ((chunk: string) => void)[] = [];

  // [LAW:single-enforcer] One synthetic close notification per transport.
  // Browser/WebSocket runtimes commonly emit `error` and then `close` for
  // one disconnect; the gate's exactly-once dispatch means TmuxClient
  // observes that as one exit path.
  const closeGate = createCloseGate();

  ws.addEventListener("message", (event: { data: unknown }) => {
    const chunk = decodeFrame(event.data);
    dataCallbacks.forEach((cb) => cb(chunk));
  });

  ws.addEventListener("close", (event: { code?: number; reason?: string }) => {
    closeGate.dispatch(closeReason(event));
  });

  // The `error` event on a browser WebSocket is intentionally information-
  // free (the spec hides details to avoid leaking cross-origin probe data).
  // We forward a generic reason; consumers wanting richer diagnostics should
  // attach their own listener before adapting.
  ws.addEventListener("error", () => {
    closeGate.dispatch("websocket error");
  });

  return {
    // [LAW:single-enforcer] LF-termination of control-mode commands enforced
    // here, mirroring transport/spawn.ts. The relay forwards bytes verbatim
    // to tmux's stdin, so the line terminator must travel with the command.
    // [LAW:no-silent-failure] send is total: a socket that is not OPEN would
    // either throw (CONNECTING) or silently drop (CLOSING/CLOSED) inside
    // ws.send — both are refused here as a typed result instead.
    send(command: string): SendResult {
      const closeState = closeGate.state();
      if (closeState.closed) {
        return {
          ok: false,
          reason:
            closeState.reason === undefined
              ? "transport closed"
              : `transport closed: ${closeState.reason}`,
        };
      }
      if (ws.readyState !== WEBSOCKET_OPEN) {
        return {
          ok: false,
          reason: `websocket not open (readyState ${ws.readyState})`,
        };
      }
      const terminated = command.endsWith("\n") ? command : command + "\n";
      // [LAW:types-are-the-program] send is total by its own contract; the
      // socket is a consumer-supplied structural object (polyfills included),
      // so a foreign synchronous throw is converted to the typed result at
      // this boundary, mirroring the spawn transport's stdin wrap.
      try {
        ws.send(terminated);
      } catch (err) {
        return {
          ok: false,
          reason: `websocket send failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      return { ok: true };
    },

    onData(callback: (chunk: string) => void): void {
      dataCallbacks.push(callback);
    },

    onClose(callback: (reason?: string) => void): void {
      closeGate.onClose(callback);
    },

    close(): void {
      ws.close();
    },
  };
}

function decodeFrame(data: unknown): string {
  // [LAW:dataflow-not-control-flow] Each branch is a pure value transform of
  // the incoming `data` shape — no side effects vary on the type.
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return bytesToLatin1(new Uint8Array(data));
  if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView<ArrayBufferLike>;
    return bytesToLatin1(
      new Uint8Array(view.buffer, view.byteOffset, view.byteLength),
    );
  }
  return "";
}

// RFC 6455 §7.4.1 — 1000 is "normal closure".
const WS_NORMAL_CLOSURE = 1000;

// [LAW:one-source-of-truth] Reason semantics are shared across transports:
// undefined means a clean termination (TmuxClient maps it to closed{exit}),
// any string means abnormal. A normal closure with no server-supplied reason
// must therefore be undefined — mirroring the spawn transport's exit-0 —
// or a clean close would masquerade as a transport error.
function closeReason(event: {
  code?: number;
  reason?: string;
}): string | undefined {
  if (event.reason !== undefined && event.reason.length > 0) {
    return event.reason;
  }
  if (event.code !== undefined && event.code !== WS_NORMAL_CLOSURE) {
    return `code ${event.code}`;
  }
  return undefined;
}

export { websocketTransport };
