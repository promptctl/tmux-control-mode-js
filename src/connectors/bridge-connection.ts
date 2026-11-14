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
import { isCrossSessionLayoutRelayFrame } from "../cross-session-layout-messages.js";
import {
  eventSubject,
  type EmitterMessage,
  type EventSubject,
  type MessageAbout,
} from "../emitter.js";

import type { Peer } from "./bridge-peer.js";
import type { BridgeError } from "./errors.js";
import { SubscriptionLedger } from "./subscription-ledger.js";
import { CrossSessionLayoutLedger } from "./cross-session-layout-ledger.js";
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

export interface BridgeConnectionOptions<L extends boolean = boolean> {
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
  /**
   * Surface a departed peer's cross-session layout release that a live tmux
   * refused. REQUIRED for the same reason as `reportResumeFailure`.
   */
  readonly reportCoverageReleaseFailure: (error: BridgeError) => void;
  /**
   * Whether the client's connection lifecycle ({@link LifecycleMessage})
   * crosses to peers. A transport fact: the Electron renderer mirrors the
   * main client's connection from these events; a WS peer has a connection of
   * its own and learns its state from its own socket and welcome handshake.
   */
  readonly forwardsLifecycle: L;
}

// ---------------------------------------------------------------------------
// BridgeConnection
// ---------------------------------------------------------------------------

export interface BridgeConnection<L extends boolean = boolean> {
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
   * Turn on cross-session layout coverage for this peer: the shared client
   * holds one `enableCrossSessionLayoutChange` reference on the peer's behalf
   * while it has enables outstanding. Counted per call, like `TmuxClient`.
   */
  enableCrossSessionLayoutForPeer(peer: Peer): Promise<void>;

  /** Undo one of this peer's enables. A no-op for a peer with none outstanding. */
  disableCrossSessionLayoutForPeer(peer: Peer): Promise<void>;

  /**
   * Who `msg` crosses the bridge to. Classify once per event, then ask
   * `deliversTo` per peer. Facts about the shared tmux stream (its messages
   * and the `reply-stream` reports) reach every peer; the decoded
   * `cross-session-layout-*` events reach only peers with coverage enabled;
   * lifecycle events reach peers only on transports built with
   * `forwardsLifecycle`; `topology-error` and the relay's raw
   * `%subscription-changed` frames reach no peer.
   * [LAW:single-enforcer] Both transports route every event through this.
   */
  routeEvent(msg: EmitterMessage): EventRoute;

  /**
   * Whether an event routed `route` reaches `peer`. A `true` answer narrows
   * `route` to what this transport can deliver, so a WS server (built with
   * `forwardsLifecycle: false`) holds only wire-shaped messages afterwards.
   */
  deliversTo(peer: Peer, route: EventRoute): route is DeliveredRoute<L>;

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
   * sum drops to or below `outputLowWatermark`, fires
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

/** Events about the client's one connection (connection-state, reconnected). */
export type LifecycleMessage = MessageAbout<"lifecycle">;

// [LAW:types-are-the-program] A route's kind is what its message is about, and
// it carries the message already narrowed, so a transport encodes `route.msg`
// with no runtime re-check.
export type EventRoute =
  | { readonly kind: "none" }
  | {
      [S in EventSubject]: {
        readonly kind: S;
        readonly msg: MessageAbout<S>;
      };
    }[EventSubject];

/** The routes a bridge built with `forwardsLifecycle: L` can deliver. */
export type DeliveredRoute<L extends boolean> = Extract<
  EventRoute,
  {
    readonly kind:
      | "tmux"
      | "reply-stream"
      | "cross-session-layout"
      | (L extends true ? "lifecycle" : never);
  }
>;

const NO_ROUTE: EventRoute = { kind: "none" };

export function createBridgeConnection<L extends boolean>(
  opts: BridgeConnectionOptions<L>,
): BridgeConnection<L> {
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
  const crossSessionLayout = new CrossSessionLayoutLedger({
    client,
    reportReleaseFailure: opts.reportCoverageReleaseFailure,
  });

  // [LAW:one-source-of-truth] The façade holds NO peer roster of its own — each
  // ledger is the single source of truth for its own peers (keyed by the shared
  // `Peer` token) and owns their teardown. This closure keeps only the token
  // counter; every peer-scoped call is pure fan-out to the two ledgers.
  let nextPeerId = 1;

  return {
    registerPeer(): Peer {
      const peer: Peer = { id: nextPeerId++ };
      subscription.register(peer);
      backpressure.register(peer);
      crossSessionLayout.register(peer);
      return peer;
    },

    removePeer(peer: Peer): void {
      // Idempotent: both `releasePeer` methods no-op on a peer they don't hold,
      // so a second call against an unknown peer does nothing — no roster guard
      // needed. Outstanding-release FIRST (resumes panes whose remaining sum
      // drops to or below the low watermark), THEN subscription-release
      // (last-owner unsubscribe); the two are independent tmux commands.
      backpressure.releasePeer(peer);
      subscription.releasePeer(peer);
      crossSessionLayout.releasePeer(peer);
    },

    subscribeForPeer(peer, name, what, format) {
      return subscription.subscribe(peer, name, what, format);
    },

    unsubscribeForPeer(peer, name) {
      return subscription.unsubscribe(peer, name);
    },

    enableCrossSessionLayoutForPeer(peer) {
      return crossSessionLayout.enable(peer);
    },

    disableCrossSessionLayoutForPeer(peer) {
      return crossSessionLayout.disable(peer);
    },

    routeEvent(msg): EventRoute {
      if (isCrossSessionLayoutRelayFrame(msg)) return NO_ROUTE;
      // [LAW:types-are-the-program] exception: `eventSubject` is the one
      // classification and `msg` is about the subject it returns, but TS
      // cannot correlate the two, so the pairing is asserted here once.
      return { kind: eventSubject(msg), msg } as EventRoute;
    },

    // [LAW:single-enforcer] The one place a subject meets its delivery rule.
    deliversTo(peer, route): route is DeliveredRoute<L> {
      switch (route.kind) {
        case "none":
        case "pane-table":
          return false;
        case "tmux":
        case "reply-stream":
          return true;
        case "cross-session-layout":
          return crossSessionLayout.isEnabled(peer);
        case "lifecycle":
          return opts.forwardsLifecycle;
      }
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
      // [LAW:decomposition] Each ledger tears down its own peers: the backpressure
      // ledger releases every peer (resuming drained panes) then flushes any pane
      // still paused, and the subscription ledger releases every peer (firing
      // last-owner unsubscribes). The façade owns no roster to iterate — it fans
      // out to the two owners. `dispose` closes over the ledger locals, so a
      // destructured `const { dispose } = bridge; dispose();` still works.
      backpressure.dispose();
      subscription.dispose();
      crossSessionLayout.dispose();
    },
  };
}
