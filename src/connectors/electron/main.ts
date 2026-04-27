// src/connectors/electron/main.ts
// Electron main-process bridge: forwards TmuxClient events to registered
// renderers and routes renderer command invocations to the client.
//
// This file owns ONLY what is electron-specific:
//   - Single-instance enforcement on the ipcMain singleton.
//   - One unified per-sender state map (subscription flag, outstanding bytes,
//     in-flight invokes, owned subscription names) — every per-renderer
//     concern routes through this map so teardown is one operation.
//   - Watermark-driven setPaneAction(Pause/Continue) loop.
//   - Subscription ownership (refcount) and auto-cleanup on disconnect so a
//     compromised renderer cannot unsubscribe another window's subscriptions
//     and a renderer reload doesn't leak tmux-side subscriptions.
//   - Forwarding TmuxClient events as Electron IPC messages.
//
// RPC validation, dispatch, and method allowlist all live in `../rpc.ts`.
// Adding a TmuxClient method = one file edit.
//
// [LAW:single-enforcer] One ipcMain.handle("tmux:invoke") per process; the
// invoke handler delegates parsing+dispatching to ../rpc, with subscription
// RPCs intercepted at the bridge boundary so refcount + ownership are
// enforced in exactly one place.
// [LAW:one-source-of-truth] One SenderState entry per renderer, holding
// every per-renderer concern; teardownSender is the only cleanup path.
// [LAW:one-source-of-truth] IPC channel names from ./types.js; RPC behavior
// from ../rpc.js. No duplication of either on this side.

import type { TmuxClient } from "../../client.js";
import { TmuxCommandError } from "../../errors.js";
import {
  asPaneOutput,
  PaneAction,
  type CommandResponse,
  type TmuxMessage,
} from "../../protocol/types.js";
import { parseRpcRequest, RpcError, type RpcRequest } from "../rpc.js";
import { dispatchRpcRequest } from "../rpc-dispatch.js";
import {
  BridgeError,
  DEFAULT_OUTPUT_HIGH_WATERMARK,
  DEFAULT_OUTPUT_LOW_WATERMARK,
  IPC,
  parseAckMessage,
  type IpcMainEventLike,
  type IpcMainInvokeEventLike,
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
// Per-sender state.
// ---------------------------------------------------------------------------

interface PendingDispatch {
  /**
   * Set true when the sender's WebContents is destroyed (or unregisters)
   * while this dispatch's await is in-flight. The TmuxClient FIFO is
   * intentionally NOT purged — the underlying %begin/%end pair still pops
   * the pending entry in order so subsequent dispatches stay correlated.
   * The post-await branch in invokeHandler observes `aborted` and discards
   * the result via a typed BridgeError instead of trying to send it to a
   * dead webContents.
   */
  aborted: boolean;
}

interface SenderState {
  readonly wc: WebContentsLike;
  /** True once the renderer has sent IPC.register; toggled off by unregister. */
  isSubscribed: boolean;
  /** Per-pane bytes sent to this renderer but not yet acknowledged. */
  readonly outstanding: Map<number, number>;
  /** In-flight invoke dispatches owned by this sender. */
  readonly pending: Set<PendingDispatch>;
  /** Subscription names this sender currently holds (for refcount + cleanup). */
  readonly subscriptions: Set<string>;
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
 *   - Subscribe / unsubscribe are intercepted at the bridge boundary: every
 *     subscription name carries an ownership tag for its sender. A renderer
 *     attempting to unsubscribe a name it does not own is rejected with
 *     `UNKNOWN_SUBSCRIPTION` — preventing one window from tearing down
 *     another window's subscriptions. The bridge refcounts subscriptions so
 *     the underlying tmux unsubscribe fires only when the last sender drops.
 *
 * Backpressure:
 *   - For every `%output` / `%extended-output` byte forwarded, main accounts
 *     it as outstanding for that (renderer, pane) pair. When the per-pane
 *     total (summed across renderers) crosses `outputHighWatermark`, main
 *     calls `client.setPaneAction(paneId, Pause)`. When the renderer
 *     replies with `tmux:ack` (paneId, bytes consumed) and the total falls
 *     below `outputLowWatermark`, main resumes the pane.
 *
 * Renderer death:
 *   - `webContents.once("destroyed", ...)` fires `teardownSender` once per
 *     sender. That single path:
 *       (1) marks all in-flight invoke dispatches `aborted` so the await
 *           resolves but the result is discarded with a BridgeError
 *           (the TmuxClient FIFO stays intact — no purge → no desync);
 *       (2) drops outstanding-byte accounting and resumes any panes that
 *           were paused only because of this renderer's lag;
 *       (3) refcount-decrements every subscription this sender owned and
 *           calls `client.unsubscribe` for any whose refcount hits zero.
 *
 * Returns a handle whose `dispose()` removes every installed IPC handler,
 * resumes any panes the bridge had paused, refcount-cleans every subscription
 * the bridge created, and frees the ipcMain for a subsequent createMainBridge.
 * The caller still owns `client.close()`.
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

  const senders = new Map<WebContentsLike, SenderState>();
  const pausedPanes = new Set<number>();
  // Refcount: subscription name → number of senders currently holding it.
  // Drives whether unsubscribe propagates to tmux.
  const subscriptionRefcount = new Map<string, number>();

  // Fire-and-forget pause/continue/unsubscribe — tmux's response carries no
  // actionable info; a rejection means the pane/subscription already went
  // away, which is fine.
  const swallow = (): void => undefined;

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
    for (const s of senders.values()) {
      sum += s.outstanding.get(paneId) ?? 0;
    }
    return sum;
  };

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
  // Sender state lifecycle.
  // -------------------------------------------------------------------------

  const getOrCreateSender = (wc: WebContentsLike): SenderState => {
    const existing = senders.get(wc);
    if (existing !== undefined) return existing;
    const state: SenderState = {
      wc,
      isSubscribed: false,
      outstanding: new Map(),
      pending: new Set(),
      subscriptions: new Set(),
    };
    senders.set(wc, state);
    // [LAW:single-enforcer] One destroyed-handler per sender. Attaching here
    // (not in onRegister) means a renderer that only ever invoke()s — never
    // register()s — still cleans up correctly when its webContents dies.
    wc.once("destroyed", () => teardownSender(wc));
    return state;
  };

  const teardownSender = (wc: WebContentsLike): void => {
    const state = senders.get(wc);
    if (state === undefined) return;
    senders.delete(wc);

    // (1) Mark in-flight invokes aborted. The TmuxClient FIFO stays intact —
    //     the underlying %begin/%end still resolves the pending entry in
    //     order — but the post-await branch in invokeHandler observes the
    //     aborted flag and throws BridgeError("ABORTED") instead of trying
    //     to deliver to a dead webContents.
    for (const p of state.pending) p.aborted = true;

    // (2) Drop outstanding-byte accounting and resume panes that were paused
    //     only because of this renderer's lag.
    const paneIds = [...state.outstanding.keys()];
    state.outstanding.clear();
    for (const paneId of paneIds) maybeResume(paneId);

    // (3) Refcount-decrement subscriptions this sender owned. Last sender
    //     out triggers the tmux unsubscribe.
    for (const name of state.subscriptions) releaseSubscriptionRefcount(name);
    state.subscriptions.clear();
  };

  // -------------------------------------------------------------------------
  // Subscription ownership + refcount.
  //
  // [LAW:single-enforcer] Subscription RPCs go through this layer instead
  // of straight to dispatchRpcRequest. The bridge owns ownership tracking
  // and refcount decrement; tmux only sees (subscribe, unsubscribe) calls
  // when refcount transitions cross zero.
  // -------------------------------------------------------------------------

  const acquireSubscriptionRefcount = (name: string): void => {
    subscriptionRefcount.set(name, (subscriptionRefcount.get(name) ?? 0) + 1);
  };

  const releaseSubscriptionRefcount = (name: string): void => {
    const prev = subscriptionRefcount.get(name) ?? 0;
    if (prev <= 1) {
      subscriptionRefcount.delete(name);
      // tmux unsubscribe is fire-and-forget on cleanup paths — by the time
      // we get here the renderer is already gone or the bridge is being
      // disposed; nothing useful can be done with the response.
      void client.unsubscribe(name).catch(swallow);
      return;
    }
    subscriptionRefcount.set(name, prev - 1);
  };

  /** Synthesized success response for refcounted no-op operations. */
  const synthesizeOk = (): CommandResponse => ({
    commandNumber: -1,
    timestamp: Date.now(),
    success: true,
    output: [],
  });

  const subscribeForSender = async (
    state: SenderState,
    name: string,
    what: string,
    format: string,
  ): Promise<CommandResponse> => {
    // [LAW:dataflow-not-control-flow] Every subscribe forwards to tmux —
    // tmux's `refresh-client -B` is replace-or-add semantics, so
    // re-subscribing with a new format is a valid update path. The bridge's
    // role is ownership tracking, not deduplicating tmux calls.
    if (!state.subscriptions.has(name)) {
      state.subscriptions.add(name);
      acquireSubscriptionRefcount(name);
    }
    return client.subscribe(name, what, format);
  };

  const unsubscribeForSender = async (
    state: SenderState,
    name: string,
  ): Promise<CommandResponse> => {
    if (!state.subscriptions.has(name)) {
      throw new BridgeError(
        "UNKNOWN_SUBSCRIPTION",
        `sender does not own subscription "${name}" (this prevents one ` +
          `renderer from tearing down another's subscriptions)`,
      );
    }
    state.subscriptions.delete(name);
    const prev = subscriptionRefcount.get(name) ?? 0;
    if (prev <= 1) {
      subscriptionRefcount.delete(name);
      return client.unsubscribe(name);
    }
    subscriptionRefcount.set(name, prev - 1);
    // Other senders still own this subscription — don't tear down at tmux.
    return synthesizeOk();
  };

  // -------------------------------------------------------------------------
  // Event forwarding.
  // -------------------------------------------------------------------------

  const forward = (msg: TmuxMessage): void => {
    const accounted = byteAccount(msg);
    // [LAW:dataflow-not-control-flow] One pass over senders, every message,
    // unconditionally. Senders that aren't subscribed are skipped via the
    // data flag (state.isSubscribed) — the loop body is the same shape.
    for (const [wc, state] of senders) {
      // [LAW:no-defensive-null-guards] isDestroyed is a trust-boundary check:
      // Electron may fire "destroyed" asynchronously, so a send could race a
      // teardown. Guarding here avoids a native crash inside wc.send.
      if (wc.isDestroyed()) {
        teardownSender(wc);
        continue;
      }
      if (!state.isSubscribed) continue;
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
  // Subscribe / unsubscribe / ack channel handlers.
  // -------------------------------------------------------------------------

  const onRegister = (event: IpcMainEventLike): void => {
    const state = getOrCreateSender(event.sender);
    state.isSubscribed = true;
  };

  const onUnregister = (event: IpcMainEventLike): void => {
    // Unregister is the proxy.close() path: full teardown for this sender
    // (matches the destroyed-handler behavior). The proxy will not receive
    // further events; pending invokes abort; subscriptions refcount-clean.
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
  // Single invoke handler — straight pipe through the shared RPC layer,
  // with subscribe/unsubscribe interception for ownership + refcount.
  //
  // [LAW:single-enforcer] One handler. parseRpcRequest enforces the shape;
  // dispatchRpcRequest performs the typed dispatch for everything except
  // the bridge-stateful operations (subscribe/unsubscribe), whose ownership
  // logic lives ONLY here.
  // -------------------------------------------------------------------------

  const runDispatch = (
    state: SenderState,
    req: RpcRequest,
  ): Promise<CommandResponse> => {
    if (req.method === "subscribe") {
      const [name, what, format] = req.args;
      return subscribeForSender(state, name, what, format);
    }
    if (req.method === "unsubscribe") {
      const [name] = req.args;
      return unsubscribeForSender(state, name);
    }
    return dispatchRpcRequest(client, req);
  };

  const invokeHandler = async (
    event: IpcMainInvokeEventLike,
    ...args: unknown[]
  ): Promise<unknown> => {
    // [LAW:single-enforcer] parseRpcRequest is the only validation site;
    // RpcError surfaces with structured code + message, propagated verbatim
    // so the renderer sees the same contract every time.
    //
    // The dispatch result is wrapped in a small envelope so TmuxCommandError
    // can cross IPC: real Electron's `ipcMain.handle` serializes `Error`
    // rejections as opaque messages and drops their custom properties (e.g.
    // `.response`). Returning a plain object preserves the structured
    // CommandResponse end-to-end. The renderer's `invoke()` re-throws as a
    // TmuxCommandError so `proxy.execute()` keeps the same contract as
    // `client.execute()`.
    //
    // [LAW:locality-or-seam] Unexpected sync throws (encoder bugs, internal
    // invariant violations) MUST cross IPC with localizing context, not as
    // bare opaque messages. Real Electron drops custom Error properties on
    // serialization, so the context has to ride in `.message`. The wrapper
    // adds method name + original cause; the original stack is preserved on
    // `.stack` for renderer-side logging.
    const senderState = getOrCreateSender(event.sender);
    const dispatch: PendingDispatch = { aborted: false };
    senderState.pending.add(dispatch);

    let method = "<unknown>";
    try {
      const req = parseRpcRequest(args[0]);
      method = req.method;
      try {
        const response = await runDispatch(senderState, req);
        if (dispatch.aborted) {
          throw new BridgeError(
            "ABORTED",
            `dispatch for method=${method} aborted: sender destroyed`,
          );
        }
        return { ok: true as const, response };
      } catch (err) {
        if (err instanceof TmuxCommandError) {
          if (dispatch.aborted) {
            throw new BridgeError(
              "ABORTED",
              `dispatch for method=${method} aborted: sender destroyed`,
            );
          }
          return { ok: false as const, response: err.response };
        }
        throw err;
      }
    } catch (err) {
      if (err instanceof RpcError || err instanceof BridgeError) throw err;
      const causeMsg = err instanceof Error ? err.message : String(err);
      const wrapped = new Error(
        `[BRIDGE_INTERNAL] dispatch failed for method=${method}: ${causeMsg}`,
      );
      if (err instanceof Error && err.stack !== undefined) {
        wrapped.stack = `${wrapped.stack ?? wrapped.message}\nCaused by: ${err.stack}`;
      }
      throw wrapped;
    } finally {
      senderState.pending.delete(dispatch);
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
      ipcMain.removeListener(IPC.ack, onAck as (...args: unknown[]) => void);
      ipcMain.removeHandler(IPC.invoke);
      // Resume any panes we paused so we don't leave tmux stuck after teardown.
      for (const paneId of pausedPanes) {
        void client.setPaneAction(paneId, PaneAction.Continue).catch(swallow);
      }
      pausedPanes.clear();
      // Mark every in-flight dispatch aborted; their awaits will throw
      // BridgeError("ABORTED") rather than try to use a torn-down bridge.
      for (const state of senders.values()) {
        for (const p of state.pending) p.aborted = true;
      }
      // Clean every subscription refcount the bridge created.
      for (const name of subscriptionRefcount.keys()) {
        void client.unsubscribe(name).catch(swallow);
      }
      subscriptionRefcount.clear();
      senders.clear();
      REGISTERED_IPC_MAINS.delete(ipcMain);
    },
  };
}

// [LAW:single-enforcer] The discriminator check itself lives in
// asPaneOutput (src/protocol/types.ts). This function is the bytes-shaped
// projection main.ts's accounting loop wants — paneId + payload size.
function byteAccount(
  msg: TmuxMessage,
): { paneId: number; bytes: number } | null {
  const out = asPaneOutput(msg);
  return out === null
    ? null
    : { paneId: out.paneId, bytes: out.data.byteLength };
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
