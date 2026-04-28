// src/connectors/streams/node.ts
// Node-only adapters: a `Readable` (objectMode) projection of a TmuxClient
// and a Node `EventEmitter` projection. Both are Node-only because their
// types come from `node:stream` and `node:events`.
//
// IMPL §7.2 + §7.3.

import { Readable } from "node:stream";
import { EventEmitter } from "node:events";

import type { TmuxClient } from "../../client.js";
import type { TmuxMessage } from "../../protocol/types.js";

/**
 * Adapt a TmuxClient as a Node.js `Readable` stream in object mode.
 *
 * Every notification is `push`ed; the synthetic `exit` message is pushed
 * AND followed by `push(null)` to signal end-of-stream. Destroying the
 * stream unsubscribes from the client (the TmuxClient itself is not
 * closed — the adapter is a non-owning projection).
 *
 * Useful in Node-side test harnesses or pipelines that compose tmux events
 * with other Node streams (e.g. `pipeline(toNodeStream(client), filter,
 * sink)`).
 */
export function toNodeStream(client: TmuxClient): Readable {
  let handler: ((event: TmuxMessage) => void) | null = null;
  const stream = new Readable({
    objectMode: true,
    // [LAW:dataflow-not-control-flow] Pull-trigger is a no-op — the events
    // are produced by tmux on its own schedule and pushed unconditionally.
    // Backpressure is best-effort: Node's stream queue grows when the
    // consumer is slow, just like every other producer-driven Readable.
    read(): void {
      // intentional no-op
    },
    destroy(err, cb): void {
      if (handler !== null) client.off("*", handler);
      cb(err);
    },
  });
  handler = (event: TmuxMessage): void => {
    stream.push(event);
    if (event.type === "exit") stream.push(null);
  };
  client.on("*", handler);
  return stream;
}

/**
 * Adapt a TmuxClient as a Node.js `EventEmitter`.
 *
 * Every notification is re-emitted on the EE under its `type` (so
 * `ee.on("window-add", …)` mirrors `client.on("window-add", …)`). A
 * wildcard `"*"` event is also emitted for parity with TmuxClient's
 * wildcard subscription.
 *
 * The adapter holds a reference to the client; its lifetime ends when the
 * client is GC'd or `client.close()` is called. The returned EE has no
 * separate `dispose()` — Node EE consumers don't expect one, and the
 * `exit` event signals when no more events will arrive.
 *
 * [LAW:dataflow-not-control-flow] One subscriber on the client; every event
 * fans out the same way through `ee.emit`.
 */
export function toEventEmitter(client: TmuxClient): EventEmitter {
  const ee = new EventEmitter();
  client.on("*", (event: TmuxMessage): void => {
    ee.emit(event.type, event);
    ee.emit("*", event);
  });
  return ee;
}
