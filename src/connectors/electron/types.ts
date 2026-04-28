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
// Renderer → main: output-byte ack frame.
// ---------------------------------------------------------------------------

export interface AckMessage {
  readonly paneId: number;
  readonly bytes: number;
}

// ---------------------------------------------------------------------------
// Main-bridge lifecycle handle.
// ---------------------------------------------------------------------------

export interface MainBridgeHandle {
  /**
   * Remove all IPC handlers installed by createMainBridge and clear the
   * internal subscriber set. Does NOT close the underlying TmuxClient — the
   * host owns that lifecycle.
   */
  dispose(): void;
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

export const DEFAULT_OUTPUT_HIGH_WATERMARK = 1 << 20;
export const DEFAULT_OUTPUT_LOW_WATERMARK = 1 << 18;

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
   * proxy rejects with `BridgeError("TIMEOUT")` if the underlying
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
// RPC-validation failures (INVALID_REQUEST / UNKNOWN_METHOD / INVALID_ARG)
// throw RpcError from ../rpc.ts. BridgeError below is reserved for
// electron-specific failures: the single-instance enforcement guard and
// invalid bridge-option configuration.
// ---------------------------------------------------------------------------

export type BridgeErrorCode =
  /** createMainBridge called twice on the same ipcMain. */
  | "ALREADY_REGISTERED"
  /** Invalid MainBridgeOptions (e.g. high-watermark not greater than low). */
  | "INVALID_ARG"
  /** Dispatch was abandoned because its sender was destroyed mid-flight. */
  | "ABORTED"
  /** Renderer attempted to unsubscribe a name it does not own. */
  | "UNKNOWN_SUBSCRIPTION"
  /** Renderer-side invoke exceeded RendererBridgeOptions.invokeTimeoutMs. */
  | "TIMEOUT";

export class BridgeError extends Error {
  readonly code: BridgeErrorCode;
  constructor(code: BridgeErrorCode, message: string) {
    super(`[${code}] ${message}`);
    this.name = "BridgeError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Ack validation (electron-specific channel; not part of the shared RPC).
//
// [LAW:single-enforcer] Single trust boundary for the ack channel. Bad acks
// are dropped silently by main.ts — they can only starve the renderer that
// sent them, never reach tmux.
// ---------------------------------------------------------------------------

export function parseAckMessage(raw: unknown): AckMessage {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new BridgeError("INVALID_ARG", "ack must be a non-array object");
  }
  const obj = raw as { paneId?: unknown; bytes?: unknown };
  if (typeof obj.paneId !== "number" || !Number.isFinite(obj.paneId)) {
    throw new BridgeError("INVALID_ARG", "ack.paneId must be a finite number");
  }
  if (
    typeof obj.bytes !== "number" ||
    !Number.isFinite(obj.bytes) ||
    obj.bytes < 0
  ) {
    throw new BridgeError(
      "INVALID_ARG",
      "ack.bytes must be a non-negative finite number",
    );
  }
  return { paneId: obj.paneId, bytes: obj.bytes };
}
