// src/connectors/websocket/sink.ts
// attachWebSocketSink — WS-side pane-byte forwarder.
//
// Mirrors `attachWebContentsSink` (electron/main.ts) for the WebSocket
// transport. The wire shape is the binary pane-output frame defined by
// `encodePaneOutput` in `./protocol.ts`: magic byte + paneId header +
// raw pane bytes verbatim. Same wire bytes the WS bridge already emits
// inline — this primitive just lets Node-side relay authors compose a
// per-pane forwarder without re-implementing the encode-and-send loop
// (which historically is where consumers reach for `new TextDecoder(...)`
// and mojibake every pane).
//
// [LAW:types-are-the-program] The strongest true theorem about this
// surface is "exactly one attachment per `(ws, paneId)`." The wire
// envelope is paneId-scoped: a second concurrent attachment would
// double-broadcast every chunk to the same browser-side decoder, wasting
// bandwidth and producing duplicate-render bugs on consumers that don't
// dedupe. The way to make that theorem hold is to remove the value the
// caller could misuse — the sink reference never escapes this closure,
// and the WeakMap registry refuses the second registration loudly.
//
// [LAW:single-enforcer] One WS pane-byte forwarder lives here only.
// `encodePaneOutput` (./protocol.ts) is the sole owner of the wire
// format; this sink is the sole owner of the per-attachment lifecycle.
// External relay authors that used to write
// `client.on('output', ev) => ws.send(encodePaneOutput(ev))` get the
// typed primitive instead — no chance to swap the encoder for
// `Buffer.from(data).toString('binary')` along the way.
//
// [LAW:locality-or-seam] The seam between "pane bytes" and "WS binary
// frame" is this factory. The wire layout (magic, header, paneId
// scoping) is owned by `./protocol.ts` and never reaches the consumer;
// the sink doesn't reach the consumer either.
//
// [LAW:dataflow-not-control-flow] `write` always runs the same path —
// the readyState guard + try/catch is a trust-boundary check on the WS
// lifecycle (a state the type system cannot encode; the socket may have
// torn down between any two synchronous statements). Not a missing
// invariant compensated for in the body.

import type { TmuxClient } from "../../client.js";
import type { PaneByteSink } from "../../pane-sink.js";

import { BridgeError } from "../errors.js";
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
 * Minimum WebSocket-like surface for `attachWebSocketSink`.
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
// Active-attachment registry — exactly one `attachWebSocketSink` per
// `(ws, paneId)` pair.
//
// Two independent attachments for the same pair would each `encodePaneOutput`
// and `ws.send` the same chunk, producing two identical binary frames on the
// wire. Browser-side decoders (`decodePaneOutput`) read the paneId off the
// header and route by it — duplicates render twice or break ordering
// invariants downstream. The registry refuses the second call loudly
// instead of silently corrupting the stream.
//
// [LAW:no-shared-mutable-globals] Module-level `WeakMap` keyed by `ws` so
// the registry never outlives its targets. The constructor and the
// disposer are the explicit API.
// ---------------------------------------------------------------------------

const ACTIVE_WEBSOCKET_SINKS = new WeakMap<WebSocketSinkTarget, Set<number>>();

/**
 * Forward pane bytes for `paneId` to the given WebSocket as binary
 * pane-output frames (the wire format defined by `encodePaneOutput` in
 * `./protocol.ts`).
 *
 * Internally constructs a sink that turns each `attachPaneSink`-delivered
 * chunk into one `ws.send(encodePaneOutput({ type: 'output', paneId, data }))`
 * binary frame, calls `client.attachPaneSink(paneId, sink)`, and returns
 * a disposer that unwinds the attachment. The sink instance is never
 * exposed: the closure owns it, so it cannot be attached more than once.
 * The wire's `paneId`-scoped envelope and the attachment's lifecycle are
 * 1:1 by construction.
 *
 * Reading bytes back: the WS bridge's matching browser-side path
 * (`WebSocketTmuxClient`) detects the magic byte via `isPaneOutputFrame`
 * and decodes via `decodePaneOutput`. External relays bringing their own
 * receiver use the same two helpers — there is no separate decoder.
 *
 * ## Exclusivity (one attachment per `(ws, paneId)`)
 *
 * A second `attachWebSocketSink(client, ws, paneId)` for a pair that
 * already has an active attachment throws
 * `BridgeError("BRIDGE_PANE_SINK_ALREADY_ATTACHED")` — the wire envelope
 * is paneId-scoped and cannot disambiguate two concurrent attachments
 * (both would broadcast the same chunk). The slot is freed when the
 * returned disposer is called. Hosts that want to "rotate" the forwarder
 * for a pane MUST dispose the prior attachment first.
 *
 * ## Lifecycle
 *
 * The internal sink's `readyState` guard is a trust-boundary check on
 * the WebSocket's lifecycle. `ws.send` on a CLOSING / CLOSED socket is
 * defined behavior in some implementations and throws in others; the
 * guard makes the outcome consistent (a no-op `write` on a dead
 * receiver). The `try/catch` covers the TOCTOU window between the
 * readyState read and the send — Electron's `WebContents` has the same
 * race, mitigated the same way in the bridge's `wsSend` chokepoint.
 *
 * There is no wire-level `paneEnd` frame in the WS protocol (the bridge
 * surfaces pane teardown via the JSON event channel, e.g.
 * `%window-pane-changed`). `sink.end()` is therefore a no-op; the
 * disposer's only job beyond unwinding the attach is to free the
 * `(ws, paneId)` registry slot.
 *
 * The returned disposer is idempotent. Calling it from a `close` handler
 * and again from an unrelated teardown path is safe.
 *
 * ## Contract notes
 *
 * - The internal sink's `write` MUST NOT throw — the library does not
 *   catch sink errors. The native `ws.send` call can throw on a torn-down
 *   socket (a TOCTOU window the WS API does not close). This is the
 *   real-but-rare path the `try/catch` covers; the catch is for socket-
 *   lifecycle races only, not for swallowing serializer rejections. Any
 *   non-lifecycle failure here would be a programming error on the host's
 *   side (a non-Uint8Array byte argument passed through, for instance) and
 *   should not happen — the sink contract pins `bytes` to `Uint8Array`.
 *
 * @returns A disposer that unwinds the attachment and frees the
 *   `(ws, paneId)` slot. Idempotent.
 * @see PaneByteSink for the underlying sink contract.
 * @see attachWebContentsSink (`../electron/main.ts`) for the matching
 *   Electron-side primitive.
 * @see TmuxClient.attachPaneSink for the attach API the disposer wraps.
 */
export function attachWebSocketSink(
  client: TmuxClient,
  ws: WebSocketSinkTarget,
  paneId: number,
): () => void {
  let active = ACTIVE_WEBSOCKET_SINKS.get(ws);
  if (active === undefined) {
    active = new Set<number>();
    ACTIVE_WEBSOCKET_SINKS.set(ws, active);
  }
  if (active.has(paneId)) {
    throw new BridgeError(
      "BRIDGE_PANE_SINK_ALREADY_ATTACHED",
      `attachWebSocketSink already active for paneId=${paneId} on this WebSocket; dispose the prior attachment before attaching a new one`,
    );
  }
  active.add(paneId);
  const registrySet = active;

  // [LAW:one-source-of-truth] No wire-level `paneEnd` frame exists for
  // this protocol; the bridge surfaces pane teardown via the JSON event
  // channel. `PaneByteSink.end` is optional and intentionally omitted —
  // the disposer below frees the registry slot, which is the only
  // teardown work this sink owns.
  const sink: PaneByteSink = {
    write(bytes): void {
      // [LAW:no-defensive-null-guards] `readyState` is a trust-boundary
      // check on the WebSocket lifecycle — same shape the bridge's
      // `wsSend` chokepoint uses for the same reason. Not a workaround
      // for a missing invariant; the lifecycle is external.
      if (ws.readyState !== WEBSOCKET_OPEN) return;
      const frame = encodePaneOutput({ type: "output", paneId, data: bytes });
      try {
        ws.send(frame);
      } catch {
        // TOCTOU: the socket may have torn down between the readyState
        // read and the send. Mirrors the bridge's `wsSend` behavior —
        // the close handler will tear the rest down.
      }
    },
  };

  const attachDispose = client.attachPaneSink(paneId, sink);

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    // Free the slot BEFORE invoking attachDispose: a rotated attachment
    // constructed from inside a synchronous downstream effect (e.g. a
    // disposer chained into a re-attach) can succeed without
    // false-positive duplicate detection. Mirrors `attachWebContentsSink`.
    registrySet.delete(paneId);
    attachDispose();
  };
}
