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
// Structural "like" interfaces for Electron.
// ---------------------------------------------------------------------------

export interface WebContentsLike {
  send(channel: string, ...args: unknown[]): void;
  once(event: "destroyed", listener: () => void): void;
  isDestroyed(): boolean;
}

export interface IpcMainInvokeEventLike {
  readonly sender: WebContentsLike;
}

export interface IpcMainEventLike {
  readonly sender: WebContentsLike;
}

export interface IpcMainLike {
  handle(
    channel: string,
    listener: (
      event: IpcMainInvokeEventLike,
      ...args: unknown[]
    ) => unknown | Promise<unknown>,
  ): void;
  removeHandler(channel: string): void;
  on(
    channel: string,
    listener: (event: IpcMainEventLike, ...args: unknown[]) => void,
  ): void;
  removeListener(
    channel: string,
    listener: (...args: unknown[]) => void,
  ): void;
}

export interface IpcRendererEventLike {
  readonly sender?: unknown;
}

export interface IpcRendererLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  send(channel: string, ...args: unknown[]): void;
  on(
    channel: string,
    listener: (event: IpcRendererEventLike, ...args: unknown[]) => void,
  ): void;
  removeListener(
    channel: string,
    listener: (...args: unknown[]) => void,
  ): void;
}

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
  | "INVALID_ARG";

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
