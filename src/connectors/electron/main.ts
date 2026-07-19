// src/connectors/electron/main.ts
// Electron main-process bridge: forwards TmuxClient events to registered
// renderers and routes renderer command invocations to the client.
//
// This file is the wiring shell. The three concerns it used to fuse now live
// in dedicated collaborators, mirroring the websocket/ split:
//   - SenderRegistry (./sender-registry.ts) — the set of registered renderers,
//     their per-sender lifecycle, per-renderer byte forwarding, and event
//     fan-out.
//   - InvokePipeline (./invoke-pipeline.ts) — renderer command invocation
//     (parse → dispatch → encode), abort-on-teardown, and drain.
//   - WebContentsSink (./sink.ts) — the one BytesSink for the Electron main
//     transport (mirrors websocket/sink.ts).
//
// Everything here is electron-specific: the single-instance ipcMain guard, the
// ipcMain listener installation, the forwarding policy at the client-event
// seam, and the returned handle's dispose/drain. The transport-agnostic
// bookkeeping — subscription ownership/refcount, per-peer outstanding-byte
// accounting, the watermark loop that drives setPaneAction(Pause/Continue) —
// lives in `../bridge-connection.ts` and is shared with the WebSocket bridge.
// RPC validation, dispatch, and method allowlist live in `../rpc.ts`.
//
// [LAW:single-enforcer] One ipcMain.handle("tmux:invoke") per process; the
// invoke pipeline delegates parsing+dispatching to ../rpc, with subscription
// RPCs intercepted at the bridge boundary so the shared `BridgeConnection`
// helper enforces refcount + ownership in exactly one place.
// [LAW:one-source-of-truth] IPC channel names from ./types.js; RPC behavior
// from ../rpc.js; subscription/refcount/watermark from ../bridge-connection.js.

import type { TmuxClient } from "../../client.js";
import type { EmitterMessage } from "../../emitter.js";
import {
  createBridgeConnection,
  type BridgeConnection,
} from "../bridge-connection.js";
import {
  BridgeError,
  IPC,
  type IpcMainEventLike,
  type IpcMainLike,
  type IpcMainOnListener,
  type MainBridgeHandle,
  type MainBridgeOptions,
} from "./types.js";
import { SenderRegistry } from "./sender-registry.js";
import { InvokePipeline } from "./invoke-pipeline.js";

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
 *   - Every `client` event is forwarded to every subscribed renderer via
 *     `webContents.send(IPC.event, msg)`. `Uint8Array` payloads ride
 *     Electron's native structured-clone IPC — no base64 hop needed.
 *
 * Method dispatch:
 *   - `ipcMain.handle(IPC.invoke, ...)` validates the renderer payload via
 *     `parseRpcRequest` (allowlist + per-method arg shape check) before
 *     dispatching via `dispatchBridgeRequest`. A compromised renderer cannot
 *     reach an unknown TmuxClient method or trigger a prototype-chain lookup.
 *   - Subscribe / unsubscribe are intercepted at the bridge boundary and
 *     routed through the shared `BridgeConnection` helper, which holds the
 *     refcount and ownership map.
 *
 * Backpressure:
 *   - For every `%output` / `%extended-output` byte forwarded, the helper
 *     accounts it as outstanding for that (renderer, pane) pair. When the
 *     per-pane total crosses `outputHighWatermark`, the helper calls
 *     `client.setPaneAction(paneId, Pause)`; the renderer's `tmux:ack` drops
 *     the total below `outputLowWatermark` and the helper resumes the pane.
 *
 * Renderer death:
 *   - `webContents.once("destroyed", ...)` drives `SenderRegistry.teardown`
 *     once per sender, which flags in-flight invokes aborted (via the invoke
 *     pipeline), detaches the byte forwarder, and `bridge.removePeer`s.
 *
 * Returns a handle whose `dispose()` removes every installed IPC handler,
 * tears down every sender, calls `bridge.dispose()`, and frees the ipcMain for
 * a subsequent createMainBridge. The caller still owns `client.close()`.
 */
export function createMainBridge(
  client: TmuxClient,
  ipcMain: IpcMainLike,
  options: MainBridgeOptions = {},
): MainBridgeHandle {
  if (REGISTERED_IPC_MAINS.has(ipcMain)) {
    throw new BridgeError(
      "BRIDGE_ALREADY_REGISTERED",
      "createMainBridge has already been called on this ipcMain. Register " +
        "the bridge once at app.whenReady() rather than per BrowserWindow — " +
        "ipcMain is a process singleton.",
    );
  }
  REGISTERED_IPC_MAINS.add(ipcMain);

  // [LAW:single-enforcer] Watermark validation lives inside
  // createBridgeConnection. A bad config throws BridgeError("BRIDGE_INVALID_ARG")
  // here too (one error shape across both transports). On failure we have to
  // release the ipcMain registration we just claimed so a corrected retry can
  // install cleanly — the throw aborts construction otherwise.
  let bridge: BridgeConnection;
  try {
    bridge = createBridgeConnection({
      client,
      outputHighWatermark: options.outputHighWatermark,
      outputLowWatermark: options.outputLowWatermark,
      // [LAW:effects-at-boundaries] The bridge DESCRIBES a stranded resume;
      // main PERFORMS the surfacing through the host's opt-in hook. Undefined
      // means the host chose not to observe — the bridge never swallows it.
      reportResumeFailure: (f) => options.onResumeFailure?.(f),
    });
  } catch (err) {
    REGISTERED_IPC_MAINS.delete(ipcMain);
    throw err;
  }

  // -------------------------------------------------------------------------
  // Collaborators. The dependency runs one way: the invoke pipeline resolves a
  // sender's peer through the registry (`getOrCreate`), and the registry flags
  // that sender's in-flight dispatches aborted on teardown — both act on the
  // single per-sender record, so there is no back-reference to wire.
  // [LAW:one-way-deps]
  // -------------------------------------------------------------------------
  const registry = new SenderRegistry({ bridge, client });
  const invokePipeline = new InvokePipeline({ bridge, client, registry });

  // -------------------------------------------------------------------------
  // Forwarding policy at the client-event seam.
  //
  // [LAW:one-source-of-truth] `topology-error` is per-router-instance: the
  //   renderer proxy owns its own TopologyRouter (it routes the renderer's
  //   sinks and reports its own bootstrap failures), so forwarding the main
  //   client's topology-error would give a renderer consumer a second,
  //   differently-sourced signal about a topology table it does not route
  //   against. Each client instance is the sole source of its own topology-
  //   bootstrap signal; this one event does not cross the bridge. Other
  //   synthetic events (connection-state, reconnected) DO forward — they
  //   reflect the shared connection, not a per-router bootstrap.
  //
  // `EmitterMessage` excludes `PaneOutputMessage`, so this forwarder cannot
  // receive bytes — the type system enforces it. Byte chunks route through each
  // renderer's per-peer sink (attached in SenderRegistry.register), not here.
  const forwardEvent = (msg: EmitterMessage): void => {
    if (msg.type === "topology-error") return;
    registry.broadcast(msg);
  };
  client.on("*", forwardEvent);

  // -------------------------------------------------------------------------
  // ipcMain listener installation.
  //
  // [LAW:locality-or-seam] IpcMainOnListener — the registered listener shape —
  // is the SAME for `on` and `removeListener`, so the same named reference
  // passed to `on` is the one passed to `removeListener` in dispose(). No cast
  // at either site means a refactor cannot silently make dispose() a no-op.
  // -------------------------------------------------------------------------
  const onRegisterListener: IpcMainOnListener = (event: IpcMainEventLike) =>
    registry.register(event.sender);
  const onUnregisterListener: IpcMainOnListener = (event: IpcMainEventLike) =>
    registry.teardown(event.sender);
  const onAckListener: IpcMainOnListener = (
    event: IpcMainEventLike,
    ...args: unknown[]
  ) => registry.ack(event.sender, args[0]);

  ipcMain.on(IPC.register, onRegisterListener);
  ipcMain.on(IPC.unregister, onUnregisterListener);
  ipcMain.on(IPC.ack, onAckListener);
  ipcMain.handle(IPC.invoke, invokePipeline.handle);

  return {
    dispose() {
      client.off("*", forwardEvent);
      ipcMain.removeListener(IPC.register, onRegisterListener);
      ipcMain.removeListener(IPC.unregister, onUnregisterListener);
      ipcMain.removeListener(IPC.ack, onAckListener);
      ipcMain.removeHandler(IPC.invoke);
      // Tear down every sender through the unified path: aborts in-flight
      // dispatches, removes destroyed listeners from still-alive wcs (so
      // dispose doesn't leak handlers across bridge re-installations), and
      // calls bridge.removePeer for each. Then bridge.dispose() flushes any
      // residual pause state and unsubscribes any names the bridge created but
      // no peer was holding (defense in depth — teardown should have taken care
      // of all of them).
      registry.teardownAll();
      bridge.dispose();
      REGISTERED_IPC_MAINS.delete(ipcMain);
    },
    drain(timeoutMs?: number): Promise<void> {
      return invokePipeline.drain(timeoutMs);
    },
  };
}

// Re-export the Electron byte forwarder from its own module so a main-process
// consumer keeps a single import site (`./electron/main`). [LAW:one-source-of-truth]
export { WebContentsSink, attachWebContentsSink } from "./sink.js";

// Re-export the types a main-process consumer might need without forcing a
// second import site.
export type {
  BridgeErrorCode,
  BridgeErrorPayload,
  IpcMainLike,
  MainBridgeHandle,
  MainBridgeOptions,
  ResumeFailure,
  WebContentsLike,
} from "./types.js";
export { BridgeError } from "./types.js";
