// src/connectors/electron/sink.ts
// WebContentsSink — BytesSink that forwards pane chunks to an Electron
// renderer as PaneOutputMessage IPC events.
//
// [LAW:one-type-per-behavior] WebContentsSink is the one BytesSink
//   implementation for the Electron main-process transport. Every
//   byte-consuming renderer destination is an instance of this class.
// [LAW:single-enforcer] Wire channel (`IPC.event`) and envelope shaping
//   (`PaneOutputMessage`) live in write() — one place, not per-caller.
// [LAW:dataflow-not-control-flow] write() always runs the same path;
//   the `wc.isDestroyed()` guard is a trust-boundary check on Electron's
//   lifecycle (a state the type system cannot encode), not a missing
//   invariant in the body.
// [LAW:composability] WebContentsSink does one thing: shape and send.
//   No exclusivity registry, no lifecycle state beyond BytesSink.
//
// Mirrors `../websocket/sink.ts`: same shape, transport-specific encode.

import type { TmuxConnection } from "../../client.js";
import {
  type AttachOptions,
  type BytesSink,
  type ChunkPayload,
} from "../../pane-output.js";
import type { PaneOutputMessage } from "../../protocol/types.js";

import { IPC, type WebContentsLike } from "./types.js";

// ---------------------------------------------------------------------------
// WebContentsSink — the concrete BytesSink for the Electron main transport
// ---------------------------------------------------------------------------

/**
 * `BytesSink` that forwards each pane chunk to a WebContents via IPC.
 *
 * Sends `PaneOutputMessage` objects on `IPC.event` — the same channel
 * `createMainBridge`'s event fan-out uses. Renderer-side code already
 * handles these via `isPaneOutput()` in the unified event handler.
 *
 * ## Usage
 *
 * ```ts
 * const sink = new WebContentsSink(wc);
 * const dispose = client.attachBytesSink(sink, { scope: sessionScope(id) });
 * // or via the convenience function:
 * const dispose = attachWebContentsSink(client, wc, { scope: paneScope(42) });
 * ```
 *
 * ## Contract
 *
 * - `write(msg)` is a no-op when `wc.isDestroyed()`.
 * - `end()` is a no-op. There is no per-attachment wire terminator on
 *   the IPC.event channel; pane lifecycle surfaces via tmux notifications.
 *
 * @see attachWebContentsSink for the one-line convenience wrapper.
 */
export class WebContentsSink implements BytesSink {
  constructor(private readonly wc: WebContentsLike) {}

  write(msg: ChunkPayload): void {
    // [LAW:no-defensive-null-guards] isDestroyed is a trust-boundary check
    // on Electron's WebContents lifecycle. Not a workaround for a missing
    // invariant; the lifecycle is external.
    if (this.wc.isDestroyed()) return;
    // Shape ChunkPayload → PaneOutputMessage so renderer's isPaneOutput()
    // check routes correctly through the shared IPC.event handler.
    const ipcMsg: PaneOutputMessage = {
      type: "output",
      paneId: msg.paneId,
      data: msg.data,
    };
    this.wc.send(IPC.event, ipcMsg);
  }

  end(): void {
    // No wire-level pane-end frame on IPC.event; pane lifecycle surfaces
    // via tmux notifications on the same channel.
  }
}

// ---------------------------------------------------------------------------
// attachWebContentsSink — one-line convenience wrapper
// ---------------------------------------------------------------------------

/**
 * Attach a `WebContentsSink` to `client` and return an idempotent disposer.
 *
 * Equivalent to:
 * ```ts
 * client.attachBytesSink(new WebContentsSink(wc), options)
 * ```
 *
 * `options.scope` defaults to `serverScope` (all panes on the server).
 * Pass `{ scope: paneScope(id) }` or `{ scope: sessionScope(id) }` to narrow.
 *
 * Unlike the previous per-pane API there is no exclusivity registry —
 * multiple attachments with different scopes on the same `wc` are valid.
 *
 * @see WebContentsSink for the underlying BytesSink implementation.
 */
export function attachWebContentsSink(
  client: Pick<TmuxConnection, "attachBytesSink">,
  wc: WebContentsLike,
  options?: AttachOptions,
): () => void {
  return client.attachBytesSink(new WebContentsSink(wc), options);
}
