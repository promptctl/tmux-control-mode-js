// src/sinks/text-stream.ts
// TextStreamSink — streaming UTF-8 decoder sink.
//
// Pane chunks split at arbitrary byte boundaries, including the middle
// of a multi-byte UTF-8 sequence. A non-streaming TextDecoder per chunk
// emits U+FFFD on every such split. The streaming flag carries
// the tail forward so `0xC3` in one chunk and `0xA9` in the next decode
// as `'é'` rather than two replacement characters.
//
// [LAW:single-enforcer] One decoder per sink instance, owned by the
//   sink. The factory shape leaves no surface through which a consumer
//   could attach a second decoder to the same byte stream.
// [LAW:no-shared-mutable-globals] Decoder state is closure-scoped per
//   factory call. No module-level decoder, no per-pane-id map at module
//   scope.
// [LAW:types-are-the-program] The factory returns `BytesSink`; the
//   `TextDecoder` instance is unreachable from the value the consumer
//   holds.

import type { BytesSink } from "../pane-output.js";

/**
 * Create a streaming UTF-8 decoder sink.
 *
 * The returned sink owns a single `TextDecoder("utf-8", { fatal: false })`
 * in streaming mode and forwards each decode result to `handler`. The
 * `BytesSink` contract guarantees no chunk-boundary alignment, so
 * multi-byte sequences split across chunks decode correctly.
 *
 * **Single-pane only.** Use this sink with `paneScope(id)` — not with
 * `serverScope`, `sessionScope`, or `windowScope`. Multi-pane scopes deliver
 * chunks from different panes interleaved into the same decoder, corrupting
 * multi-byte UTF-8 sequences that straddle a chunk boundary. For multi-pane
 * text decoding, create one sink per pane with its own `paneScope`.
 *
 * `handler` is called once per `write` and once on `end`, with no
 * skip-empty filter — every write produces exactly one handler call
 * ([LAW:dataflow-not-control-flow]). `handler` MUST NOT throw: it runs
 * synchronously inside `write`, and a throwing handler violates the
 * `BytesSink` must-not-throw contract, breaking dispatch for all co-attached
 * sinks on the same client. Wrap risky work in try/catch inside `handler`.
 *
 * Call `createTextStreamSink` once per `attachBytesSink` call.
 * Each factory call returns a fresh decoder.
 *
 * @see BytesSink for the underlying sink contract.
 * @see TmuxClient.attachBytesSink for the attach API.
 */
export function createTextStreamSink(
  handler: (text: string) => void,
): BytesSink {
  const decoder = new TextDecoder("utf-8", { fatal: false });
  return {
    write(msg): void {
      handler(decoder.decode(msg.data, { stream: true }));
    },
    end(): void {
      handler(decoder.decode());
    },
  };
}
