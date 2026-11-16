// src/connectors/electron/sender-registry.ts
// [LAW:decomposition] The set of registered renderers and their per-sender
// lifecycle, extracted from createMainBridge. Owns the senders Map, each
// SenderState, the per-renderer byte forwarder, subscription gating, and the
// event fan-out over senders. The wiring shell holds no sender state.
//
// [LAW:one-source-of-truth] One SenderState entry per page a WebContents shows,
// and one `Peer` token per page registered with the shared BridgeConnection
// helper. A page ends when its WebContents is destroyed, navigates to a new
// document, or loses its renderer process; `teardown` is the only path that
// releases both — subscription refcount, size claim, outstanding-byte
// accounting, byte forwarder, and page-end listeners all drop together, in one
// place.
//
// [LAW:one-way-deps] This module knows nothing about the invoke pipeline. It
// defines the per-sender record — including the `pending` set of in-flight
// invoke abort-flags — and flags them on teardown; the pipeline populates that
// set through `getOrCreate`. The dependency runs one way (pipeline → registry),
// and there is exactly one per-renderer record, so nothing can drift.

import type { TmuxClient } from "../../client.js";
import type { EmitterMessage } from "../../emitter.js";
import { serverScope, type BytesSink } from "../../pane-output.js";
import type { BridgeConnection, Peer } from "../bridge-connection.js";
import {
  IPC,
  PAGE_END_EVENTS,
  parseAckMessage,
  type IpcMainEventLike,
  type WebContentsLike,
  type WebFrameLike,
} from "./types.js";
import { WebContentsSink } from "./sink.js";

// ---------------------------------------------------------------------------
// Per-sender state.
//
// Subscription ownership, refcount, and outstanding-byte accounting all live
// inside the shared BridgeConnection helper, keyed by the `peer` token below.
// SenderState carries only what is electron-specific: the WebContents, the
// page-end listener handle, the isSubscribed flag that gates event forwarding,
// and the in-flight invoke abort-flags. The invoke pipeline creates the
// PendingDispatch objects and owns their lifecycle; this record is where they
// live and where teardown flags them, so there is one place a sender's fate is
// decided.
// ---------------------------------------------------------------------------

/**
 * The abort channel for one in-flight invoke. The invoke pipeline creates it,
 * adds it to the owning sender's `pending` set, and reads `aborted` after its
 * dispatch await resolves. `SenderRegistry.teardown` flips it when the sender
 * dies mid-flight, so the pipeline returns a BRIDGE_ABORTED envelope instead of
 * delivering a result to a dead webContents.
 */
export interface PendingDispatch {
  aborted: boolean;
}

export interface SenderState {
  readonly wc: WebContentsLike;
  /** Token returned by BridgeConnection.registerPeer — the Map key the helper
   *  uses internally for refcount + outstanding-byte accounting. */
  readonly peer: Peer;
  /** True once the renderer has sent IPC.register; toggled off by unregister. */
  isSubscribed: boolean;
  /**
   * The exact listeners registered on `wc`: `onPageEnd` with `once` for every
   * PAGE_END_EVENTS entry, `onLoadFailed` with `on` for `did-fail-load`.
   * Stored so `teardown` can call `wc.removeListener` for the ones still
   * attached — otherwise a listener stays on a still-alive emitter and tears
   * down the NEXT page's sender when it fires.
   */
  readonly onPageEnd: () => void;
  readonly onLoadFailed: () => void;
  /** In-flight invoke dispatches owned by this sender. The pipeline adds/removes
   *  entries; teardown flags them all aborted. */
  readonly pending: Set<PendingDispatch>;
  /** Disposer for this renderer's per-peer byte forwarder sink. Null before
   * the first IPC.register call; set once and cleared on teardown. */
  detachBytes: (() => void) | null;
}

export interface SenderRegistryDeps {
  readonly bridge: Pick<
    BridgeConnection,
    | "registerPeer"
    | "removePeer"
    | "accountOutput"
    | "ackOutput"
    | "routeEvent"
    | "deliversTo"
  >;
  readonly client: Pick<TmuxClient, "attachBytesSink" | "connectionState">;
}

/**
 * Whether `frame` hosts the page `wc` shows now.
 *
 * A destroyed WebContents and a crashed renderer show no page, though their
 * `mainFrame` may still name the last host (before Electron 34, reading a
 * crashed one throws), so both are ruled out before `mainFrame` is read.
 * `isCrashed` turns false once a reload commits a new document.
 */
function showsFrame(wc: WebContentsLike, frame: WebFrameLike): boolean {
  return (
    !wc.isDestroyed() &&
    !wc.isCrashed() &&
    wc.mainFrame.processId === frame.processId &&
    wc.mainFrame.routingId === frame.routingId
  );
}

/** The frame host that sent `event`. */
function senderFrame(event: IpcMainEventLike): WebFrameLike {
  return { processId: event.processId, routingId: event.frameId };
}

/**
 * Whether `event` was sent by the page its WebContents shows now.
 *
 * [LAW:single-enforcer] The one test every renderer message passes before it
 * touches a sender. A page that has ended can still have messages in flight:
 * an invoke the old page queued may land after `did-navigate` tore its sender
 * down. When the navigation reused the frame host, Chromium delivers the old
 * document's IPC before the commit that fires `did-navigate`, so it reached
 * the old sender; when it swapped hosts, the old host's ids no longer match
 * `mainFrame`. (`WebFrameMain` object identity is no test: before Electron 34
 * one object follows the frame across host swaps.) Messages from subframes
 * fail too — a page has one peer, its main frame's.
 */
function sentByLivePage(event: IpcMainEventLike): boolean {
  return showsFrame(event.sender, senderFrame(event));
}

export class SenderRegistry {
  private readonly senders = new Map<WebContentsLike, SenderState>();

  constructor(private readonly deps: SenderRegistryDeps) {}

  /**
   * The SenderState for the page that sent `event`, creating it (and
   * registering its peer + page-end handler) on first sight. Called by both
   * `register` and the invoke pipeline, so a renderer that only ever invoke()s
   * — never register()s — still cleans up when its page ends.
   *
   * [LAW:types-are-the-program] [LAW:no-silent-failure] Returns `undefined`
   * when the sending page has ended (see sentByLivePage): its page-end event
   * has already fired, so a fresh peer would never be torn down — or, after a
   * navigation, would be inherited by the next page. Callers abort instead of
   * billing a peer and running a real command for a page that is gone.
   */
  getOrCreate(event: IpcMainEventLike): SenderState | undefined {
    if (!sentByLivePage(event)) return undefined;
    const wc = event.sender;
    const existing = this.senders.get(wc);
    if (existing !== undefined) return existing;
    const page = senderFrame(event);
    // [LAW:single-enforcer] One set of page listeners per sender, stored on
    // the sender so `teardown` can detach the ones still attached.
    const onPageEnd = (): void => this.teardown(wc);
    // A failed load ended the page only if it committed an error page in
    // another frame host; `did-fail-load` does not say which.
    const onLoadFailed = (): void => {
      if (!showsFrame(wc, page)) this.teardown(wc);
    };
    const peer = this.deps.bridge.registerPeer();
    const state: SenderState = {
      wc,
      peer,
      isSubscribed: false,
      onPageEnd,
      onLoadFailed,
      pending: new Set(),
      detachBytes: null,
    };
    this.senders.set(wc, state);
    for (const e of PAGE_END_EVENTS) wc.once(e, onPageEnd);
    wc.on("did-fail-load", onLoadFailed);
    return state;
  }

  /**
   * Handle a renderer's IPC.register: mark it subscribed, attach the per-peer
   * byte forwarder exactly once, and send the current connection-state snapshot
   * so a late-joining renderer has the lifecycle state immediately.
   */
  register(event: IpcMainEventLike): void {
    const state = this.getOrCreate(event);
    // [LAW:no-silent-failure] exception: a register not sent by the page shown
    // (it has ended, or a subframe sent it) has no one to answer — `wc.send`
    // reaches only the main frame's document.
    if (state === undefined) return;
    const wc = state.wc;
    state.isSubscribed = true;
    // [LAW:dataflow-not-control-flow] Attach the per-renderer byte forwarder
    // exactly once per registration. Each renderer's sink is the routing
    // primitive — the substrate's SinkRegistry.dispatch fans out; no per-chunk
    // broadcast loop exists in the bridge. [LAW:one-source-of-truth]
    if (state.detachBytes === null) {
      // [LAW:one-source-of-truth] The IPC envelope shaping (ChunkPayload →
      // PaneOutputMessage) and wire send live solely in WebContentsSink.write;
      // this internal sink wraps that one forwarder and adds backpressure
      // accounting. Previously both paths hand-built the envelope and could
      // silently diverge.
      const forwarder = new WebContentsSink(wc);
      const rendererSink: BytesSink = {
        write: (msg): void => {
          // [LAW:no-defensive-null-guards] Trust-boundary guard gating the
          // accounting: never bill a renderer whose WebContents Electron has
          // already destroyed (a stray account could pause a pane that never
          // acks). The send-side lifecycle guard is WebContentsSink's own.
          if (wc.isDestroyed()) return;
          // Account BEFORE the send so a synchronous ack during dispatch
          // subtracts from the right baseline.
          this.deps.bridge.accountOutput(
            state.peer,
            msg.paneId,
            msg.data.byteLength,
          );
          forwarder.write(msg);
        },
        end: (): void => {
          forwarder.end();
        },
      };
      state.detachBytes = this.deps.client.attachBytesSink(rendererSink, {
        scope: serverScope,
      });
    }
    // [LAW:dataflow-not-control-flow] Late-joining renderers need the current
    // lifecycle state immediately, not just when the next transition happens.
    // Send a snapshot through the same IPC.event channel the live transitions
    // use — receivers treat it identically.
    wc.send(IPC.event, {
      type: "connection-state",
      state: this.deps.client.connectionState,
    });
  }

  /**
   * Handle a renderer's IPC.ack: validate at the trust boundary and forward the
   * released byte count to the bridge's backpressure accounting.
   */
  ack(event: IpcMainEventLike, arg: unknown): void {
    // An ack from a page that has ended releases nothing: its bytes were
    // released with its peer.
    if (!sentByLivePage(event)) return;
    const state = this.senders.get(event.sender);
    if (state === undefined) return;
    // [LAW:single-enforcer] Validation happens at the IPC trust boundary.
    // Bad acks from a compromised renderer are dropped silently — they can
    // only starve the renderer that sent them, never reach tmux.
    const ack = (() => {
      try {
        return parseAckMessage(arg);
      } catch {
        return null;
      }
    })();
    if (ack === null) return;
    this.deps.bridge.ackOutput(state.peer, ack.paneId, ack.bytes);
  }

  /**
   * Handle a renderer's IPC.unregister. An unregister from a page that has
   * ended must not tear down the page shown now.
   */
  unregister(event: IpcMainEventLike): void {
    if (!sentByLivePage(event)) return;
    this.teardown(event.sender);
  }

  /**
   * Tear this sender down through the single unified path. Idempotent: a noop
   * when the sender is already gone, so a double-firing renderer cannot
   * decrement refcounts twice.
   */
  teardown(wc: WebContentsLike): void {
    const state = this.senders.get(wc);
    if (state === undefined) return;
    this.senders.delete(wc);

    // (0) Detach the page listeners. A page-end one that fired has already
    //     been removed by `once`; the rest would otherwise fire later against
    //     the next page — see SenderState.onPageEnd.
    for (const e of PAGE_END_EVENTS) {
      state.wc.removeListener(e, state.onPageEnd);
    }
    state.wc.removeListener("did-fail-load", state.onLoadFailed);

    // (1) Flag in-flight invokes for this sender aborted. The TmuxClient FIFO
    //     stays intact — the underlying %begin/%end still resolves the pending
    //     entry in order — but the invoke pipeline observes the abort and
    //     returns a BRIDGE_ABORTED envelope instead of delivering to a page
    //     that is gone. The pipeline created these entries; teardown decides the
    //     sender's fate in one place.
    for (const p of state.pending) p.aborted = true;

    // (2) Detach the per-renderer byte forwarder so no further bytes are
    //     routed to this renderer's sink from the substrate.
    state.detachBytes?.();

    // (3) Drop helper-side accounting + subscription refcounts in one call.
    //     bridge.removePeer fires setPaneAction(Continue) for any pane this
    //     sender's outstanding bytes were keeping paused, and unsubscribes
    //     from tmux for any subscription this sender was the last owner of.
    this.deps.bridge.removePeer(state.peer);
  }

  /** Tear down every sender (dispose path). */
  teardownAll(): void {
    for (const wc of [...this.senders.keys()]) this.teardown(wc);
  }

  // -------------------------------------------------------------------------
  // Event fan-out.
  //
  // The mechanism: send a message to every subscribed renderer on IPC.event.
  // The forwarding *policy* (which messages reach which renderer) is the
  // bridge's routeEvent/deliversTo; this method only fans out on its verdict.
  // [LAW:dataflow-not-control-flow]
  // -------------------------------------------------------------------------

  broadcast(msg: EmitterMessage): void {
    // Snapshot the senders entries before iterating: teardown below calls
    // senders.delete(wc), and a destroyed wc detected mid-loop must not perturb
    // the iteration order of the rest of the senders.
    const snapshot = [...this.senders];
    // [LAW:single-enforcer] The bridge decides which events reach which peer;
    // the message is classified once, then checked per peer.
    const route = this.deps.bridge.routeEvent(msg);
    for (const [wc, state] of snapshot) {
      // [LAW:no-defensive-null-guards] isDestroyed is a trust-boundary check:
      // Electron may fire "destroyed" asynchronously, so a send could race a
      // teardown. Guarding here avoids a native crash inside wc.send.
      if (wc.isDestroyed()) {
        this.teardown(wc);
        continue;
      }
      if (!state.isSubscribed) continue;
      if (!this.deps.bridge.deliversTo(state.peer, route)) continue;
      wc.send(IPC.event, msg);
    }
  }
}
