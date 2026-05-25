// src/connectors/electron/types.ts
// Shared types + constants for the Electron IPC bridge.
// Imported by both main.ts (Node-side) and renderer.ts (browser-side).
// MUST remain free of Node-only imports.
//
// RPC validation, dispatch, and the method allowlist live in
// `src/connectors/rpc.ts` — this file owns only what is genuinely
// electron-specific (IPC channel names, ack message shape, the
// MainBridgeOptions backpressure tunables, single-instance bridge errors).

// [LAW:one-source-of-truth] IPC channel names live here only. RPC method
// names + arg shapes live in ../rpc.ts; this module imports them rather than
// re-declaring.

// [LAW:locality-or-seam] Structural "like" interfaces (IpcMainLike, etc.)
// keep Electron out of the library's dependencies entirely.

import type { CommandResponse } from "../../protocol/types.js";
import type { BridgeErrorPayload as BridgeErrorPayloadType } from "../errors.js";
import type { RpcRequest } from "../rpc.js";

// ---------------------------------------------------------------------------
// IPC channel names. Defined once, imported by both sides.
// ---------------------------------------------------------------------------

export const IPC = {
  /** main → renderer: forwarded TmuxMessage (all notifications, including `exit`). */
  event: "tmux:event",
  /** renderer → main: method dispatch via ipcRenderer.invoke. */
  invoke: "tmux:invoke",
  /** renderer → main: "send me events". */
  register: "tmux:register",
  /** renderer → main: "stop sending me events". */
  unregister: "tmux:unregister",
  /**
   * renderer → main: "I processed N output bytes for pane P". Drives the
   * credit-based backpressure loop in main.ts — when outstanding bytes for
   * a pane stay above the high-watermark, main pauses the pane via
   * setPaneAction(Pause); acks pulling outstanding back below the
   * low-watermark trigger a resume. See AckMessage.
   */
  ack: "tmux:ack",
  /**
   * main → renderer: one chunk of pane bytes from a `WebContentsSink`. Payload
   * is `PaneBytesEnvelope`. Distinct from `event` so a renderer's pane-byte
   * receiver does not have to filter the broadcast event stream — only sinks
   * that the host explicitly attached on the main side reach this channel.
   * `Uint8Array` rides Electron's structured-clone IPC; no base64 hop.
   */
  paneBytes: "tmux:pane-bytes",
  /**
   * main → renderer: terminator for an `attachWebContentsSink` attachment.
   * Fired once when the disposer returned from that factory runs. Payload
   * is `PaneEndEnvelope`. The renderer-side receiver auto-detaches on this
   * frame — no further `paneBytes` will arrive for the (sink, paneId)
   * attachment that emitted it.
   */
  paneEnd: "tmux:pane-end",
} as const;

/**
 * Every channel the bridge talks on is one of the values of `IPC`. Narrowing
 * the structural-Electron interfaces below to this type makes channel typos a
 * compile error at the bridge boundary instead of a silent runtime mismatch.
 *
 * [LAW:one-source-of-truth] `IPC` is the only place channel strings are spelled;
 * `IpcChannel` is derived from it. Adding a new channel = one edit.
 */
export type IpcChannel = (typeof IPC)[keyof typeof IPC];

// ---------------------------------------------------------------------------
// Structural "like" interfaces for Electron.
//
// [LAW:locality-or-seam] These structural interfaces keep `electron` out of
// the library's runtime dependencies. `IpcChannel` narrows the channel-name
// parameter so a typo at the call site is a compile error.
//
// [LAW:one-type-per-behavior] `on` and `removeListener` use the SAME listener
// shape so a registered handler can be passed verbatim to removeListener
// without a cast — the signature mismatch this used to have was variance
// leaking into every call site.
// ---------------------------------------------------------------------------

export interface WebContentsLike {
  send(channel: IpcChannel, ...args: unknown[]): void;
  once(event: "destroyed", listener: () => void): void;
  /**
   * Required so the bridge can detach its `destroyed` listener when a
   * sender is torn down via `unregister` while the WebContents is still
   * alive. Without this the once-handler closure stays attached to the
   * emitter for the WebContents's remaining lifetime, leaks the senders
   * Map slot it referenced, and fires later as a no-op against a
   * sender that no longer exists.
   */
  removeListener(event: "destroyed", listener: () => void): void;
  isDestroyed(): boolean;
}

export interface IpcMainInvokeEventLike {
  readonly sender: WebContentsLike;
}

export interface IpcMainEventLike {
  readonly sender: WebContentsLike;
}

export type IpcMainOnListener = (
  event: IpcMainEventLike,
  ...args: unknown[]
) => void;

export type IpcMainInvokeListener = (
  event: IpcMainInvokeEventLike,
  ...args: unknown[]
) => unknown | Promise<unknown>;

export interface IpcMainLike {
  handle(channel: IpcChannel, listener: IpcMainInvokeListener): void;
  removeHandler(channel: IpcChannel): void;
  on(channel: IpcChannel, listener: IpcMainOnListener): void;
  removeListener(channel: IpcChannel, listener: IpcMainOnListener): void;
}

export interface IpcRendererEventLike {
  /**
   * Real Electron exposes `event.sender` as the `IpcRenderer` instance that
   * received the message — useful in cases where the renderer-side handler
   * wants to send a reply or distinguish event sources (e.g. iframe frame
   * routing, or a preload that fans events to multiple windows).
   *
   * The bridge does not currently use `sender`: the renderer proxy is a 1:1
   * pairing with the `ipcRenderer` it was constructed against, so origin is
   * already known by construction. Typing this as `unknown` keeps the
   * structural interface honest about not depending on it. Narrow the type
   * (or replace with `IpcRendererLike`) if a future feature needs to validate
   * an event's origin.
   */
  readonly sender?: unknown;
}

export type IpcRendererOnListener = (
  event: IpcRendererEventLike,
  ...args: unknown[]
) => void;

export interface IpcRendererLike {
  invoke(channel: IpcChannel, ...args: unknown[]): Promise<unknown>;
  send(channel: IpcChannel, ...args: unknown[]): void;
  on(channel: IpcChannel, listener: IpcRendererOnListener): void;
  removeListener(channel: IpcChannel, listener: IpcRendererOnListener): void;
}

// ---------------------------------------------------------------------------
// InvokeRequest — name kept as an internal alias for renderer.ts and the
// existing examples; the real type lives in ../rpc.ts.
// ---------------------------------------------------------------------------

export type InvokeRequest = RpcRequest;

// ---------------------------------------------------------------------------
// InvokeResultEnvelope — the wire shape `ipcMain.handle("tmux:invoke")`
// returns and `ipcRenderer.invoke(...)` resolves to.
//
// [LAW:one-source-of-truth] Both main.ts (which constructs envelopes) and
// renderer.ts (which dispatches on `status` and reconstructs typed errors)
// import this declaration. There is no parallel definition on either side.
//
// [LAW:dataflow-not-control-flow] Every outcome of an invoke handler call
// becomes a value in this discriminated union; the renderer-side proxy
// dispatches on `status` rather than on whether a Promise rejected. The
// handler never throws, so `ipcMain.handle` never has to round-trip an
// Error subclass through Electron's structured-clone serializer (which
// would drop `.code` on `BridgeError` and `.response` on
// `TmuxCommandError`).
// ---------------------------------------------------------------------------

export type InvokeResultEnvelope =
  | { readonly status: "ok"; readonly response: CommandResponse }
  | { readonly status: "tmux-error"; readonly response: CommandResponse }
  | {
      readonly status: "bridge-error";
      readonly error: BridgeErrorPayloadType;
    };

// ---------------------------------------------------------------------------
// Renderer → main: output-byte ack frame.
// ---------------------------------------------------------------------------

export interface AckMessage {
  readonly paneId: number;
  readonly bytes: number;
}

// ---------------------------------------------------------------------------
// Main → renderer: WebContentsSink envelopes.
//
// [LAW:one-source-of-truth] One declaration for each envelope shape; both
// `attachWebContentsSink` (main.ts) and `createPaneBytesReceiver` (renderer.ts)
// import it so the wire shape cannot drift across the IPC hop.
// [LAW:types-are-the-program] The envelope is the seam type that carries
// `(paneId, bytes)` end-to-end. Holding a `Uint8Array` on the renderer is
// only possible inside the receiver's filter-and-forward frame; the value
// leaves the consumer's reach the moment it lands in the receiver's `sink`.
// ---------------------------------------------------------------------------

/** Payload for `IPC.paneBytes`. `data` survives Electron's structured clone. */
export interface PaneBytesEnvelope {
  readonly paneId: number;
  readonly data: Uint8Array;
}

/** Payload for `IPC.paneEnd`. */
export interface PaneEndEnvelope {
  readonly paneId: number;
}

// ---------------------------------------------------------------------------
// Main-bridge lifecycle handle.
// ---------------------------------------------------------------------------

export interface MainBridgeHandle {
  /**
   * Remove all IPC handlers installed by createMainBridge and clear the
   * internal subscriber set. Does NOT close the underlying TmuxClient — the
   * host owns that lifecycle.
   *
   * `dispose()` is synchronous: it marks every in-flight invoke dispatch
   * aborted and tears down sender accounting, but it does NOT await the
   * underlying ipcMain.handle promises that are still resolving against the
   * TmuxClient FIFO. Callers that need to know when those promises have
   * actually settled (e.g. tests, or a host that tears down the TmuxClient
   * immediately after dispose) should `await handle.drain()` after
   * `dispose()` returns. Aborted dispatches surface to renderers as
   * `BridgeError("BRIDGE_ABORTED", ...)`.
   */
  dispose(): void;
  /**
   * Resolve once every in-flight ipcMain.handle("tmux:invoke") promise has
   * settled. Useful after `dispose()` so callers can wait for the bridge to
   * fully unwind before tearing down the underlying `TmuxClient`. Without
   * this, an in-flight dispatch can still be `await`ing `client.execute(...)`
   * when the host calls `client.close()`, producing a confusing rejection
   * shape on the renderer side.
   *
   * `timeoutMs`: when provided, drain returns after the timeout regardless
   * of whether all handlers have settled. The unsettled promises are NOT
   * cancelled — they continue resolving in the background and their post-
   * await branches see `aborted` and throw `BridgeError("BRIDGE_ABORTED")`. The
   * timeout is a "I have a host shutdown deadline" escape hatch, not a
   * cancellation primitive.
   *
   * Late dispatches that observe the abort flag report
   * `BridgeError("BRIDGE_ABORTED", ...)` to their callers via the result
   * envelope.
   */
  drain(timeoutMs?: number): Promise<void>;
}

// ---------------------------------------------------------------------------
// Main-bridge tunables.
// ---------------------------------------------------------------------------

export interface MainBridgeOptions {
  /**
   * Per-pane outstanding-byte threshold (summed across all subscribed
   * renderers) at which main pauses the pane. Default: 1 MiB.
   */
  readonly outputHighWatermark?: number;
  /**
   * Per-pane outstanding-byte threshold at which a paused pane is resumed.
   * Must be < outputHighWatermark. Default: 256 KiB.
   */
  readonly outputLowWatermark?: number;
}

// [LAW:one-source-of-truth] Watermark defaults live in
// `../bridge-connection.ts` (where the watermark loop is implemented) and
// are re-exported here so a main-process consumer that only imports from
// `./types` keeps a single import site. Removing this re-export silently
// would break external callers that reference the names.
export {
  DEFAULT_OUTPUT_HIGH_WATERMARK,
  DEFAULT_OUTPUT_LOW_WATERMARK,
} from "../bridge-connection.js";

// ---------------------------------------------------------------------------
// Renderer-bridge tunables.
// ---------------------------------------------------------------------------

export interface RendererBridgeOptions {
  /**
   * Bytes-since-last-ack threshold per pane. Renderer batches `tmux:ack`
   * messages to amortize IPC chatter; lower values give tighter feedback to
   * the main-side watermark loop at the cost of more ack traffic.
   * Default: 64 KiB.
   */
  readonly ackBatchBytes?: number;
  /**
   * Optional per-call timeout for proxy invokes. When a positive number, the
   * proxy rejects with `BridgeError("BRIDGE_TIMEOUT")` if the underlying
   * `ipcRenderer.invoke` does not settle within `invokeTimeoutMs`. Disabled
   * (default) — proxy.execute() inherits whatever timeout the underlying
   * `client.execute()` has, which today is none. Set this when the calling
   * window must distinguish "main is wedged" from "tmux is slow" (e.g. a
   * UI freeze handler that resets the proxy on persistent timeout).
   *
   * The TIMEOUT rejection does NOT cancel the underlying main-side dispatch:
   * tmux may still respond eventually and the FIFO will resolve in order.
   * Only the renderer-side promise gives up early.
   */
  readonly invokeTimeoutMs?: number;
}

export const DEFAULT_ACK_BATCH_BYTES = 1 << 16;

// ---------------------------------------------------------------------------
// Bridge errors.
//
// [LAW:one-source-of-truth] BridgeError + BridgeErrorCode + BridgeErrorPayload
// live in `../errors.ts` and are shared with the WebSocket connector. This
// module re-exports them so electron-only consumers keep a single import site
// and `instanceof BridgeError` works irrespective of which transport produced
// the error. No parallel class declaration exists here.
//
// RPC-validation failures (BRIDGE_INVALID_REQUEST / BRIDGE_UNKNOWN_METHOD /
// BRIDGE_INVALID_ARG) are produced by `parseRpcRequest` (which throws
// `RpcError`) and translated into `BridgeError` at the IPC trust boundary in
// `main.ts`. BridgeError thrown directly is reserved for bridge-internal
// failures (single-instance guard, invalid options, abort, subscription
// ownership, ack-frame parse).
// ---------------------------------------------------------------------------

export {
  BridgeError,
  type BridgeErrorCode,
  type BridgeErrorPayload,
} from "../errors.js";
import { BridgeError } from "../errors.js";

// ---------------------------------------------------------------------------
// Ack validation (electron-specific channel; not part of the shared RPC).
//
// [LAW:single-enforcer] Single trust boundary for the ack channel. Bad acks
// are dropped silently by main.ts — they can only starve the renderer that
// sent them, never reach tmux.
// ---------------------------------------------------------------------------

export function parseAckMessage(raw: unknown): AckMessage {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new BridgeError(
      "BRIDGE_INVALID_ARG",
      "ack must be a non-array object",
    );
  }
  const obj = raw as { paneId?: unknown; bytes?: unknown };
  if (
    typeof obj.paneId !== "number" ||
    !Number.isFinite(obj.paneId) ||
    obj.paneId < 0 ||
    !Number.isInteger(obj.paneId)
  ) {
    throw new BridgeError(
      "BRIDGE_INVALID_ARG",
      "ack.paneId must be a non-negative integer",
    );
  }
  if (
    typeof obj.bytes !== "number" ||
    !Number.isFinite(obj.bytes) ||
    obj.bytes < 0
  ) {
    throw new BridgeError(
      "BRIDGE_INVALID_ARG",
      "ack.bytes must be a non-negative finite number",
    );
  }
  return { paneId: obj.paneId, bytes: obj.bytes };
}
