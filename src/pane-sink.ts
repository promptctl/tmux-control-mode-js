// src/pane-sink.ts
// Sink-shaped subscription contract for pane bytes.
//
// [LAW:types-are-the-program] The strongest true theorem about a pane chunk
// is "bytes routed to a sink." Pane bytes are not deliverable through the
// emitter at all — `EmitterMessage` excludes `PaneOutputMessage`, so
// `client.on('output', cb)` is a TS error and `client.on('*', cb)`'s
// argument cannot narrow to a byte message. Bytes flow exclusively through
// this registry: `attachPaneSink(paneId, sink)` for one-pane consumers
// (xterm renderers, log capture, regex pipelines), `attachAllPanesSink(mux)`
// for forwarders that need every pane (bridges, observability, archiving).
// The misdecode footgun — `new TextDecoder('latin1').decode(...)`,
// `String.fromCharCode(...)`, `Buffer.from(...).toString('binary')`, a
// non-streaming `TextDecoder` — is structurally unreachable from any code
// path that subscribes to the emitter.
//
// [LAW:single-enforcer] Each sink owns its decode (xterm for visible terminals;
// `TextStreamSink` for text; IPC/WS for passthrough). Two consumers cannot
// race two decoders on the same byte stream because no consumer ever holds
// the bytes directly.
//
// [LAW:locality-or-seam] This module is the seam between the byte producer
// (TmuxClient) and any consumer. Consumers depend only on `PaneByteSink`
// or `PaneByteMultiplexer`, never on TmuxClient's emitter shape — the
// emitter literally cannot carry bytes.

import {
  isPaneOutput,
  type PaneOutputMessage,
  type TmuxMessage,
} from "./protocol/types.js";

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
 *   every sink attached to the pane and to every multiplexer attached via
 *   `attachAllPanesSink` — one sink mutating it would corrupt every other
 *   consumer's view of the chunk. The library retains a reference for the
 *   duration of the chunk's synchronous processing frame, but never beyond
 *   — once that frame returns, no library reference remains. Sinks that
 *   need to retain or modify the payload past their own `write` call MUST
 *   copy first (`bytes.slice()` or `new Uint8Array(bytes)`). A sink MAY
 *   forward the same reference downstream, but every forwarder MUST agree
 *   on the same read-only discipline.
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
// PaneByteMultiplexer — the "all panes" forwarder surface
// ---------------------------------------------------------------------------

/**
 * Receives every pane-byte chunk for every pane on the client, as a parsed
 * `PaneOutputMessage`. The multiplexer is the legitimate channel for
 * forwarder-style consumers — WebSocket bridges, Electron main-process
 * forwarders, byte archives — that need bytes from every present and
 * future pane on a single attachment.
 *
 * Use this **only** when you need every pane's bytes. For single-pane
 * consumption (an xterm terminal, a log matcher), use `attachPaneSink` with
 * a per-pane `PaneByteSink`; that surface is byte-only (no paneId, no
 * type/age) and composes better with the built-in sinks.
 *
 * [LAW:types-are-the-program] The multiplexer's `write` receives the full
 *   `PaneOutputMessage` because forwarders need every field to faithfully
 *   reconstruct the message on the wire (the `type` discriminator selects
 *   the frame variant; `age` carries the extended-output latency; `paneId`
 *   keys the frame). This is the one surface that intentionally hands the
 *   byte payload to the caller — naming it `attachAllPanesSink` makes the
 *   opt-in explicit.
 *
 * Contract:
 *
 * - `write(msg)` MUST be synchronous and non-blocking (same rule as
 *   `PaneByteSink.write`). The library calls it inline from the
 *   message-dispatch frame for every pane chunk.
 * - `msg.data` is the same read-only `Uint8Array` instance handed to every
 *   per-pane `PaneByteSink` attached to the same paneId. Mutation is
 *   forbidden; copy before retention. See `PaneByteSink.write` for the full
 *   ownership discipline.
 * - `end?()` fires once when the multiplexer's disposer is invoked. It is
 *   the multiplexer's responsibility to flush any per-pane state it
 *   accumulated. The library does not call `end` per pane (there is no
 *   reliable pane-close signal in tmux's control protocol).
 * - `write` MUST NOT throw — same rule as `PaneByteSink.write`. A throwing
 *   multiplexer poisons the chunk's dispatch frame for sinks attached after
 *   it in iteration order.
 */
export interface PaneByteMultiplexer {
  write(msg: PaneOutputMessage): void;
  end?(): void;
}

// ---------------------------------------------------------------------------
// PaneSinkRegistry — the canonical attachPaneSink / attachAllPanesSink
// implementation
//
// `TmuxClient` runs the parser itself and dispatches byte chunks directly
// from `handleMessage` into this registry. Bridge classes
// (`TmuxClientProxy`, `WebSocketTmuxClient`, `BridgePaneStreamClient`,
// `FakeTmuxClient`) receive already-parsed `output` / `extended-output`
// messages over their wire and dispatch into their own registry instance —
// every `TmuxClientLike` owns one. They need the SAME guarantees the
// canonical surface provides:
//
//   1. **Pre-dispatch snapshot** ("no back-fill"): who sees a chunk is
//      fixed at chunk-arrival time. Attaching a sink from inside another
//      sink's `write` must NOT cause the new sink to receive the current
//      chunk.
//   2. **Per-attachment lifecycle**: each `attach(...)` call yields an
//      independent token-keyed entry with its own disposer; `end?()` fires
//      once per disposer invocation.
//   3. **Bytes never reach the emitter**: pane bytes flow through this
//      registry alone. Each `TmuxClientLike`'s message-receive path
//      routes pane-output messages to `dispatch` and stops; state-event
//      messages flow to `emit`. The two channels are disjoint by message
//      type, and `EmitterMessage`'s type-level exclusion of
//      `PaneOutputMessage` makes the disjointness compile-checkable.
//
// `PaneSinkRegistry` is the single piece of code that encodes those
// semantics. Every `TmuxClientLike` implementation owns one and calls
// `registry.dispatch(msg)` from its message-receive path.
//
// [LAW:single-enforcer] One implementation across every TmuxClientLike. The
//   bridges do not each re-implement the snapshot dance or the per-attachment
//   bookkeeping — that would let them drift apart from `TmuxClient` and
//   from each other.
// [LAW:one-source-of-truth] The registry IS the per-pane attachment state.
//   `attach` and `attachAllPanes` are the sole writers (the public TmuxClient
//   methods `attachPaneSink` / `attachAllPanesSink` delegate to them); the
//   returned disposers are the sole deleters; `dispatch` is the sole reader.
// [LAW:locality-or-seam] The `PaneByteSink` and `PaneByteMultiplexer`
//   contracts are the seam. The fact that bridges deliver bytes via parsed
//   `output` messages while TmuxClient delivers them directly from the
//   parser is hidden behind the registry — consumers cannot observe which
//   backing the client uses.
// [LAW:types-are-the-program] The token-keyed Map makes per-attachment
//   identity structural: there is no "is this sink already attached" check
//   anywhere, because every attachment has its own key by construction.
// ---------------------------------------------------------------------------

/**
 * Snapshot of "who sees this chunk" produced at chunk-arrival time. The
 * dispatch site iterates the snapshot, not the live attachments, so sinks
 * attached or detached mid-iteration cannot back-fill or skip the current
 * chunk.
 *
 * The arrays are separate because the per-pane sinks see only the raw
 * bytes (`PaneByteSink.write(bytes)`) while the multiplexers see the full
 * parsed message (`PaneByteMultiplexer.write(msg)`).
 *
 * `null` covers both "message has no pane bytes" and "no consumer is
 * attached." The downstream dispatch site treats both the same.
 */
type PaneDispatchSnapshot = {
  readonly sinks: readonly PaneByteSink[];
  readonly multiplexers: readonly PaneByteMultiplexer[];
  readonly msg: PaneOutputMessage;
} | null;

/**
 * Per-pane registry of `PaneByteSink` attachments, plus the "all panes"
 * multiplexer attachments and the dispatch primitive every `TmuxClientLike`
 * implementation uses to deliver bytes into them.
 *
 * Owners construct one instance, hold it for the lifetime of the client,
 * and:
 *  - delegate `attachPaneSink(paneId, sink)` to `registry.attach(paneId, sink)`
 *  - delegate `attachAllPanesSink(mux)` to `registry.attachAllPanes(mux)`
 *  - call `registry.dispatch(msg)` from their message-receive path for
 *    every `PaneOutputMessage`. The owner's path MUST NOT also emit the
 *    message through its event emitter — the type system enforces this
 *    (`EmitterMessage` excludes `PaneOutputMessage`), and the runtime
 *    contract is "bytes are sink-only."
 */
export class PaneSinkRegistry {
  // [LAW:one-source-of-truth] Sole per-pane attachment state. `attach`
  //   writes; the per-attachment disposer deletes; `dispatch` reads. No
  //   mutation outside these three methods.
  private readonly attachments = new Map<number, Map<symbol, PaneByteSink>>();

  // [LAW:one-source-of-truth] Sole multiplexer attachment state, parallel
  //   to `attachments`. Token-keyed so every `attachAllPanes` call is an
  //   independent entry even when the same multiplexer is attached twice.
  private readonly multiplexers = new Map<symbol, PaneByteMultiplexer>();

  /**
   * Attach a sink to receive bytes for one pane. See the `PaneByteSink`
   * JSDoc above for the per-attachment lifecycle.
   *
   * The returned disposer is idempotent — calling it a second time is a
   * no-op (returns without re-invoking `sink.end?.()`). The token-keyed
   * Map structurally guarantees that every attach call yields an
   * independent entry even when the same sink instance is passed twice.
   */
  attach(paneId: number, sink: PaneByteSink): () => void {
    const token = Symbol("PaneByteSink");
    let perPane = this.attachments.get(paneId);
    if (perPane === undefined) {
      perPane = new Map();
      this.attachments.set(paneId, perPane);
    }
    perPane.set(token, sink);

    // [LAW:dataflow-not-control-flow] Idempotency is structural — `delete`
    //   returns `true` only on the first successful removal of the token,
    //   so its return value decides whether `end?()` fires. No closure-
    //   scoped `disposed` flag is needed.
    return () => {
      const perPaneNow = this.attachments.get(paneId);
      if (perPaneNow === undefined) return;
      const removed = perPaneNow.delete(token);
      if (!removed) return;
      if (perPaneNow.size === 0) {
        this.attachments.delete(paneId);
      }
      sink.end?.();
    };
  }

  /**
   * Attach a multiplexer to receive every pane-byte chunk for every pane.
   * See `PaneByteMultiplexer` for the contract.
   *
   * Idempotency: the returned disposer is per-attachment and idempotent.
   * `mux.end?.()` fires once when the disposer is invoked; the library
   * does not signal pane-close.
   */
  attachAllPanes(mux: PaneByteMultiplexer): () => void {
    const token = Symbol("PaneByteMultiplexer");
    this.multiplexers.set(token, mux);
    return () => {
      const removed = this.multiplexers.delete(token);
      if (!removed) return;
      mux.end?.();
    };
  }

  /**
   * Snapshot-and-fan-out for one parsed `PaneOutputMessage`. Owners invoke
   * this from their message-receive path for every byte message. The
   * accompanying emitter path MUST NOT also receive the message — the
   * `EmitterMessage` type excludes `PaneOutputMessage` so any attempt to
   * `emit` a byte message is a compile error.
   *
   * Non-pane-output messages and panes with zero attached consumers are
   * cheap no-ops (one Map lookup, one early-return — no allocation).
   */
  dispatch(msg: TmuxMessage): void {
    const snapshot = this.computeSnapshot(msg);
    if (snapshot === null) return;
    // [LAW:dataflow-not-control-flow] Iterate the snapshot arrays, not
    //   the live registry. Mutations to attachments from inside a sink's
    //   own `write` (a sink calling `attach`, a multiplexer detaching
    //   itself) cannot back-fill or skip the current chunk.
    for (const sink of snapshot.sinks) sink.write(snapshot.msg.data);
    for (const mux of snapshot.multiplexers) mux.write(snapshot.msg);
  }

  // [LAW:single-enforcer] Sole reader of the attachment iteration order.
  //   Materializing both iterables here, once, is what makes the dispatch
  //   above robust to re-entrant attach/detach inside a sink's `write`.
  private computeSnapshot(msg: TmuxMessage): PaneDispatchSnapshot {
    if (!isPaneOutput(msg)) return null;
    const perPane = this.attachments.get(msg.paneId);
    const sinks =
      perPane === undefined || perPane.size === 0
        ? []
        : Array.from(perPane.values());
    const multiplexers =
      this.multiplexers.size === 0
        ? []
        : Array.from(this.multiplexers.values());
    if (sinks.length === 0 && multiplexers.length === 0) return null;
    return { sinks, multiplexers, msg };
  }
}
