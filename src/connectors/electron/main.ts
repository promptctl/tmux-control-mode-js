// src/connectors/electron/main.ts
// Electron main-process bridge: forwards TmuxClient events to registered
// renderers and routes renderer command invocations to the client.
//
// This file owns ONLY what is electron-specific:
//   - Single-instance enforcement on the ipcMain singleton.
//   - The renderer subscriber set + per-renderer per-pane outstanding-byte
//     accounting + watermark-driven setPaneAction(Pause/Continue) loop.
//   - Forwarding TmuxClient events as Electron IPC messages.
//
// RPC validation, dispatch, and method allowlist all live in
// `../rpc.ts`. Adding a TmuxClient method = one file edit.
//
// [LAW:single-enforcer] One ipcMain.handle("tmux:invoke") per process; the
// invoke handler delegates parsing+dispatching to ../rpc.
// [LAW:one-source-of-truth] IPC channel names from ./types.js; RPC behavior
// from ../rpc.js. No duplication of either on this side.

import type { TmuxClient } from "../../client.js";
import { TmuxCommandError } from "../../errors.js";
import {
  PaneAction,
  type TmuxMessage,
} from "../../protocol/types.js";
import { parseRpcRequest } from "../rpc.js";
import { dispatchRpcRequest } from "../rpc-dispatch.js";
import {
  BridgeError,
  DEFAULT_OUTPUT_HIGH_WATERMARK,
  DEFAULT_OUTPUT_LOW_WATERMARK,
  IPC,
  parseAckMessage,
  type IpcMainEventLike,
  type IpcMainLike,
  type MainBridgeHandle,
  type MainBridgeOptions,
  type WebContentsLike,
} from "./types.js";

// ---------------------------------------------------------------------------
// Single-instance ipcMain registration tracking.
//
// [LAW:single-enforcer] Real Electron's ipcMain.handle throws on a second
// registration for the same channel. The library detects and refuses this up
// front so callers get a clear error at the wrong call site (the duplicate
// createMainBridge), not a cryptic Electron throw on the next renderer call.
// ---------------------------------------------------------------------------

const REGISTERED_IPC_MAINS = new WeakSet<IpcMainLike>();

// ---------------------------------------------------------------------------
// createMainBridge
// ---------------------------------------------------------------------------

interface SubscriberState {
  readonly wc: WebContentsLike;
  /** Per-pane bytes sent to this renderer but not yet acknowledged. */
  readonly outstanding: Map<number, number>;
}

/**
 * Bridge a TmuxClient into Electron's IPC system.
 *
 * Lifecycle:
 *   - Install the bridge ONCE per process at app.whenReady() — `ipcMain` is a
 *     singleton, and a per-window registration would crash on the second
 *     window with "Attempted to register a second handler for tmux:invoke".
 *   - Renderers register themselves on `tmux:register` (the renderer bridge
 *     does this in its constructor).
 *
 * Event forwarding:
 *   - Every `client` event is forwarded to every registered renderer via
 *     `webContents.send(IPC.event, msg)`. `Uint8Array` payloads ride
 *     Electron's native structured-clone IPC — no base64 hop needed.
 *
 * Method dispatch:
 *   - `ipcMain.handle(IPC.invoke, ...)` validates the renderer payload via
 *     `parseRpcRequest` (allowlist + per-method arg shape check) before
 *     dispatching via `dispatchRpcRequest`. A compromised renderer cannot
 *     reach an unknown TmuxClient method or trigger a prototype-chain lookup.
 *
 * Backpressure:
 *   - For every `%output` / `%extended-output` byte forwarded, main accounts
 *     it as outstanding for that (renderer, pane) pair. When the per-pane
 *     total (summed across renderers) crosses `outputHighWatermark`, main
 *     calls `client.setPaneAction(paneId, Pause)`. When the renderer
 *     replies with `tmux:ack` (paneId, bytes consumed) and the total falls
 *     below `outputLowWatermark`, main resumes the pane.
 *
 * Returns a handle whose `dispose()` removes every installed IPC handler,
 * resumes any panes the bridge had paused, and frees the ipcMain for a
 * subsequent createMainBridge. The caller still owns `client.close()`.
 */
export function createMainBridge(
  client: TmuxClient,
  ipcMain: IpcMainLike,
  options: MainBridgeOptions = {},
): MainBridgeHandle {
  if (REGISTERED_IPC_MAINS.has(ipcMain)) {
    throw new BridgeError(
      "ALREADY_REGISTERED",
      "createMainBridge has already been called on this ipcMain. Register " +
        "the bridge once at app.whenReady() rather than per BrowserWindow — " +
        "ipcMain is a process singleton.",
    );
  }
  REGISTERED_IPC_MAINS.add(ipcMain);

  const high = options.outputHighWatermark ?? DEFAULT_OUTPUT_HIGH_WATERMARK;
  const low = options.outputLowWatermark ?? DEFAULT_OUTPUT_LOW_WATERMARK;
  if (!(high > low && low >= 0)) {
    REGISTERED_IPC_MAINS.delete(ipcMain);
    throw new BridgeError(
      "INVALID_ARG",
      `outputHighWatermark (${high}) must be > outputLowWatermark (${low}) >= 0`,
    );
  }

  const subscribers = new Map<WebContentsLike, SubscriberState>();
  const pausedPanes = new Set<number>();

  // -------------------------------------------------------------------------
  // Backpressure helpers.
  //
  // [LAW:dataflow-not-control-flow] Pause/resume decisions are pure functions
  // of the outstanding-bytes map; the same pause/resume operation runs on
  // every accounting tick — only the data (the per-pane sum) decides whether
  // setPaneAction fires.
  // -------------------------------------------------------------------------

  const totalOutstanding = (paneId: number): number => {
    let sum = 0;
    for (const s of subscribers.values()) {
      sum += s.outstanding.get(paneId) ?? 0;
    }
    return sum;
  };

  // Fire-and-forget pause/continue. tmux's response carries no actionable
  // info; a rejection means the pane already went away, which is fine.
  const swallow = (): void => undefined;
  const maybePause = (paneId: number): void => {
    if (pausedPanes.has(paneId)) return;
    if (totalOutstanding(paneId) < high) return;
    pausedPanes.add(paneId);
    void client.setPaneAction(paneId, PaneAction.Pause).catch(swallow);
  };

  const maybeResume = (paneId: number): void => {
    if (!pausedPanes.has(paneId)) return;
    if (totalOutstanding(paneId) > low) return;
    pausedPanes.delete(paneId);
    void client.setPaneAction(paneId, PaneAction.Continue).catch(swallow);
  };

  // -------------------------------------------------------------------------
  // Event forwarding.
  // -------------------------------------------------------------------------

  const forward = (msg: TmuxMessage): void => {
    const accounted = byteAccount(msg);
    // [LAW:dataflow-not-control-flow] One send per subscriber, every message,
    // unconditionally. The set being empty means zero iterations — data decides.
    for (const [wc, state] of subscribers) {
      // [LAW:no-defensive-null-guards] isDestroyed is a trust-boundary check:
      // Electron may fire "destroyed" asynchronously, so a send could race a
      // teardown. Guarding here avoids a native crash inside wc.send.
      if (wc.isDestroyed()) {
        dropSubscriber(wc);
        continue;
      }
      // Account output bytes per (renderer, pane) BEFORE wc.send so that an
      // ack arriving synchronously during send subtracts from the right
      // baseline. Non-output messages produce null accounting.
      if (accounted !== null) {
        const prev = state.outstanding.get(accounted.paneId) ?? 0;
        state.outstanding.set(accounted.paneId, prev + accounted.bytes);
      }
      wc.send(IPC.event, msg);
    }
    if (accounted !== null) maybePause(accounted.paneId);
  };

  client.on("*", forward);

  // -------------------------------------------------------------------------
  // Subscribe / unsubscribe / ack.
  // -------------------------------------------------------------------------

  const dropSubscriber = (wc: WebContentsLike): void => {
    const state = subscribers.get(wc);
    if (state === undefined) return;
    subscribers.delete(wc);
    // The renderer is gone; its share of outstanding bytes evaporates. Try to
    // resume any panes that were paused only because of this renderer's lag.
    for (const paneId of state.outstanding.keys()) maybeResume(paneId);
  };

  const onRegister = (event: IpcMainEventLike): void => {
    const wc = event.sender;
    if (subscribers.has(wc)) return;
    subscribers.set(wc, { wc, outstanding: new Map() });
    wc.once("destroyed", () => dropSubscriber(wc));
  };

  const onUnregister = (event: IpcMainEventLike): void => {
    dropSubscriber(event.sender);
  };

  const onAck = (event: IpcMainEventLike, ...args: unknown[]): void => {
    const state = subscribers.get(event.sender);
    if (state === undefined) return;
    // [LAW:single-enforcer] Validation happens at the IPC trust boundary.
    // Bad acks from a compromised renderer are dropped silently — they can
    // only starve the renderer that sent them, never reach tmux.
    const ack = (() => {
      try {
        return parseAckMessage(args[0]);
      } catch {
        return null;
      }
    })();
    if (ack === null) return;
    const prev = state.outstanding.get(ack.paneId) ?? 0;
    const next = Math.max(0, prev - ack.bytes);
    if (next === 0) state.outstanding.delete(ack.paneId);
    else state.outstanding.set(ack.paneId, next);
    maybeResume(ack.paneId);
  };

  ipcMain.on(IPC.register, onRegister as (...args: unknown[]) => void);
  ipcMain.on(IPC.unregister, onUnregister as (...args: unknown[]) => void);
  ipcMain.on(IPC.ack, onAck as (...args: unknown[]) => void);

  // -------------------------------------------------------------------------
  // Single invoke handler — straight pipe through the shared RPC layer.
  //
  // [LAW:single-enforcer] One handler. parseRpcRequest enforces the shape;
  // dispatchRpcRequest performs the typed dispatch. No control flow lives
  // here — the variance is absorbed by RpcRequest.
  // -------------------------------------------------------------------------

  const invokeHandler = async (
    _event: unknown,
    ...args: unknown[]
  ): Promise<unknown> => {
    // parseRpcRequest throws RpcError on bad input. Letting the throw
    // propagate makes ipcRenderer.invoke reject in the renderer with the
    // bridge error message — no execution happens.
    const req = parseRpcRequest(args[0]);
    // Wrap the dispatch result in a small envelope so TmuxCommandError can
    // cross IPC: real Electron's `ipcMain.handle` serializes `Error`
    // rejections as opaque messages and drops their custom properties (e.g.
    // `.response`). Returning a plain object preserves the structured
    // CommandResponse end-to-end. The renderer's `invoke()` re-throws as a
    // TmuxCommandError so `proxy.execute()` keeps the same contract as
    // `client.execute()`.
    try {
      const response = await dispatchRpcRequest(client, req);
      return { ok: true as const, response };
    } catch (err) {
      if (err instanceof TmuxCommandError) {
        return { ok: false as const, response: err.response };
      }
      throw err;
    }
  };

  ipcMain.handle(IPC.invoke, invokeHandler);

  return {
    dispose() {
      client.off("*", forward);
      ipcMain.removeListener(
        IPC.register,
        onRegister as (...args: unknown[]) => void,
      );
      ipcMain.removeListener(
        IPC.unregister,
        onUnregister as (...args: unknown[]) => void,
      );
      ipcMain.removeListener(
        IPC.ack,
        onAck as (...args: unknown[]) => void,
      );
      ipcMain.removeHandler(IPC.invoke);
      // Resume any panes we paused so we don't leave tmux stuck after teardown.
      for (const paneId of pausedPanes) {
        void client.setPaneAction(paneId, PaneAction.Continue).catch(swallow);
      }
      pausedPanes.clear();
      subscribers.clear();
      REGISTERED_IPC_MAINS.delete(ipcMain);
    },
  };
}

// [LAW:dataflow-not-control-flow] Discriminator-driven extraction: every
// message goes through here, output-shaped ones produce a record, others
// produce null. The caller's loop runs the same path each time.
function byteAccount(
  msg: TmuxMessage,
): { paneId: number; bytes: number } | null {
  if (msg.type === "output" || msg.type === "extended-output") {
    return { paneId: msg.paneId, bytes: msg.data.byteLength };
  }
  return null;
}

// Re-export the types a main-process consumer might need without forcing a
// second import site.
export type {
  IpcMainLike,
  MainBridgeHandle,
  MainBridgeOptions,
  WebContentsLike,
} from "./types.js";
export { BridgeError } from "./types.js";
