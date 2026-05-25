// src/pane-sink.ts
// Sink-shaped subscription contract for pane bytes.
//
// [LAW:types-are-the-program] The strongest true theorem about a pane chunk
// is "bytes." The previous public surface (`client.on('output', …)`) shipped
// `Uint8Array` as a value the consumer holds, which TypeScript permits to be
// fed into `new TextDecoder('latin1').decode(...)`, `String.fromCharCode(...)`,
// `Buffer.from(...).toString('binary')`, or a non-streaming `TextDecoder` —
// each of which corrupts every multi-byte sequence. `PaneByteSink` removes
// the value from the holder's reach entirely: bytes flow into a sink the
// consumer composed; the consumer never decodes.
//
// [LAW:single-enforcer] Each sink owns its decode (xterm for visible terminals;
// `TextStreamSink` for text; IPC/WS for passthrough). Two consumers cannot
// race two decoders on the same byte stream because no consumer ever holds
// the bytes directly.
//
// [LAW:locality-or-seam] This interface is the seam between the byte producer
// (TmuxClient) and any consumer. Consumers depend only on `PaneByteSink`,
// never on TmuxClient's emitter shape for pane bytes.

import type { TmuxEventMap } from "./emitter.js";

/**
 * Sink for pane bytes.
 *
 * Implementations consume post-octal-decode bytes (the same shape that the
 * deprecated `OutputMessage.data` carries) and route them somewhere — into
 * an xterm.js terminal, a streaming UTF-8 decoder, an Electron IPC channel,
 * a WebSocket binary frame, or any composition thereof.
 *
 * ## Contract
 *
 * - `write(bytes)` MUST be synchronous and non-blocking. The library calls
 *   it inline from the parser loop for every pane chunk; a slow sink will
 *   stall every consumer attached to the same client. If a sink needs async
 *   work (DB writes, network I/O), it must buffer internally. The library
 *   provides no backpressure on this path — flow control lives on the
 *   `PaneAction` / `%pause`/`%continue` API.
 *
 * - **`bytes` is read-only.** The same `Uint8Array` instance is passed to
 *   every sink attached to the pane and to every `client.on('output', …)`
 *   listener on the deprecated event path — one sink (or listener)
 *   mutating it would corrupt every other consumer's view of the chunk.
 *   The library retains a reference for the duration of the chunk's
 *   synchronous processing frame (during which it fans the buffer out to
 *   every attached sink and then emits the deprecated event), but never
 *   beyond — once that frame returns, no library reference remains.
 *   Sinks that need to retain or modify the payload past their own
 *   `write` call MUST copy first (`bytes.slice()` or
 *   `new Uint8Array(bytes)`). A sink MAY forward the same reference
 *   downstream, but every forwarder MUST agree on the same read-only
 *   discipline.
 *
 * - `end?()` is optional. The library calls it exactly once when an
 *   attachment is disposed (the function returned from `attachPaneSink`
 *   is invoked). Sinks that hold cross-chunk state — like a streaming
 *   UTF-8 decoder — use this to flush.
 *
 * ## Per-attachment lifecycle
 *
 * Every `attachPaneSink` call is an **independent attachment** with its
 * own disposer. The same sink instance MAY be attached to multiple panes,
 * or to the same pane multiple times: each attachment is tracked
 * separately, the sink's `write` runs once per attachment per chunk, and
 * `end?()` fires once per disposer call. There is no de-duplication and
 * no shared lifecycle — a disposer ends only the attachment it was
 * returned for.
 *
 * For sinks that carry per-stream state (a streaming UTF-8 decoder, a
 * regex matcher), pairing one fresh sink instance with one attachment is
 * the cleanest shape — that way the state matches the byte stream
 * one-to-one and there's no ambiguity about when `end()` flushes. Sinks
 * that are genuinely stateless (an IPC forwarder, a binary-frame
 * encoder) MAY be shared safely.
 *
 * @see TmuxClient.attachPaneSink
 */
export interface PaneByteSink {
  /**
   * Called synchronously for every pane chunk this sink is attached to.
   *
   * `bytes` is the post-octal-decode byte payload, owned by the caller.
   * It MUST be treated as read-only — other sinks attached to the same
   * pane will see the same instance via subsequent `write` calls, and
   * `client.on('output', …)` listeners will see the same instance via
   * the deprecated event path. To retain or modify the payload past
   * this `write` call, copy first (`bytes.slice()` or
   * `new Uint8Array(bytes)`). The library makes no guarantee about
   * chunk boundaries — sinks that need cross-chunk state (multi-byte
   * UTF-8 sequences, ANSI escape sequences) must carry it across calls
   * themselves.
   *
   * MUST NOT block. MUST NOT throw — the library does not catch sink
   * errors. A throwing sink propagates the exception synchronously up
   * through the per-chunk dispatch loop, the parser's message callback,
   * and into the transport's data handler; sinks dispatched later in the
   * same chunk's snapshot will not receive that chunk, and the chunk's
   * processing frame may be partially aborted. The throwing sink remains
   * attached — there is no automatic detachment on error. If a sink needs
   * to handle errors internally, wrap its own work in try/catch and surface
   * the error through its own channel (a status callback, an event, etc.).
   *
   * Error isolation across sinks is intentionally out of scope for the
   * foundation API; building it in would require the library to choose
   * what to do with caught errors (log? event? rethrow async?) which is
   * a downstream policy decision.
   */
  write(bytes: Uint8Array): void;

  /**
   * Called at most once per attachment when the disposer returned from
   * `attachPaneSink` is invoked. Sinks holding cross-chunk state use this
   * to flush.
   *
   * Per-attachment scoped: if the same sink instance is attached twice,
   * its `end` fires once per disposer call (i.e. up to twice). The library
   * never calls `end` for any other reason. Pane-close auto-`end` is NOT
   * in scope for the foundation API — tmux's control protocol has no
   * pane-close notification (only topology shifts via
   * `window-pane-changed` and `layout-change`); deriving a clean signal
   * from those is a follow-up.
   */
  end?(): void;
}

// ---------------------------------------------------------------------------
// attachPaneSinkViaEmitter — bridge-class implementation primitive
//
// `TmuxClient` dispatches bytes directly from its parser into a per-pane
// registry (sinks fire *before* `emit('output', …)`). Bridge classes —
// `TmuxClientProxy`, `WebSocketTmuxClient`, `BridgePaneStreamClient`, and the
// in-tree `FakeTmuxClient` — receive *already-parsed* `output` /
// `extended-output` events over their wire and dispatch them through an
// internal `TypedEmitter`. For those classes the emitter IS the byte fan-out
// point, so their `attachPaneSink` implementation is structurally an
// emitter-filter that satisfies the same per-attachment contract.
//
// [LAW:single-enforcer] One implementation shared by every emitter-backed
//   bridge. The semantics — per-attachment independence, idempotent disposer,
//   single `end()` invocation — match `TmuxClient.attachPaneSink` at the
//   per-call boundary so downstream consumers (PaneStream) cannot observe
//   which backing the client uses.
// [LAW:locality-or-seam] The seam is the `PaneByteSink` contract. This helper
//   is the adapter between that contract and the legacy event-emitter surface
//   bridges use to receive bytes. Bridge consumers compose the sink; the
//   emitter is an implementation detail behind this seam.
// [LAW:dataflow-not-control-flow] Both handlers run every chunk. The paneId
//   check is data filtering, not control flow that skips the operation —
//   the operation (filter and conditionally forward) executes uniformly on
//   every byte event.
// ---------------------------------------------------------------------------

/**
 * The minimum emitter shape `attachPaneSinkViaEmitter` consumes: typed
 * `on`/`off` for `output` and `extended-output`. Every `TmuxClientLike`
 * implementation in the monorepo already satisfies this — the helper does
 * not constrain the rest of the client surface.
 */
export interface PaneByteEmitter {
  on<K extends "output" | "extended-output">(
    event: K,
    handler: (ev: TmuxEventMap[K]) => void,
  ): void;
  off<K extends "output" | "extended-output">(
    event: K,
    handler: (ev: TmuxEventMap[K]) => void,
  ): void;
}

/**
 * Wire a `PaneByteSink` to a bridge-class emitter that already dispatches
 * pre-parsed `output` / `extended-output` events. Registers two filtered
 * handlers and returns an idempotent disposer that removes them and invokes
 * `sink.end?.()` exactly once.
 *
 * Use this from a bridge class's `attachPaneSink` implementation; the result
 * is structurally identical (from any caller's perspective) to
 * `TmuxClient.attachPaneSink`, which is registry-backed because TmuxClient
 * runs the parser itself.
 *
 * Per-attachment lifecycle: every call yields fresh handlers and an
 * independent disposer. Attaching the same sink instance N times to the
 * same pane registers 2N handlers (one `output` + one `extended-output` per
 * attachment) and yields N disposers; each disposer ends only its own
 * attachment, and `sink.end?.()` fires once per disposer call.
 */
export function attachPaneSinkViaEmitter(
  client: PaneByteEmitter,
  paneId: number,
  sink: PaneByteSink,
): () => void {
  const onOutput = (ev: TmuxEventMap["output"]): void => {
    if (ev.paneId === paneId) sink.write(ev.data);
  };
  const onExtendedOutput = (ev: TmuxEventMap["extended-output"]): void => {
    if (ev.paneId === paneId) sink.write(ev.data);
  };
  client.on("output", onOutput);
  client.on("extended-output", onExtendedOutput);

  // [LAW:dataflow-not-control-flow] Idempotency carried as a value (`disposed`)
  //   instead of branching on whether to re-execute. The second invocation
  //   runs the same closure and returns at the data-driven early exit.
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    client.off("output", onOutput);
    client.off("extended-output", onExtendedOutput);
    sink.end?.();
  };
}
