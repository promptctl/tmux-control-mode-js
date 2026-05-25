// src/sinks/text-stream.ts
// TextStreamSink — streaming UTF-8 decoder sink.
//
// Pane chunks split at arbitrary byte boundaries, including the middle
// of a multi-byte UTF-8 sequence. A non-streaming TextDecoder per chunk
// (`new TextDecoder().decode(bytes)` — what the first downstream consumer
// wrote) emits U+FFFD on every such split. The streaming flag carries
// the tail forward so `0xC3` in one chunk and `0xA9` in the next decode
// as `'é'` rather than two replacement characters. This sink is the
// library-provided answer to "I just want text from pane bytes."
//
// [LAW:single-enforcer] One decoder per sink instance, owned by the
//   sink. The factory shape leaves no surface through which a consumer
//   could attach a second decoder to the same byte stream.
// [LAW:no-shared-mutable-globals] Decoder state is closure-scoped per
//   factory call. No module-level decoder, no per-pane-id map at module
//   scope.
// [LAW:types-are-the-program] The factory returns `PaneByteSink`; the
//   `TextDecoder` instance is unreachable from the value the consumer
//   holds.

import type { PaneByteSink } from "../pane-sink.js";

/**
 * Create a streaming UTF-8 decoder sink.
 *
 * The returned sink owns a single `TextDecoder("utf-8", { fatal: false })`
 * in streaming mode and forwards each decode result to `handler`. The
 * library's `PaneByteSink` contract guarantees no chunk-boundary
 * alignment, so multi-byte sequences split across chunks decode
 * correctly: the leading byte(s) are held across calls and surface in
 * the next `write` that completes them.
 *
 * `handler` is called once per `write` and once on `end`, with no
 * skip-empty filter. A chunk that ends mid-multi-byte yields
 * `handler("")` and the next completing chunk yields the resolved text.
 * This shape removes the `if` that would otherwise live in the sink
 * body ([LAW:dataflow-not-control-flow] — every write produces exactly
 * one handler call). Consumers that only want non-empty text should
 * filter `text.length === 0` themselves.
 *
 * ## Per-attachment discipline
 *
 * Call `createTextStreamSink` once per `client.attachPaneSink` call.
 * Each factory call returns a fresh decoder; reusing one returned sink
 * across two attachments would feed two pane streams through a single
 * decoder, splicing their multi-byte sequences together — the exact
 * footgun the sink contract exists to make impossible. The library no
 * longer dedupes attachments structurally (each attachment carries its
 * own token), so this discipline lives in the contract, not in
 * enforcement. See the `tmux-pane-sink-hd6` epic for the underlying
 * analysis.
 *
 * ## Handler contract
 *
 * `handler` runs synchronously inside `write` and `end`. It MUST NOT
 * throw — `PaneByteSink.write` itself MUST NOT throw (the library does
 * not catch sink errors), and the handler is part of `write`'s
 * synchronous frame. A throwing handler propagates up through the sink
 * into the parser's per-chunk dispatch loop and breaks the contract for
 * every other sink attached to the same client. Consumers that need
 * error handling should wrap the work inside the handler in `try/catch`
 * and surface failures through a separate channel.
 *
 * ## Flush semantics
 *
 * `end()` calls `decoder.decode()` with no `{ stream: true }` flag,
 * which flushes any held tail. A trailing partial multi-byte sequence
 * surfaces as `'�'` — the standard TextDecoder replacement
 * character — and is forwarded to `handler` like any other decode
 * result. If no tail is held, `handler("")` fires.
 *
 * @see PaneByteSink for the underlying sink contract.
 * @see TmuxClient.attachPaneSink for the attach API.
 */
export function createTextStreamSink(
  handler: (text: string) => void,
): PaneByteSink {
  const decoder = new TextDecoder("utf-8", { fatal: false });
  return {
    write(bytes): void {
      handler(decoder.decode(bytes, { stream: true }));
    },
    end(): void {
      handler(decoder.decode());
    },
  };
}
