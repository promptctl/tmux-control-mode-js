// src/connectors/electron/main.ts
// Electron main-process bridge: forwards TmuxClient events to registered
// renderers and routes renderer command invocations to the client.
//
// This file owns ONLY what is electron-specific:
//   - Single-instance enforcement on the ipcMain singleton.
//   - Per-sender IPC-side wiring (one unified SenderState per renderer with
//     the destroyed-listener handle, in-flight invoke set, isSubscribed flag).
//   - Forwarding TmuxClient events as Electron IPC messages.
//   - Ack-frame parsing (an electron-specific channel; not part of the
//     transport-agnostic RPC).
//   - Envelope-shaped invoke replies (real Electron's IPC serializer drops
//     subclass props on rejected Errors, so every outcome rides the
//     `InvokeResultEnvelope` discriminated union).
//
// All the bookkeeping that is NOT electron-specific — subscription
// ownership/refcount, per-peer per-pane outstanding-byte accounting, the
// watermark loop that drives `setPaneAction(Pause/Continue)` — lives in
// `../bridge-connection.ts` and is shared with the WebSocket bridge.
//
// RPC validation, dispatch, and method allowlist all live in `../rpc.ts`.
// Adding a TmuxClient method = one file edit.
//
// [LAW:single-enforcer] One ipcMain.handle("tmux:invoke") per process; the
// invoke handler delegates parsing+dispatching to ../rpc, with subscription
// RPCs intercepted at the bridge boundary so the shared `BridgeConnection`
// helper enforces refcount + ownership in exactly one place.
// [LAW:one-source-of-truth] One SenderState entry per renderer, and one
// `Peer` token per renderer registered with the helper; teardownSender is
// the only path that releases both.
// [LAW:one-source-of-truth] IPC channel names from ./types.js; RPC behavior
// from ../rpc.js; subscription/refcount/watermark from ../bridge-connection.js.

import type { TmuxConnection } from "../../client.js";
import type { TmuxClient } from "../../client.js";
import type { EmitterMessage } from "../../emitter.js";
import { TmuxCommandError } from "../../errors.js";
import {
  serverScope,
  type AttachOptions,
  type BytesSink,
  type ChunkPayload,
} from "../../pane-output.js";
import type {
  CommandResponse,
  PaneOutputMessage,
} from "../../protocol/types.js";
import {
  mapRpcCode,
  parseRpcRequest,
  RpcError,
  type RpcRequest,
} from "../rpc.js";
import { dispatchRpcRequest } from "../rpc-dispatch.js";
import {
  createBridgeConnection,
  type BridgeConnection,
  type Peer,
} from "../bridge-connection.js";
import {
  BridgeError,
  IPC,
  parseAckMessage,
  type InvokeResultEnvelope,
  type IpcMainEventLike,
  type IpcMainInvokeEventLike,
  type IpcMainLike,
  type IpcMainOnListener,
  type MainBridgeHandle,
  type MainBridgeOptions,
  type WebContentsLike,
} from "./types.js";

// ---------------------------------------------------------------------------
// RpcError → BridgeError mapping at the IPC trust boundary.
//
// [LAW:single-enforcer] RpcError is connector-internal; it is mapped to a
// `BridgeError` here so the wire taxonomy is unified across both transports.
// The taxonomy translation (mapRpcCode) is single-sourced in `../rpc.js`; this
// seam keeps only the Electron-specific envelope (the message-prefix strip).
// ---------------------------------------------------------------------------

function rpcErrorToBridge(err: RpcError): BridgeError {
  // RpcError prepends `[CODE] ` to its `.message`; the bridge code on the
  // BridgeError already supplies that prefix, so strip RpcError's first to
  // avoid double-prefixed messages like `[BRIDGE_INVALID_ARG] [INVALID_ARG] ...`.
  const stripped = err.message.replace(/^\[[A-Z_]+\] /, "");
  return new BridgeError(mapRpcCode(err.code), stripped);
}

function rpcErrorEnvelope(err: RpcError): InvokeResultEnvelope {
  return { status: "bridge-error", error: rpcErrorToBridge(err).toPayload() };
}

function abortedEnvelope(method: string): InvokeResultEnvelope {
  return {
    status: "bridge-error",
    error: new BridgeError(
      "BRIDGE_ABORTED",
      `dispatch for method=${method} aborted: sender destroyed`,
    ).toPayload(),
  };
}

function internalErrorEnvelope(
  method: string,
  err: unknown,
): InvokeResultEnvelope {
  const causeMsg = err instanceof Error ? err.message : String(err);
  const wrapped = new BridgeError(
    "BRIDGE_INTERNAL",
    `dispatch failed for method=${method}: ${causeMsg}`,
  );
  // [LAW:locality-or-seam] Preserve the original cause's stack so renderer
  // logs localize the failure to the function that actually threw — not
  // just to the bridge frame that wrapped it. Mirrors the pre-envelope
  // behavior where a thrown Error carried `wrapped.stack = ${own}\nCaused
  // by: ${cause}`.
  if (err instanceof Error && err.stack !== undefined) {
    const own = wrapped.stack ?? wrapped.message;
    wrapped.stack = `${own}\nCaused by: ${err.stack}`;
  }
  return { status: "bridge-error", error: wrapped.toPayload() };
}

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
// Per-sender state.
//
// Subscription ownership, refcount, and outstanding-byte accounting all live
// inside the shared BridgeConnection helper, keyed by the `peer` token below.
// SenderState carries only what is electron-specific: the WebContents, the
// destroyed-listener handle, the in-flight invoke set, and the isSubscribed
// flag that gates event forwarding.
// ---------------------------------------------------------------------------

interface PendingDispatch {
  /**
   * Set true when the sender's WebContents is destroyed (or unregisters)
   * while this dispatch's await is in-flight. The TmuxClient FIFO is
   * intentionally NOT purged — the underlying %begin/%end pair still pops
   * the pending entry in order so subsequent dispatches stay correlated.
   * The post-await branch in invokeHandler observes `aborted` and returns
   * a `BRIDGE_ABORTED` envelope instead of trying to send a result to a
   * dead webContents.
   */
  aborted: boolean;
}

interface SenderState {
  readonly wc: WebContentsLike;
  /** Token returned by BridgeConnection.registerPeer — the Map key the helper
   *  uses internally for refcount + outstanding-byte accounting. */
  readonly peer: Peer;
  /** True once the renderer has sent IPC.register; toggled off by unregister. */
  isSubscribed: boolean;
  /** In-flight invoke dispatches owned by this sender. */
  readonly pending: Set<PendingDispatch>;
  /**
   * The exact `destroyed` listener registered with `wc.once`. Stored so
   * `teardownSender` can call `wc.removeListener` when teardown is driven
   * by `unregister` instead of by the WebContents actually being destroyed
   * — otherwise the once-handler stays attached on a still-alive emitter,
   * fires later (as a no-op against a sender that no longer exists), and
   * keeps a closure-reference path alive on the emitter for the rest of
   * the WebContents's lifetime.
   */
  readonly onDestroyed: () => void;
  /** Disposer for this renderer's per-peer byte forwarder sink. Null before
   * the first IPC.register call; set once and cleared on teardown. */
  detachBytes: (() => void) | null;
}

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
 *     dispatching via `dispatchRpcRequest`. A compromised renderer cannot
 *     reach an unknown TmuxClient method or trigger a prototype-chain lookup.
 *   - Subscribe / unsubscribe are intercepted at the bridge boundary and
 *     routed through the shared `BridgeConnection` helper, which holds the
 *     refcount and ownership map. A renderer attempting to unsubscribe a
 *     name it does not own is rejected with `BRIDGE_UNKNOWN_SUBSCRIPTION`;
 *     a divergent re-subscribe (existing name, different what/format) is
 *     rejected with `BRIDGE_SUBSCRIPTION_FORMAT_CONFLICT`.
 *
 * Backpressure:
 *   - For every `%output` / `%extended-output` byte forwarded, the helper
 *     accounts it as outstanding for that (renderer, pane) pair. When the
 *     per-pane total (summed across renderers) crosses
 *     `outputHighWatermark`, the helper calls
 *     `client.setPaneAction(paneId, Pause)`. When the renderer replies with
 *     `tmux:ack` and the total falls below `outputLowWatermark`, the helper
 *     resumes the pane.
 *
 * Renderer death:
 *   - `webContents.once("destroyed", ...)` fires `teardownSender` once per
 *     sender. That single path:
 *       (1) marks all in-flight invoke dispatches `aborted` so the await
 *           resolves but the result is discarded with a BridgeError
 *           (the TmuxClient FIFO stays intact — no purge → no desync);
 *       (2) calls `bridge.removePeer(peer)` which drops outstanding-byte
 *           accounting (resuming any panes paused only because of this
 *           renderer's lag) and refcount-decrements every subscription this
 *           sender owned (firing `client.unsubscribe` on last drop).
 *
 * Returns a handle whose `dispose()` removes every installed IPC handler,
 * tears down every sender, calls `bridge.dispose()` (which resumes any panes
 * the bridge had paused and refcount-cleans every subscription the bridge
 * created), and frees the ipcMain for a subsequent createMainBridge. The
 * caller still owns `client.close()`.
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
    });
  } catch (err) {
    REGISTERED_IPC_MAINS.delete(ipcMain);
    throw err;
  }

  const senders = new Map<WebContentsLike, SenderState>();

  // -------------------------------------------------------------------------
  // Sender state lifecycle.
  // -------------------------------------------------------------------------

  const getOrCreateSender = (wc: WebContentsLike): SenderState => {
    const existing = senders.get(wc);
    if (existing !== undefined) return existing;
    // [LAW:single-enforcer] One destroyed-handler per sender. Attaching here
    // (not in onRegister) means a renderer that only ever invoke()s — never
    // register()s — still cleans up correctly when its webContents dies.
    // The handler is stored on the sender so teardownSender can detach it
    // when the unregister path runs and wc is still alive.
    const onDestroyed = (): void => teardownSender(wc);
    const peer = bridge.registerPeer();
    const state: SenderState = {
      wc,
      peer,
      isSubscribed: false,
      pending: new Set(),
      onDestroyed,
      detachBytes: null,
    };
    senders.set(wc, state);
    wc.once("destroyed", onDestroyed);
    return state;
  };

  const teardownSender = (wc: WebContentsLike): void => {
    const state = senders.get(wc);
    if (state === undefined) return;
    senders.delete(wc);

    // (0) Detach the destroyed handler. If we got here BECAUSE the wc was
    //     destroyed, removeListener is harmless (the listener has already
    //     fired and been removed by `once`). If we got here from unregister
    //     while the wc is still alive, this is the only thing that prevents
    //     a leaked listener on the emitter — see SenderState.onDestroyed.
    state.wc.removeListener("destroyed", state.onDestroyed);

    // (1) Mark in-flight invokes aborted. The TmuxClient FIFO stays intact —
    //     the underlying %begin/%end still resolves the pending entry in
    //     order — but the post-await branch in invokeHandler observes the
    //     aborted flag and returns a BRIDGE_ABORTED envelope instead of
    //     trying to deliver to a dead webContents.
    for (const p of state.pending) p.aborted = true;

    // (2) Detach the per-renderer byte forwarder so no further bytes are
    //     routed to this renderer's sink from the substrate.
    state.detachBytes?.();

    // (3) Drop helper-side accounting + subscription refcounts in one call.
    //     bridge.removePeer fires setPaneAction(Continue) for any pane this
    //     sender's outstanding bytes were keeping paused, and unsubscribes
    //     from tmux for any subscription this sender was the last owner of.
    bridge.removePeer(state.peer);
  };

  // -------------------------------------------------------------------------
  // Event forwarding.
  //
  // Two channels, disjoint by message type:
  //   - `forwardState` (`client.on('*', …)`) for every non-byte message.
  //     `EmitterMessage` excludes `PaneOutputMessage`, so this handler
  //     cannot accidentally receive bytes — the type system enforces it.
  //   - Per-renderer BytesSink (attached in onRegister) for byte chunks.
  //     Each renderer's sink routes directly from the substrate — no
  //     per-chunk broadcast loop. [LAW:dataflow-not-control-flow]
  //
  // Both write to IPC.event so the renderer's event handler sees a single
  // stream (the renderer narrows on `isPaneOutput`). The wire format is the
  // boundary type that admits both, but the local emitter on either side
  // never carries bytes through its API.
  // -------------------------------------------------------------------------

  const broadcast = (msg: EmitterMessage): void => {
    // Snapshot the senders entries before iterating: teardownSender below
    // calls senders.delete(wc), and a destroyed wc detected mid-loop must
    // not perturb the iteration order of the rest of the senders.
    const snapshot = [...senders];
    for (const [wc, state] of snapshot) {
      // [LAW:no-defensive-null-guards] isDestroyed is a trust-boundary check:
      // Electron may fire "destroyed" asynchronously, so a send could race a
      // teardown. Guarding here avoids a native crash inside wc.send.
      if (wc.isDestroyed()) {
        teardownSender(wc);
        continue;
      }
      if (!state.isSubscribed) continue;
      wc.send(IPC.event, msg);
    }
  };

  const forwardState = (msg: EmitterMessage): void => {
    broadcast(msg);
  };

  client.on("*", forwardState);

  // -------------------------------------------------------------------------
  // Subscribe / unsubscribe / ack channel handlers.
  // -------------------------------------------------------------------------

  const onRegister = (event: IpcMainEventLike): void => {
    const state = getOrCreateSender(event.sender);
    state.isSubscribed = true;
    // [LAW:dataflow-not-control-flow] Attach the per-renderer byte forwarder
    // exactly once per registration. Each renderer's sink is the routing
    // primitive — the substrate's SinkRegistry.dispatch fans out; no
    // per-chunk broadcast loop exists in the bridge. [LAW:one-source-of-truth]
    if (state.detachBytes === null) {
      const wc = state.wc;
      const rendererSink: BytesSink = {
        write(msg): void {
          // [LAW:no-defensive-null-guards] isDestroyed is a trust-boundary check
          // on Electron's WebContents lifecycle — same pattern as broadcast().
          if (wc.isDestroyed()) return;
          // Account BEFORE wc.send so a synchronous ack during send subtracts
          // from the right baseline.
          bridge.accountOutput(state.peer, msg.paneId, msg.data.byteLength);
          // [LAW:types-are-the-program] ChunkPayload → PaneOutputMessage at the
          // IPC boundary so the renderer's isPaneOutput check routes correctly.
          const ipcMsg: PaneOutputMessage = {
            type: "output",
            paneId: msg.paneId,
            data: msg.data,
          };
          wc.send(IPC.event, ipcMsg);
        },
        end(): void {
          // Stateless forwarding sink; no teardown action needed.
        },
      };
      state.detachBytes = client.attachBytesSink(rendererSink, {
        scope: serverScope,
      });
    }
    // [LAW:dataflow-not-control-flow] Late-joining renderers need the current
    // lifecycle state immediately, not just when the next transition happens.
    // Send a snapshot through the same IPC.event channel the live transitions
    // use — receivers treat it identically.
    if (!event.sender.isDestroyed()) {
      event.sender.send(IPC.event, {
        type: "connection-state",
        state: client.connectionState,
      });
    }
  };

  const onUnregister = (event: IpcMainEventLike): void => {
    // Unregister is the proxy.close() path: full teardown for this sender
    // (matches the destroyed-handler behavior). The proxy will not receive
    // further events; pending invokes abort; subscriptions refcount-clean.
    //
    // [LAW:single-enforcer] Idempotent by construction: teardownSender
    // returns immediately when the sender is already gone. A misbehaving or
    // double-firing renderer that re-sends `tmux:unregister` is a noop and
    // cannot tear anything down twice (no duplicate refcount decrements,
    // no duplicate dispatch aborts).
    teardownSender(event.sender);
  };

  const onAck = (event: IpcMainEventLike, ...args: unknown[]): void => {
    const state = senders.get(event.sender);
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
    bridge.ackOutput(state.peer, ack.paneId, ack.bytes);
  };

  // [LAW:locality-or-seam] IpcMainOnListener — the registered listener
  // shape — is the SAME for `on` and `removeListener`, so the same named
  // reference passed to `on` is the one passed to `removeListener` below.
  // No cast at either site means a refactor that wraps `onRegister` cannot
  // silently make `dispose()` a no-op.
  const onRegisterListener: IpcMainOnListener = onRegister;
  const onUnregisterListener: IpcMainOnListener = onUnregister;
  const onAckListener: IpcMainOnListener = onAck;
  ipcMain.on(IPC.register, onRegisterListener);
  ipcMain.on(IPC.unregister, onUnregisterListener);
  ipcMain.on(IPC.ack, onAckListener);

  // -------------------------------------------------------------------------
  // Single invoke handler — straight pipe through the shared RPC layer,
  // with subscribe/unsubscribe interception for ownership + refcount.
  //
  // [LAW:single-enforcer] One handler. parseRpcRequest enforces the shape;
  // dispatchRpcRequest performs the typed dispatch for everything except
  // the bridge-stateful operations (subscribe/unsubscribe), whose ownership
  // logic lives in the shared BridgeConnection helper.
  // -------------------------------------------------------------------------

  const runDispatch = (
    state: SenderState,
    req: RpcRequest,
  ): Promise<CommandResponse> => {
    if (req.method === "subscribeRaw") {
      const [name, what, format] = req.args;
      return bridge.subscribeForPeer(state.peer, name, what, format);
    }
    if (req.method === "unsubscribe") {
      const [name] = req.args;
      return bridge.unsubscribeForPeer(state.peer, name);
    }
    return dispatchRpcRequest(client, req);
  };

  const invokeHandler = async (
    event: IpcMainInvokeEventLike,
    ...args: unknown[]
  ): Promise<InvokeResultEnvelope> => {
    // [LAW:dataflow-not-control-flow] The handler ALWAYS returns an
    // InvokeResultEnvelope — every outcome (success, tmux %error, bridge
    // failure) becomes a value in the envelope's discriminated union. The
    // handler never rejects.
    //
    // Why never reject: real Electron's `ipcMain.handle` serializes a
    // promise rejection by reading `.message` (and `.stack` in dev mode);
    // structured-clone DROPS subclass properties like `.code`. Throwing
    // BridgeError out of this handler loses the very piece of information
    // the renderer needs to branch on. The wire envelope carries
    // `BridgeErrorPayload` (`{code, message}`) so the renderer
    // reconstructs a typed BridgeError via `BridgeError.fromPayload`.
    //
    // [LAW:single-enforcer] parseRpcRequest is still the only validation
    // site; the difference is that RpcError no longer escapes — it is
    // mapped to BridgeError at this seam (rpcErrorToBridge below).
    const senderState = getOrCreateSender(event.sender);
    const dispatch: PendingDispatch = { aborted: false };
    senderState.pending.add(dispatch);

    try {
      let req: RpcRequest;
      try {
        req = parseRpcRequest(args[0]);
      } catch (err) {
        if (err instanceof RpcError) return rpcErrorEnvelope(err);
        return internalErrorEnvelope("<unknown>", err);
      }
      const method = req.method;
      try {
        const response = await runDispatch(senderState, req);
        if (dispatch.aborted) return abortedEnvelope(method);
        return { status: "ok", response };
      } catch (err) {
        if (dispatch.aborted) return abortedEnvelope(method);
        if (err instanceof TmuxCommandError) {
          return { status: "tmux-error", response: err.response };
        }
        if (err instanceof BridgeError) {
          return { status: "bridge-error", error: err.toPayload() };
        }
        if (err instanceof RpcError) return rpcErrorEnvelope(err);
        return internalErrorEnvelope(method, err);
      }
    } finally {
      senderState.pending.delete(dispatch);
    }
  };

  // [LAW:one-source-of-truth] One Set tracks every handler-call promise so
  // `drain()` can await them. Per-sender `pending` Sets carry the abort
  // signal (the PendingDispatch flag); this Set carries the await target.
  // They serve different purposes — keeping them separate is cheaper than
  // promoting PendingDispatch into a deferred.
  const pendingHandlerCalls = new Set<Promise<InvokeResultEnvelope>>();

  const trackedInvokeHandler = (
    event: IpcMainInvokeEventLike,
    ...args: unknown[]
  ): Promise<InvokeResultEnvelope> => {
    const p = invokeHandler(event, ...args);
    pendingHandlerCalls.add(p);
    // The envelope-returning handler never rejects under normal flow, but
    // keep the symmetric cleanup so a programming error (a rejection that
    // somehow escapes the try/catch) does not leak into the tracking Set.
    const cleanup = (): void => {
      pendingHandlerCalls.delete(p);
    };
    p.then(cleanup, cleanup);
    return p;
  };

  ipcMain.handle(IPC.invoke, trackedInvokeHandler);

  return {
    dispose() {
      client.off("*", forwardState);
      ipcMain.removeListener(IPC.register, onRegisterListener);
      ipcMain.removeListener(IPC.unregister, onUnregisterListener);
      ipcMain.removeListener(IPC.ack, onAckListener);
      ipcMain.removeHandler(IPC.invoke);
      // Tear down every sender through the unified path: aborts in-flight
      // dispatches, removes destroyed listeners from still-alive wcs (so
      // dispose doesn't leak handlers across bridge re-installations), and
      // calls bridge.removePeer for each. Then bridge.dispose() flushes any
      // residual pause state and unsubscribes any names the bridge created
      // but no peer was holding (defense in depth — removePeer should have
      // taken care of all of them).
      for (const wc of [...senders.keys()]) teardownSender(wc);
      bridge.dispose();
      REGISTERED_IPC_MAINS.delete(ipcMain);
    },
    async drain(timeoutMs?: number): Promise<void> {
      if (pendingHandlerCalls.size === 0) return;
      const all = Promise.allSettled([...pendingHandlerCalls]).then(
        () => undefined,
      );
      if (timeoutMs === undefined) {
        await all;
        return;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      });
      try {
        await Promise.race([all, timeout]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// WebContentsSink — Electron main → renderer byte forwarder (BytesSink).
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

// Re-export the types a main-process consumer might need without forcing a
// second import site.
export type {
  BridgeErrorCode,
  BridgeErrorPayload,
  IpcMainLike,
  MainBridgeHandle,
  MainBridgeOptions,
  PaneBytesEnvelope,
  PaneEndEnvelope,
  WebContentsLike,
} from "./types.js";
export { BridgeError } from "./types.js";
