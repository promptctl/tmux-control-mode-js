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
 * - `end?()` is optional. The library calls it exactly once when the sink
 *   stops receiving bytes (consumer-initiated dispose via the function
 *   returned from `attachPaneSink`). Sinks that hold cross-chunk state
 *   (like a streaming UTF-8 decoder) use this to flush.
 *
 * ## Per-attachment discipline
 *
 * A sink is *per-attachment*. Two `attachPaneSink` calls — whether on the
 * same pane or different panes — must use independent sink instances if the
 * sink carries state. Sharing one stateful sink across two attachments
 * interleaves their byte streams and corrupts both.
 *
 * @see TmuxClient.attachPaneSink
 */
export interface PaneByteSink {
  /**
   * Called synchronously for every pane chunk this sink is attached to.
   *
   * `bytes` is the post-octal-decode byte payload. The library makes no
   * guarantee about chunk boundaries — sinks that need cross-chunk state
   * (multi-byte UTF-8 sequences, ANSI escape sequences) must carry it
   * across calls themselves.
   *
   * MUST NOT block. MUST NOT throw — a throwing sink will surface as an
   * unhandled error on the next message in the parser loop and may detach
   * silently from the perspective of other sinks attached to the same pane.
   */
  write(bytes: Uint8Array): void;

  /**
   * Called at most once when the sink stops receiving bytes. Sinks holding
   * cross-chunk state use this to flush.
   *
   * The library's contract: `end` fires when the disposer returned from
   * `attachPaneSink` is invoked. Pane-close auto-`end` is NOT in scope for
   * the foundation API — tmux's control protocol has no pane-close
   * notification (only topology shifts via `window-pane-changed` and
   * `layout-change`); deriving a clean signal from those is a follow-up.
   */
  end?(): void;
}
