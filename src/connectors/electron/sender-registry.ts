// src/connectors/electron/sender-registry.ts
// [LAW:decomposition] The set of registered renderers and their per-sender
// lifecycle, extracted from createMainBridge. Owns the senders Map, each
// SenderState, the per-renderer byte forwarder, subscription gating, and the
// event fan-out over senders. The wiring shell holds no sender state.
//
// [LAW:one-source-of-truth] One SenderState entry per renderer, and one `Peer`
// token per renderer registered with the shared BridgeConnection helper.
// `teardown` is the only path that releases both — subscription refcount,
// outstanding-byte accounting, byte forwarder, and destroyed-listener all drop
// together, in one place.
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
import { IPC, parseAckMessage, type WebContentsLike } from "./types.js";
import { WebContentsSink } from "./sink.js";

// ---------------------------------------------------------------------------
// Per-sender state.
//
// Subscription ownership, refcount, and outstanding-byte accounting all live
// inside the shared BridgeConnection helper, keyed by the `peer` token below.
// SenderState carries only what is electron-specific: the WebContents, the
// destroyed-listener handle, the isSubscribed flag that gates event forwarding,
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
   * The exact `destroyed` listener registered with `wc.once`. Stored so
   * `teardown` can call `wc.removeListener` when teardown is driven by
   * `unregister` instead of by the WebContents actually being destroyed —
   * otherwise the once-handler stays attached on a still-alive emitter,
   * fires later (as a no-op against a sender that no longer exists), and
   * keeps a closure-reference path alive on the emitter for the rest of
   * the WebContents's lifetime.
   */
  readonly onDestroyed: () => void;
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
    "registerPeer" | "removePeer" | "accountOutput" | "ackOutput"
  >;
  readonly client: Pick<TmuxClient, "attachBytesSink" | "connectionState">;
}

export class SenderRegistry {
  private readonly senders = new Map<WebContentsLike, SenderState>();

  constructor(private readonly deps: SenderRegistryDeps) {}

  /**
   * The SenderState for `wc`, creating it (and registering its peer + destroyed
   * handler) on first sight. Called by both `register` and the invoke pipeline,
   * so a renderer that only ever invoke()s — never register()s — still cleans up
   * when its webContents dies.
   */
  getOrCreate(wc: WebContentsLike): SenderState {
    const existing = this.senders.get(wc);
    if (existing !== undefined) return existing;
    // [LAW:single-enforcer] One destroyed-handler per sender. The handler is
    // stored on the sender so `teardown` can detach it when the unregister
    // path runs and wc is still alive.
    const onDestroyed = (): void => this.teardown(wc);
    const peer = this.deps.bridge.registerPeer();
    const state: SenderState = {
      wc,
      peer,
      isSubscribed: false,
      onDestroyed,
      pending: new Set(),
      detachBytes: null,
    };
    this.senders.set(wc, state);
    wc.once("destroyed", onDestroyed);
    return state;
  }

  /**
   * Handle a renderer's IPC.register: mark it subscribed, attach the per-peer
   * byte forwarder exactly once, and send the current connection-state snapshot
   * so a late-joining renderer has the lifecycle state immediately.
   */
  register(wc: WebContentsLike): void {
    const state = this.getOrCreate(wc);
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
    if (!wc.isDestroyed()) {
      wc.send(IPC.event, {
        type: "connection-state",
        state: this.deps.client.connectionState,
      });
    }
  }

  /**
   * Handle a renderer's IPC.ack: validate at the trust boundary and forward the
   * released byte count to the bridge's backpressure accounting.
   */
  ack(wc: WebContentsLike, arg: unknown): void {
    const state = this.senders.get(wc);
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
   * Tear this sender down through the single unified path. Idempotent: a noop
   * when the sender is already gone, so a double-firing renderer (or a late
   * `destroyed` after `unregister`) cannot decrement refcounts twice.
   */
  teardown(wc: WebContentsLike): void {
    const state = this.senders.get(wc);
    if (state === undefined) return;
    this.senders.delete(wc);

    // (0) Detach the destroyed handler. If we got here BECAUSE the wc was
    //     destroyed, removeListener is harmless (the listener has already
    //     fired and been removed by `once`). If we got here from unregister
    //     while the wc is still alive, this is the only thing that prevents
    //     a leaked listener on the emitter — see SenderState.onDestroyed.
    state.wc.removeListener("destroyed", state.onDestroyed);

    // (1) Flag in-flight invokes for this sender aborted. The TmuxClient FIFO
    //     stays intact — the underlying %begin/%end still resolves the pending
    //     entry in order — but the invoke pipeline observes the abort and
    //     returns a BRIDGE_ABORTED envelope instead of delivering to a dead
    //     webContents. The pipeline created these entries; teardown decides the
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
  // The forwarding *policy* (which messages cross the bridge) lives at the
  // shell's `client.on('*')` seam — this method fans out whatever it is given.
  // [LAW:dataflow-not-control-flow]
  // -------------------------------------------------------------------------

  broadcast(msg: EmitterMessage): void {
    // Snapshot the senders entries before iterating: teardown below calls
    // senders.delete(wc), and a destroyed wc detected mid-loop must not perturb
    // the iteration order of the rest of the senders.
    const snapshot = [...this.senders];
    for (const [wc, state] of snapshot) {
      // [LAW:no-defensive-null-guards] isDestroyed is a trust-boundary check:
      // Electron may fire "destroyed" asynchronously, so a send could race a
      // teardown. Guarding here avoids a native crash inside wc.send.
      if (wc.isDestroyed()) {
        this.teardown(wc);
        continue;
      }
      if (!state.isSubscribed) continue;
      wc.send(IPC.event, msg);
    }
  }
}
