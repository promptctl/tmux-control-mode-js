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

import type { EmitterMessage } from "../../emitter.js";
import type { CommandResponse, OutputMessage } from "../../protocol/types.js";
import type { BridgeErrorPayload as BridgeErrorPayloadType } from "../errors.js";
import type { ResumeFailure } from "../bridge-connection.js";
import type { RpcMethod, RpcRequest, RpcResponseMap } from "../rpc.js";

// ---------------------------------------------------------------------------
// IPC channel names. Defined once, imported by both sides.
// ---------------------------------------------------------------------------

export const IPC = {
  /** main → renderer: every `IpcEventMessage` — client events and pane bytes. */
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

/** The channels a renderer sends main on with `ipcRenderer.send`. */
export type RendererSendChannel =
  | typeof IPC.register
  | typeof IPC.unregister
  | typeof IPC.ack;

/**
 * What main sends a renderer on `IPC.event`: an event of the main-side client
 * (`client.on("*")`, plus the connection-state snapshot a late joiner gets) or
 * a pane's output bytes from the renderer's `BytesSink`, which sends tmux's
 * `%output` and `%extended-output` alike as `output`.
 *
 * [LAW:types-are-the-program] The channel's payload is declared once, here,
 * and both ends are typed against it: `WebContentsLike.send` checks every
 * producer, `IpcRendererOnListener` hands the renderer the union with no cast.
 */
export type IpcEventMessage = EmitterMessage | OutputMessage;

// ---------------------------------------------------------------------------
// Structural "like" interfaces for Electron.
//
// [LAW:locality-or-seam] These structural interfaces keep `electron` out of
// the library's runtime dependencies. Each method takes only the channels its
// side uses, with that channel's arguments, so a wrong channel or payload at
// the call site is a compile error.
//
// [LAW:one-type-per-behavior] `on` and `removeListener` use the SAME listener
// shape so a registered handler can be passed verbatim to removeListener
// without a cast — the signature mismatch this used to have was variance
// leaking into every call site.
// ---------------------------------------------------------------------------

/**
 * A frame host (Electron's `WebFrameMain`), by the ids that name it. A
 * frame's document lives in one render frame host; a navigation that swaps
 * hosts gives the frame a new `routingId` (never reused within a process) or
 * a new process.
 */
export interface WebFrameLike {
  readonly processId: number;
  readonly routingId: number;
}

/**
 * The WebContents events after which the page it showed is gone: the
 * WebContents itself destroyed, its main frame committed to a new document
 * (a reload or navigation — same-document navigations fire
 * `did-navigate-in-page` instead), or its renderer process crashed.
 */
export const PAGE_END_EVENTS = [
  "destroyed",
  "did-navigate",
  "render-process-gone",
] as const;
export type PageEndEvent = (typeof PAGE_END_EVENTS)[number];

/**
 * A load in the WebContents failed. A failed main-frame load that commits an
 * error page swaps the frame host and fires this instead of `did-navigate`;
 * a failure that commits nothing (an aborted navigation) leaves the page
 * shown.
 */
export type LoadFailedEvent = "did-fail-load";

export interface WebContentsLike {
  /** `IPC.event` is the one channel main sends a renderer on. */
  send(channel: typeof IPC.event, msg: IpcEventMessage): void;
  /**
   * The frame host of the page this WebContents shows. After `destroy()` it
   * still reads the last host; before Electron 34, reading it after a
   * renderer crash throws until a new document commits.
   */
  readonly mainFrame: WebFrameLike;
  once(event: PageEndEvent, listener: () => void): void;
  on(event: LoadFailedEvent, listener: () => void): void;
  /**
   * Required so the bridge can detach its page listeners when a sender is
   * torn down via `unregister` while the page is still alive. Without this
   * a listener stays attached to the emitter for the WebContents's remaining
   * lifetime and fires later against a page that never registered.
   */
  removeListener(
    event: PageEndEvent | LoadFailedEvent,
    listener: () => void,
  ): void;
  isDestroyed(): boolean;
  isCrashed(): boolean;
}

/** An IPC message as ipcMain receives it: the WebContents and the frame host
 *  (`processId`, `frameId` = the host's `routingId`) that sent it. */
export interface IpcMainEventLike {
  readonly sender: WebContentsLike;
  readonly processId: number;
  readonly frameId: number;
}

export type IpcMainOnListener = (
  event: IpcMainEventLike,
  ...args: unknown[]
) => void;

/** Main answers every `IPC.invoke` with an envelope, whatever the renderer sent. */
export type IpcMainInvokeListener = (
  event: IpcMainEventLike,
  ...args: unknown[]
) => Promise<InvokeResultEnvelope>;

export interface IpcMainLike {
  /** `IPC.invoke` is the one channel main handles. */
  handle(channel: typeof IPC.invoke, listener: IpcMainInvokeListener): void;
  removeHandler(channel: typeof IPC.invoke): void;
  /** The channels a renderer sends main on; main parses what arrives. */
  on(channel: RendererSendChannel, listener: IpcMainOnListener): void;
  removeListener(
    channel: RendererSendChannel,
    listener: IpcMainOnListener,
  ): void;
}

// [LAW:types-are-the-program] No fields required from the renderer event —
// the bridge is a 1:1 pairing with a single ipcRenderer and origin is known
// by construction. If a future feature needs to validate event origin, narrow
// this type or replace with IpcRendererLike.
export type IpcRendererEventLike = object;

export type IpcRendererOnListener = (
  event: IpcRendererEventLike,
  msg: IpcEventMessage,
) => void;

export interface IpcRendererLike {
  invoke(
    channel: typeof IPC.invoke,
    req: InvokeRequest,
  ): Promise<InvokeResultEnvelope>;
  // A renderer's own sends are typed per channel; main still parses what
  // arrives (`parseAckMessage`), since a renderer is untrusted.
  send(channel: typeof IPC.register | typeof IPC.unregister): void;
  send(channel: typeof IPC.ack, ack: AckMessage): void;
  /** `IPC.event` is the one channel a renderer listens on. */
  on(channel: typeof IPC.event, listener: IpcRendererOnListener): void;
  removeListener(
    channel: typeof IPC.event,
    listener: IpcRendererOnListener,
  ): void;
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
//
// [LAW:no-ambient-temporal-coupling] Electron returns an invoke's reply apart
// from the `IPC.event` messages main sent the page before it, and can deliver
// it first. `eventsBefore` is how many `IPC.event` messages main had sent the
// page when it returned the reply; the renderer settles the reply only once it
// has delivered that many, so a reply follows every event tmux wrote ahead of
// it (a command's `%begin`, the pane bytes before it), as on every connector.
// ---------------------------------------------------------------------------

/** What an invoke came to: the outcome half of `InvokeResultEnvelope`. */
export type InvokeResult =
  // RpcResponseMap[RpcMethod]: a CommandResponse for most methods, but the
  // structured records for listWindows/listPanes/listSessions (see rpc.ts).
  | { readonly status: "ok"; readonly response: RpcResponseMap[RpcMethod] }
  | { readonly status: "tmux-error"; readonly response: CommandResponse }
  | {
      readonly status: "bridge-error";
      readonly error: BridgeErrorPayloadType;
    };

export type InvokeResultEnvelope = InvokeResult & {
  readonly eventsBefore: number;
};

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
  /**
   * Observe a resume (Continue) that a live tmux refused, leaving a pane
   * stranded paused while the watermark loop wanted it flowing. The bridge
   * still retries on the next watermark crossing; this hook is the observable
   * signal that replaces the old silent swallow. [LAW:no-silent-failure]
   *
   * Opt-in, like the WebSocket server's `onEvent`: a main process that does
   * not set it does not observe these failures. The failure is never dropped
   * inside the bridge — the choice to look lives with the host.
   */
  readonly onResumeFailure?: (failure: ResumeFailure) => void;
  /**
   * Observe a departed renderer's cross-session layout release that a live
   * tmux refused. Opt-in, like `onResumeFailure`. [LAW:no-silent-failure]
   */
  readonly onCoverageReleaseFailure?: (error: BridgeError) => void;
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
// A main-process consumer wiring `onResumeFailure` names this type; re-export
// it here so `./types` stays the single import site.
export type { ResumeFailure } from "../bridge-connection.js";

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
