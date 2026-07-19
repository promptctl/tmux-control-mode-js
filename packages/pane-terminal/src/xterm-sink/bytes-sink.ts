// packages/pane-terminal/src/xterm-sink/bytes-sink.ts
//
// XtermBytesSink — minimal BytesSink adapter for any xterm-compatible terminal.
//
// The second, unrelated product that used to share xterm-sink/index.ts with
// XtermSink. It shares NO code with XtermSink and imports from a different root
// (the wire package's BytesSink contract, not xterm + the DOM), which is why it
// lives in its own file. [LAW:decomposition], [LAW:one-way-deps].

import type {
  AttachOptions,
  BytesSink,
  ChunkPayload,
} from "@promptctl/tmux-control-mode-js";

// [LAW:decomposition] Minimal slice — only the write method this sink needs.
interface AttachBytesClient {
  attachBytesSink(sink: BytesSink, options?: AttachOptions): () => void;
}

/**
 * Minimum surface of an xterm.js `Terminal` (or compatible object) needed by
 * `XtermBytesSink`. Satisfied by `@xterm/xterm`'s `Terminal` and any mock.
 */
export interface XtermTerminalLike {
  write(data: Uint8Array): void;
}

/**
 * `BytesSink` that forwards each pane chunk directly to an xterm.js `Terminal`
 * (or any `XtermTerminalLike`).
 *
 * Each `write(msg)` call is exactly one `term.write(msg.data)`. No seeding,
 * no resize management, no font fitting. Use with `PaneStream + XtermSink`
 * (TerminalSink) if you need the full managed pipeline.
 *
 * ## Usage
 *
 * ```ts
 * const term = new Terminal();
 * term.open(container);
 * const dispose = attachXtermSink(client, term, { scope: paneScope(paneId) });
 * ```
 *
 * ## Contract
 *
 * - `write(msg)` always calls `term.write(msg.data)`.
 * - `end()` is a no-op.
 *
 * [LAW:composability] Does one thing: forward raw bytes. The caller controls
 *   terminal lifecycle, seeding, and resize — this sink does none of it.
 * [LAW:one-type-per-behavior] Shares the BytesSink interface with
 *   WebSocketSink and WebContentsSink; this is the xterm arm.
 */
export class XtermBytesSink implements BytesSink {
  constructor(private readonly term: XtermTerminalLike) {}

  write(msg: ChunkPayload): void {
    this.term.write(msg.data);
  }

  end(): void {
    // xterm.js owns its own buffer lifecycle; a pane ending is not a terminal
    // teardown, so there is nothing to flush or dispose here.
  }
}

/**
 * Attach an `XtermBytesSink` to `client` and return an idempotent disposer.
 *
 * Equivalent to:
 * ```ts
 * client.attachBytesSink(new XtermBytesSink(term), options)
 * ```
 *
 * `options.scope` defaults to `serverScope` (all panes on the server).
 * Pass `{ scope: paneScope(id) }` or `{ scope: sessionScope(id) }` to narrow.
 *
 * @see XtermBytesSink for the underlying BytesSink implementation.
 * @see XtermSink for the full DOM-backed renderer with resize / font management.
 */
export function attachXtermSink(
  client: AttachBytesClient,
  term: XtermTerminalLike,
  options?: AttachOptions,
): () => void {
  return client.attachBytesSink(new XtermBytesSink(term), options);
}
