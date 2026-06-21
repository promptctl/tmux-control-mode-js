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

import type { TmuxClient } from "../../client.js";
import type { EmitterMessage } from "../../emitter.js";
import { TmuxCommandError } from "../../errors.js";
import { paneScope, type BytesSink } from "../../pane-output.js";
import type {
  CommandResponse,
  PaneOutputMessage,
} from "../../protocol/types.js";
import {
  parseRpcRequest,
  RpcError,
  type RpcErrorCode,
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
  type BridgeErrorCode,
  type InvokeResultEnvelope,
  type IpcMainEventLike,
  type IpcMainInvokeEventLike,
  type IpcMainLike,
  type IpcMainOnListener,
  type MainBridgeHandle,
  type MainBridgeOptions,
  type PaneEndEnvelope,
  type WebContentsLike,
} from "./types.js";

// ---------------------------------------------------------------------------
// RpcError → BridgeError mapping at the IPC trust boundary.
//
// [LAW:single-enforcer] RpcError is connector-internal; it is mapped to a
// `BridgeError` here so the wire taxonomy is unified across both transports.
// (The WebSocket server has the same mapping at its own seam — see
// `src/connectors/websocket/server.ts:RPC_ERROR_TO_BRIDGE`.)
// ---------------------------------------------------------------------------

const RPC_ERROR_TO_BRIDGE: Readonly<Record<RpcErrorCode, BridgeErrorCode>> = {
  UNKNOWN_METHOD: "BRIDGE_UNKNOWN_METHOD",
  INVALID_REQUEST: "BRIDGE_INVALID_REQUEST",
  INVALID_ARG: "BRIDGE_INVALID_ARG",
};

function rpcErrorToBridge(err: RpcError): BridgeError {
  // RpcError prepends `[CODE] ` to its `.message`; the bridge code on the
  // BridgeError already supplies that prefix, so strip RpcError's first to
  // avoid double-prefixed messages like `[BRIDGE_INVALID_ARG] [INVALID_ARG] ...`.
  const stripped = err.message.replace(/^\[[A-Z_]+\] /, "");
  return new BridgeError(RPC_ERROR_TO_BRIDGE[err.code], stripped);
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

    // (2) Drop helper-side accounting + subscription refcounts in one call.
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
  //   - `forwardBytes` (`client.attachBytesSink(…)`) for every byte
  //     chunk on every pane. The server scope is the legitimate
  //     "I want all bytes" attachment shape; pane scope is for
  //     consumers that own a single pane, not for forwarders.
  //
  // Both write to IPC.event so the renderer's event handler sees a single
  // stream (the renderer narrows on `isPaneOutput`). The wire format is the
  // boundary type that admits both, but the local emitter on either side
  // never carries bytes through its API.
  // -------------------------------------------------------------------------

  // [LAW:dataflow-not-control-flow] One snapshot helper shared by both
  // channels — same iteration, same liveness check, same subscribed gate.
  // Variability lives in the per-message work each channel does, not in
  // the broadcast plumbing.
  const broadcast = (
    msg: EmitterMessage | PaneOutputMessage,
    perSender: ((state: SenderState) => void) | null,
  ): void => {
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
      // For byte messages: account bytes per (renderer, pane) BEFORE
      // wc.send so that an ack arriving synchronously during send
      // subtracts from the right baseline.
      perSender?.(state);
      wc.send(IPC.event, msg);
    }
  };

  const forwardState = (msg: EmitterMessage): void => {
    broadcast(msg, null);
  };

  const forwardBytes: BytesSink = {
    // [LAW:types-are-the-program] ChunkPayload is the internal form; the IPC
    // wire boundary requires a PaneOutputMessage so the renderer's isPaneOutput
    // check routes correctly. Adapt at the boundary by adding type: "output".
    write(msg) {
      const ipcMsg: PaneOutputMessage = {
        type: "output",
        paneId: msg.paneId,
        data: msg.data,
      };
      broadcast(ipcMsg, (state) => {
        bridge.accountOutput(state.peer, msg.paneId, msg.data.byteLength);
      });
    },
    // [LAW:types-are-the-program] end() is required by BytesSink contract; no
    // pane teardown state to flush in this forwarding sink.
    end(): void {
      /* stateless sink */
    },
  };

  client.on("*", forwardState);
  const detachByteForwarder = client.attachBytesSink(forwardBytes);

  // -------------------------------------------------------------------------
  // Subscribe / unsubscribe / ack channel handlers.
  // -------------------------------------------------------------------------

  const onRegister = (event: IpcMainEventLike): void => {
    const state = getOrCreateSender(event.sender);
    state.isSubscribed = true;
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
      detachByteForwarder();
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
// attachWebContentsSink — Electron main → renderer byte forwarder.
//
// Internally creates a `BytesSink` that forwards each chunk to
// `wc.send(IPC.paneBytes, { paneId, data })`, calls
// `client.attachBytesSink(sink, { scope: paneScope(paneId) })`, and
// returns a disposer wrapping the attach-side disposer. The sink reference
// NEVER escapes this closure — by construction, the same wire stream cannot
// be double-attached, refcount-corrupted, or terminated by a stale `end()`.
//
// [LAW:types-are-the-program] The strongest true theorem about this surface
// is "exactly one attachment per `(wc, paneId)`," and the way to make that
// theorem hold is to remove any value the caller could misuse. Returning
// the disposer only — never the sink — is that move.
//
// [LAW:single-enforcer] One Electron byte-forwarder lives here only.
// Consumers used to reach for `client.on('output', ...)` and then call
// `wc.send` themselves; the first downstream that did this also reached for
// `new TextDecoder('latin1').decode(...)` on the way through, corrupting
// every multi-byte sequence. The factory is the answer: composers don't
// pick a channel name, don't shape a payload, and never hold the bytes.
//
// [LAW:locality-or-seam] The seam between "pane bytes" and "Electron IPC"
// is this factory + its renderer-side `createPaneBytesReceiver` counterpart.
// The wire shape (`PaneBytesEnvelope`, `PaneEndEnvelope`) is owned by
// `./types.ts` and never reaches the consumer; on the main side the sink
// itself doesn't reach the consumer either.
//
// [LAW:dataflow-not-control-flow] `write` and `end` always run the same
// path — the trust-boundary `wc.isDestroyed()` guard is data flow on
// Electron's lifecycle (a state the type system genuinely cannot encode),
// not a missing invariant compensated for in the body.
// ---------------------------------------------------------------------------

// Active-attachment registry — exactly one `attachWebContentsSink` per
// `(wc, paneId)` pair.
//
// Two independent attachments for the same pair would each fire their own
// wire `paneEnd` frame at disposer-time, and the first one to land would
// auto-detach the renderer-side receiver — orphaning byte flow for the
// other attachment. The registry refuses the second call loudly instead
// of silently corrupting the stream.
//
// [LAW:no-shared-mutable-globals] Module-level `WeakMap` keyed by `wc` so
// the registry never outlives its targets. The constructor and the
// disposer are the explicit API.

const ACTIVE_WEBCONTENTS_SINKS = new WeakMap<WebContentsLike, Set<number>>();

/**
 * Forward pane bytes for `paneId` to the given `WebContents` over IPC.
 *
 * Internally constructs a `BytesSink` that turns each chunk into one
 * `wc.send(IPC.paneBytes, msg)` frame (forwarding the full
 * `PaneOutputMessage` directly — `PaneBytesEnvelope` is that type) and the
 * once-per-attachment `end()` into one `wc.send(IPC.paneEnd, { paneId })`
 * frame, calls `client.attachBytesSink(sink, { scope: paneScope(paneId) })`,
 * and returns a disposer that unwinds the attachment. `Uint8Array` payloads
 * ride Electron's structured-clone IPC — no base64 hop, no decode site, no
 * copy at the sink itself (structured-clone is the trust-boundary copy).
 *
 * The sink instance is never exposed: the closure owns it, so it cannot
 * be attached more than once. The wire's `paneId`-scoped lifecycle and
 * the attachment's lifecycle are 1:1 by construction.
 *
 * ## Exclusivity (one attachment per `(wc, paneId)`)
 *
 * A second `attachWebContentsSink(client, wc, paneId)` for a pair that
 * already has an active attachment throws
 * `BridgeError("BRIDGE_PANE_SINK_ALREADY_ATTACHED")` — the wire envelope
 * is paneId-scoped and cannot disambiguate two concurrent attachments.
 * The slot is freed when the returned disposer is called. Hosts that
 * want to "rotate" the forwarder for a pane MUST dispose the prior
 * attachment first.
 *
 * ## Lifecycle
 *
 * The internal sink's `wc.isDestroyed()` guard is a trust-boundary check
 * on Electron's `WebContents` lifecycle. Calling `wc.send` on a destroyed
 * `WebContents` is a native crash in some Electron versions and a silent
 * no-op in others; the guard makes the outcome consistent and observable
 * (a no-op `write` on a dead receiver, not a crash). The host is
 * expected to call the disposer returned here from
 * `wc.once('destroyed', ...)`.
 *
 * The returned disposer is idempotent. Calling it from a `destroyed`
 * handler and then again from an unrelated teardown path is safe.
 *
 * ## Contract notes
 *
 * - The internal sink's `write` MUST NOT throw — the library does not
 *   catch sink errors. The native `wc.send` call can throw if the
 *   `WebContents` is destroyed between the `isDestroyed()` check and the
 *   send (a TOCTOU window Electron's API does not close). This is a
 *   real-but-rare path that the host's `wc.once('destroyed', ...)`
 *   cleanup ordinarily forecloses. Wrapping the send in try/catch would
 *   silently swallow a genuine misconfiguration (a serializer rejection
 *   on a non-cloneable payload, for instance), so the forwarder prefers
 *   loud failure over hidden bugs.
 *
 * @returns A disposer that unwinds the attachment and frees the
 *   `(wc, paneId)` slot. Idempotent.
 * @see BytesSink for the underlying sink contract.
 * @see createPaneBytesReceiver (renderer.ts) for the matching consumer.
 */
export function attachWebContentsSink(
  client: TmuxClient,
  wc: WebContentsLike,
  paneId: number,
): () => void {
  let active = ACTIVE_WEBCONTENTS_SINKS.get(wc);
  if (active === undefined) {
    active = new Set<number>();
    ACTIVE_WEBCONTENTS_SINKS.set(wc, active);
  }
  if (active.has(paneId)) {
    throw new BridgeError(
      "BRIDGE_PANE_SINK_ALREADY_ATTACHED",
      `attachWebContentsSink already active for paneId=${paneId} on this WebContents; dispose the prior attachment before attaching a new one`,
    );
  }
  active.add(paneId);
  const registrySet = active;

  const sink: BytesSink = {
    write(msg): void {
      // [LAW:no-defensive-null-guards] `isDestroyed` is a trust-boundary
      // check on Electron's WebContents lifecycle — the same guard the
      // `createMainBridge` forward loop uses for the same reason. Not a
      // workaround for a missing invariant; the lifecycle is external.
      if (wc.isDestroyed()) return;
      // [LAW:one-source-of-truth] msg IS the envelope — send it directly.
      wc.send(IPC.paneBytes, msg);
    },
    end(): void {
      // [LAW:one-source-of-truth] `end()` is the library's once-per-
      // attachment terminator. The wire frame fires only when the
      // WebContents is still alive; the registry slot is freed
      // unconditionally below in the disposer, which is the path that
      // also invokes this `end()` via the attach disposer.
      if (wc.isDestroyed()) return;
      const envelope: PaneEndEnvelope = { paneId };
      wc.send(IPC.paneEnd, envelope);
    },
  };

  const attachDispose = client.attachBytesSink(sink, {
    scope: paneScope(paneId),
  });

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    // Free the slot BEFORE invoking attachDispose: `attachDispose` calls
    // `sink.end()`, and the wire frame it sends is the renderer's signal
    // to detach. Freeing the slot first means a rotated attachment
    // constructed from inside (e.g.) a synchronous downstream effect can
    // succeed without false-positive duplicate detection.
    registrySet.delete(paneId);
    attachDispose();
  };
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
