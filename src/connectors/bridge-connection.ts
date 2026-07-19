// src/connectors/bridge-connection.ts
// Transport-agnostic per-peer bookkeeping for tmux-control-mode bridges.
//
// [LAW:decomposition] This module is the thin FAÇADE composing two ledgers with
// zero overlapping invariants, each keyed on the shared `Peer` token:
//   - SubscriptionLedger (../subscription-ledger.ts): subscription ownership +
//     per-name refcount + inflight-promise race handling, so tmux only sees
//     `subscribe(name, what, format)` on the first peer that asks and
//     `unsubscribe(name)` when the last one drops it.
//   - BackpressureLedger (../backpressure-ledger.ts): per-peer per-pane
//     outstanding-byte accounting + the watermark loop that pauses / resumes
//     panes via `client.setPaneAction(...)` based on the SUM of outstanding
//     bytes across every peer subscribed to a pane.
// The façade owns only the peer roster (token allocation + lifecycle) and wires
// each public method to the ledger that owns it. It holds no ledger state.
//
// Why this bookkeeping is shared across transports:
//   - The Electron bridge already implemented all of it inline; the WebSocket
//     bridge never had any of it. Lifting the bookkeeping into one place is the
//     only structural fix — re-implementing it on the WS side would just
//     guarantee the same drift.
//
// What this module does NOT own:
//   - Wire encoding (Electron IPC envelopes vs. WS JSON/binary frames).
//   - Trust-boundary validation of inbound payloads (parseRpcRequest in
//     ../rpc.ts is the single enforcer for that).
//   - Peer lifecycle plumbing (Electron's WebContents.destroyed wiring, WS's
//     close-frame + heartbeat handling). The transport drives the
//     `registerPeer` / `removePeer` calls — this module is a passive map.
//
// [LAW:one-source-of-truth] Per-peer state lives in the ledgers; transports hold
// a `Peer` token returned by `registerPeer` and pass it back on every subsequent
// call. The token is the canonical handle; each ledger keeps its own slice of
// that peer's state and drops it on `removePeer`.

import type { CommandResponse } from "../protocol/types.js";

import type { TmuxClient } from "../client.js";

import type { Peer } from "./bridge-peer.js";
import { SubscriptionLedger } from "./subscription-ledger.js";
import {
  BackpressureLedger,
  type ResumeFailure,
} from "./backpressure-ledger.js";

export type { Peer } from "./bridge-peer.js";
export type { ResumeFailure } from "./backpressure-ledger.js";
export {
  DEFAULT_OUTPUT_HIGH_WATERMARK,
  DEFAULT_OUTPUT_LOW_WATERMARK,
} from "./backpressure-ledger.js";

export interface BridgeConnectionOptions {
  readonly client: TmuxClient;
  readonly outputHighWatermark?: number;
  readonly outputLowWatermark?: number;
  /**
   * Surface a resume failure that stranded a LIVE pane paused. REQUIRED — a
   * bridge that could silently drop such a failure must not be constructible.
   * [LAW:no-silent-failure] There is deliberately no default no-op: a default
   * would let every caller reintroduce the swallowed strand this seam removes.
   * The transport decides where the report goes (its own observability channel);
   * whether a host observes that channel is the host's informed choice.
   */
  readonly reportResumeFailure: (failure: ResumeFailure) => void;
}

// ---------------------------------------------------------------------------
// BridgeConnection
// ---------------------------------------------------------------------------

export interface BridgeConnection {
  /** Allocate a peer token. Caller stores it and passes it back on every
   *  subsequent call referring to that peer. */
  registerPeer(): Peer;

  /** Drop every refcount and outstanding-byte slot this peer owned. Resumes
   *  any panes that were paused only because of this peer's lag. Idempotent
   *  — second call against an unknown peer is a no-op. */
  removePeer(peer: Peer): void;

  /**
   * Forward a `subscribeRaw` RPC through the bridge. Every helper-managed peer
   * subscribes through here, never directly through `client.subscribeRaw`.
   *
   * Behavior:
   *   - First peer to claim `name` writes the canonical `(what, format)`
   *     and forwards `client.subscribeRaw(name, what, format)` to tmux.
   *   - Subsequent peers claiming the same name with MATCHING `(what, format)`
   *     just bump the refcount; the helper synthesizes a success response so
   *     tmux is not asked twice.
   *   - A peer claiming an existing name with DIFFERENT `(what, format)`
   *     is rejected with `BRIDGE_SUBSCRIPTION_FORMAT_CONFLICT`. Silently
   *     overwriting tmux's binding would change the wire format observed by
   *     prior subscribers — to update a subscription, unsubscribe first.
   *   - A peer re-subscribing a name it already owns with the same
   *     `(what, format)` is a no-op (refcount already includes it).
   */
  subscribeForPeer(
    peer: Peer,
    name: string,
    what: string,
    format: string,
  ): Promise<CommandResponse>;

  /**
   * Forward an `unsubscribe` RPC through the bridge.
   *
   * - A peer that does not own `name` is rejected with
   *   `BRIDGE_UNKNOWN_SUBSCRIPTION` — preventing one connection from tearing
   *   down another connection's subscriptions.
   * - When the LAST owner drops the name, `client.unsubscribe(name)` is
   *   forwarded to tmux. Otherwise the helper synthesizes success.
   */
  unsubscribeForPeer(peer: Peer, name: string): Promise<CommandResponse>;

  /**
   * Account `bytes` of pane output sent to `peer` for `paneId`. The transport
   * calls this around the actual send. When the per-pane sum across all
   * peers crosses `outputHighWatermark`, the helper fires
   * `client.setPaneAction(paneId, Pause)` exactly once.
   */
  accountOutput(peer: Peer, paneId: number, bytes: number): void;

  /**
   * Apply an ack: peer reports it has consumed `bytes` for `paneId`. The
   * helper subtracts from the peer's outstanding tally and, when the per-pane
   * sum drops below `outputLowWatermark`, fires
   * `client.setPaneAction(paneId, Continue)` exactly once.
   *
   * Negative or oversized acks are clamped to the peer's current outstanding
   * — bad acks can only starve the peer that sent them, never confuse the
   * shared bookkeeping.
   */
  ackOutput(peer: Peer, paneId: number, bytes: number): void;

  /**
   * Zero this peer's outstanding bytes for every pane and resume any pane
   * whose remaining sum (across surviving peers) drops below the low
   * watermark. Used by transports whose underlying drain signal is
   * connection-wide rather than per-pane — notably the WebSocket bridge,
   * which observes `ws.bufferedAmount` reaching zero as the only available
   * "everything I sent has been flushed" signal.
   *
   * Per-pane accounting is preserved for other peers; this clears just the
   * caller's slice. The `Peer` token returned by `registerPeer` is the only
   * thing that can identify a peer's slice — defense in depth against a
   * transport bug that would otherwise zero everyone.
   */
  clearPeerOutstanding(peer: Peer): void;

  /**
   * Tear down every peer through `removePeer`, then resume any panes the
   * helper had paused so tmux is not left stuck. After this call the helper
   * holds no peers, no refcounts, and no paused-pane state. Used by the
   * Electron bridge's `dispose()` and the WS bridge's shutdown path.
   */
  dispose(): void;
}

export function createBridgeConnection(
  opts: BridgeConnectionOptions,
): BridgeConnection {
  const { client, reportResumeFailure } = opts;

  // Construct the backpressure ledger first: its constructor is the single
  // enforcer of watermark-config validity and throws `BRIDGE_INVALID_ARG` on
  // bad input, so an invalid config fails createBridgeConnection before any
  // peer state or transport event listener is wired.
  const backpressure = new BackpressureLedger({
    client,
    outputHighWatermark: opts.outputHighWatermark,
    outputLowWatermark: opts.outputLowWatermark,
    reportResumeFailure,
  });
  const subscription = new SubscriptionLedger({ client });

  // [LAW:one-source-of-truth] The roster of live peer tokens. Registration and
  // teardown touch the roster and both ledgers together, so a peer is either
  // live in all three or absent from all three — there is no drift surface.
  const peers = new Set<Peer>();
  let nextPeerId = 1;

  // Closure-scoped so both the returned object's `removePeer` member and
  // `dispose` reference it directly. A destructured `const { dispose } =
  // bridge; dispose();` would otherwise lose its `this` binding and
  // silently no-op the teardown loop.
  const removePeer = (peer: Peer): void => {
    if (!peers.has(peer)) return;
    peers.delete(peer);
    // Outstanding-release FIRST (resumes panes whose remaining sum drops below
    // the low watermark), THEN subscription-release (last-owner unsubscribe) —
    // the two are independent tmux commands; this preserves the original order.
    backpressure.releasePeer(peer);
    subscription.releasePeer(peer);
  };

  return {
    registerPeer(): Peer {
      const peer: Peer = { id: nextPeerId++ };
      peers.add(peer);
      subscription.register(peer);
      backpressure.register(peer);
      return peer;
    },

    removePeer,

    subscribeForPeer(peer, name, what, format) {
      return subscription.subscribe(peer, name, what, format);
    },

    unsubscribeForPeer(peer, name) {
      return subscription.unsubscribe(peer, name);
    },

    accountOutput(peer, paneId, bytes) {
      backpressure.account(peer, paneId, bytes);
    },

    ackOutput(peer, paneId, bytes) {
      backpressure.ack(peer, paneId, bytes);
    },

    clearPeerOutstanding(peer) {
      backpressure.clearPeer(peer);
    },

    dispose(): void {
      // [LAW:single-enforcer] One peer-teardown path: dispose tears every peer
      // down through the same `removePeer` closure the returned object exposes,
      // so a future change to refcount / outstanding semantics lands in exactly
      // one place. [LAW:locality-or-seam] It calls the closure-scoped
      // `removePeer` (not `this.removePeer`) so a destructured
      // `const { dispose } = bridge; dispose();` still tears down correctly.
      for (const peer of [...peers]) removePeer(peer);
      // Final defense: removePeer's resume already fired a Continue for every
      // pane whose sum reached zero. Flush the panes NOT already being resumed
      // so a programming error that left one stranded still gets a Continue,
      // without double-sending one already in flight.
      backpressure.flushPausedPanes();
    },
  };
}
