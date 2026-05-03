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

import type { TmuxTransport } from "../../transport/types.js";
import type { BrowserWebSocketLike } from "./types.js";

// [LAW:single-enforcer] Decoding of binary WebSocket frames happens in this
// adapter and nowhere else. Higher layers (parser, client) only see strings.
const BINARY_DECODER = new TextDecoder();

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
 * for `message` / `close` / `error`. Binary frames are decoded as UTF-8;
 * tmux control mode is a text protocol (SPEC §1) so any binary frame must
 * be a UTF-8 byte buffer.
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
  const closeCallbacks: ((reason?: string) => void)[] = [];
  let closed = false;

  const dispatchClose = (reason?: string): void => {
    // [LAW:single-enforcer] One synthetic close notification per transport.
    // Browser/WebSocket runtimes commonly emit `error` and then `close` for
    // one disconnect; TmuxClient should observe that as one exit path.
    if (closed) return;
    closed = true;
    closeCallbacks.forEach((cb) => cb(reason));
  };

  ws.addEventListener("message", (event: { data: unknown }) => {
    const chunk = decodeFrame(event.data);
    dataCallbacks.forEach((cb) => cb(chunk));
  });

  ws.addEventListener(
    "close",
    (event: { code?: number; reason?: string }) => {
      dispatchClose(closeReason(event));
    },
  );

  // The `error` event on a browser WebSocket is intentionally information-
  // free (the spec hides details to avoid leaking cross-origin probe data).
  // We forward a generic reason; consumers wanting richer diagnostics should
  // attach their own listener before adapting.
  ws.addEventListener("error", () => {
    dispatchClose("websocket error");
  });

  return {
    // [LAW:single-enforcer] LF-termination of control-mode commands enforced
    // here, mirroring transport/spawn.ts. The relay forwards bytes verbatim
    // to tmux's stdin, so the line terminator must travel with the command.
    send(command: string): void {
      const terminated = command.endsWith("\n") ? command : command + "\n";
      ws.send(terminated);
    },

    onData(callback: (chunk: string) => void): void {
      dataCallbacks.push(callback);
    },

    onClose(callback: (reason?: string) => void): void {
      closeCallbacks.push(callback);
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
  if (data instanceof ArrayBuffer) return BINARY_DECODER.decode(data);
  if (ArrayBuffer.isView(data)) {
    return BINARY_DECODER.decode(
      data as ArrayBufferView<ArrayBufferLike>,
    );
  }
  return "";
}

function closeReason(event: {
  code?: number;
  reason?: string;
}): string | undefined {
  if (event.reason !== undefined && event.reason.length > 0) {
    return event.reason;
  }
  if (event.code !== undefined) return `code ${event.code}`;
  return undefined;
}

export { websocketTransport };
