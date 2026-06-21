// src/connectors/websocket/sink.ts
// WebSocketSink — BytesSink that forwards pane chunks as binary WS frames.
//
// [LAW:one-type-per-behavior] WebSocketSink is the one BytesSink implementation
//   for the WebSocket transport. Every byte-consuming WebSocket destination is
//   an instance of this class, not a new type.
// [LAW:single-enforcer] Wire encoding (magic + header + raw bytes) lives in
//   `encodePaneOutput` (./protocol.ts) — WebSocketSink.write calls it; no
//   other path re-implements the encode.
// [LAW:dataflow-not-control-flow] write() always runs the same path — the
//   readyState check is a trust-boundary guard on the WebSocket lifecycle (a
//   state the type system cannot encode), not a missing invariant in the body.
//   The try/catch covers the TOCTOU window between the readyState read and the
//   send; it is not for swallowing serializer errors.
// [LAW:composability] WebSocketSink does one thing: encode and send. No
//   exclusivity registry, no lifecycle state beyond the BytesSink contract.
//   Callers decide whether multiple attachments on the same WS make sense.

import type { TmuxConnection } from "../../client.js";
import type { AttachOptions, BytesSink, ChunkPayload } from "../../pane-output.js";

import { encodePaneOutput } from "./protocol.js";
import { WEBSOCKET_OPEN } from "./types.js";

// ---------------------------------------------------------------------------
// Narrow target type
//
// The sink uses only `send` (binary frame) and `readyState` (lifecycle
// guard). Defined here rather than in `./types.ts` so the surface stays
// compact and both `BrowserWebSocketLike` and `ServerWebSocketLike`
// structurally satisfy it without having to pull either of those into
// callsites that only need the sink.
// ---------------------------------------------------------------------------

/**
 * Minimum WebSocket-like surface for `WebSocketSink` and `attachWebSocketSink`.
 *
 * Satisfied by:
 *   - browser global `WebSocket`,
 *   - Node.js 22+ built-in `WebSocket`,
 *   - the `ws` package's `WebSocket` (client or server mode),
 *   - the structural `BrowserWebSocketLike` and `ServerWebSocketLike`
 *     types in `./types.ts`.
 *
 * A consumer brings whatever WebSocket implementation they already use;
 * no adapter is required.
 */
export interface WebSocketSinkTarget {
  readonly readyState: number;
  send(data: ArrayBufferLike | ArrayBufferView): void;
}

// ---------------------------------------------------------------------------
// WebSocketSink — the concrete BytesSink for WebSocket transports
// ---------------------------------------------------------------------------

/**
 * `BytesSink` that forwards each pane chunk to a WebSocket as a binary
 * pane-output frame (the wire format defined by `encodePaneOutput` in
 * `./protocol.ts`).
 *
 * ## Usage
 *
 * ```ts
 * const sink = new WebSocketSink(ws);
 * const dispose = client.attachBytesSink(sink, { scope: serverScope });
 * // or via the convenience function:
 * const dispose = attachWebSocketSink(client, ws);
 * ```
 *
 * ## Contract
 *
 * - `write(msg)` encodes `msg` as one binary frame and sends it.
 *   No-op if `ws.readyState !== OPEN`. `ws.send` exceptions (TOCTOU race
 *   between the readyState check and the send) are caught and swallowed —
 *   the close handler will tear the rest down.
 * - `end()` is a no-op. There is no wire-level pane-end frame in the WS
 *   protocol; pane teardown surfaces via the JSON event channel.
 *
 * ## Exclusivity
 *
 * Unlike the previous per-pane API, `WebSocketSink` carries no attachment
 * registry. Multiple attachments with different scopes on the same `ws`
 * are valid — the caller decides whether that is appropriate.
 *
 * @see attachWebSocketSink for the one-line convenience wrapper.
 * @see decodePaneOutput (`./protocol.ts`) for the matching wire decoder.
 */
export class WebSocketSink implements BytesSink {
  constructor(private readonly ws: WebSocketSinkTarget) {}

  write(msg: ChunkPayload): void {
    // [LAW:no-defensive-null-guards] readyState is a trust-boundary check on
    // the WebSocket lifecycle — the same guard the bridge's wsSend chokepoint
    // uses for the same reason. Not a workaround for a missing invariant.
    if (this.ws.readyState !== WEBSOCKET_OPEN) return;
    try {
      this.ws.send(encodePaneOutput(msg));
    } catch {
      // TOCTOU: socket may have torn down between the readyState read and the
      // send. Let the close handler complete the teardown.
    }
  }

  // No wire-level pane-end frame in this protocol; pane teardown surfaces
  // via the JSON event channel.
  end(): void {}
}

// ---------------------------------------------------------------------------
// attachWebSocketSink — one-line convenience wrapper
// ---------------------------------------------------------------------------

/**
 * Attach a `WebSocketSink` to `client` and return an idempotent disposer.
 *
 * Equivalent to:
 * ```ts
 * client.attachBytesSink(new WebSocketSink(ws), options)
 * ```
 *
 * `options.scope` defaults to `serverScope` (all panes on the server).
 * Pass `{ scope: paneScope(id) }` or `{ scope: sessionScope(id) }` to narrow.
 *
 * @see WebSocketSink for the underlying BytesSink implementation.
 */
export function attachWebSocketSink(
  client: Pick<TmuxConnection, "attachBytesSink">,
  ws: WebSocketSinkTarget,
  options?: AttachOptions,
): () => void {
  return client.attachBytesSink(new WebSocketSink(ws), options);
}
