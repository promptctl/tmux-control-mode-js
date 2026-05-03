// src/connectors/streams/web.ts
// ReadableStream<TmuxMessage> projection of a TmuxClient.
//
// Pure portable code — works in browser, Node 16.5+, Deno, Bun. The Web
// Streams `ReadableStream` global is universally available.
//
// IMPL §7.2: gives consumers that prefer pull-based stream APIs an
// alternative to TmuxClient's push-based `on()` callbacks.

import type { TmuxClient } from "../../client.js";
import type { TmuxMessage } from "../../protocol/types.js";

/**
 * Adapt a TmuxClient's event stream as a `ReadableStream<TmuxMessage>`.
 *
 * Every notification the client emits is enqueued. The `exit` message
 * (synthetic, emitted when the underlying transport closes) is enqueued
 * AND closes the stream — so consumers awaiting end-of-stream see the
 * reason before EOF.
 *
 * Cancelling the reader unsubscribes from the client. The TmuxClient itself
 * is not closed — the adapter is a non-owning projection.
 *
 * [LAW:dataflow-not-control-flow] One handler runs on every message; the
 * `exit` value triggers the close-controller side effect through data, not
 * through a parallel listener.
 */
export function toReadableStream(
  client: TmuxClient,
): ReadableStream<TmuxMessage> {
  let handler: ((event: TmuxMessage) => void) | null = null;
  return new ReadableStream<TmuxMessage>({
    start(controller) {
      handler = (event: TmuxMessage): void => {
        controller.enqueue(event);
        if (event.type === "exit") controller.close();
      };
      client.on("*", handler);
    },
    cancel() {
      if (handler !== null) client.off("*", handler);
    },
  });
}
