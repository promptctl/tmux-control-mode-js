// src/connectors/bridge-connection.ts
// Transport-agnostic per-peer bookkeeping for tmux-control-mode bridges.
//
// What this module owns:
//   - Subscription ownership (who asked for "name") + a per-name refcount, so
//     tmux only sees `subscribe(name, what, format)` on the first peer that
//     asks and `unsubscribe(name)` when the last one drops it.
//   - Per-peer per-pane outstanding-bytes accounting and a watermark loop
//     that pauses / resumes panes via `client.setPaneAction(...)` based on
//     the SUM of outstanding bytes across every peer subscribed to a pane.
//   - A single teardown path (`removePeer`) that decrements every refcount
//     this peer held, drops its outstanding accounting, and resumes any
//     panes that were paused only because of this peer's lag.
//
// Why this is shared:
//   - The Electron bridge already implemented all of the above inline in
//     `electron/main.ts` (audit fix H7 + C4 watermark). The WebSocket bridge
//     never had any of it (audit findings C2/C3). Lifting the bookkeeping
//     into one place is the only structural fix — re-implementing it on the
//     WS side would just guarantee the same drift the audit caught.
//
// What this module does NOT own:
//   - Wire encoding (Electron IPC envelopes vs. WS JSON/binary frames).
//   - Trust-boundary validation of inbound payloads (parseRpcRequest in
//     ../rpc.ts is the single enforcer for that).
//   - Peer lifecycle plumbing (Electron's WebContents.destroyed wiring,
//     WS's close-frame + heartbeat handling). The transport drives the
//     `registerPeer` / `removePeer` calls — this module is a passive map.
//
// [LAW:single-enforcer] Subscription refcount + watermark logic exists in
// EXACTLY one source file. Both transports compose it; neither re-implements
// the bookkeeping. A grep for `subscriptionRefcount` should turn up exactly
// one definition site.
// [LAW:one-source-of-truth] Per-peer state lives in this module; transports
// hold a `Peer` token returned by `registerPeer` and pass it back on every
// subsequent call. The map is the canonical record of who owns what.
// [LAW:dataflow-not-control-flow] Pause/resume decisions are pure functions
// of the `outstanding` map; the same accountOutput / ackOutput pipeline runs
// every time and the data (the per-pane sum) decides whether setPaneAction
// fires.

import type { TmuxClient } from "../client.js";
import { PaneAction, type CommandResponse } from "../protocol/types.js";

import { BridgeError } from "./errors.js";

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Default per-pane high watermark (1 MiB summed across peers). */
export const DEFAULT_OUTPUT_HIGH_WATERMARK = 1 << 20;
/** Default per-pane low watermark (256 KiB summed across peers). */
export const DEFAULT_OUTPUT_LOW_WATERMARK = 1 << 18;

export interface BridgeConnectionOptions {
  readonly client: TmuxClient;
  readonly outputHighWatermark?: number;
  readonly outputLowWatermark?: number;
}

// ---------------------------------------------------------------------------
// Peer token
//
// A `Peer` is an opaque per-connection handle returned by registerPeer and
// passed back into every subsequent helper call. Transports never read its
// fields; the helper uses object identity as the Map key. Using an opaque
// token instead of a transport-specific value (a WebContents reference, a
// WebSocket reference, a string id) keeps the helper completely structural.
// ---------------------------------------------------------------------------

export interface Peer {
  /** Stable id, only useful for logging / debugging. Unique per helper. */
  readonly id: number;
}

interface PeerState {
  readonly peer: Peer;
  readonly subscriptions: Set<string>;
  readonly outstanding: Map<number, number>;
}

interface SubscriptionRecord {
  /** Canonical (what, format) for this name — set by the first subscriber. */
  readonly what: string;
  readonly format: string;
  /** Peers currently holding this name (refcount = owners.size). */
  readonly owners: Set<Peer>;
  /**
   * The in-flight `client.subscribeRaw` promise for the FIRST subscriber that
   * created this record. Cleared to `undefined` once the call settles.
   * While present, concurrent subscribers with a matching `(what, format)`
   * AWAIT this promise before claiming ownership — never short-circuit to
   * a synthesized OK based on an optimistic record. This closes a race
   * where a concurrent peer would otherwise resolve OK before tmux has
   * confirmed the binding, and a subsequent tmux rejection on the first
   * call would leave the second peer holding a phantom subscription.
   */
  inflight: Promise<CommandResponse> | undefined;
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
  const { client } = opts;
  const high = opts.outputHighWatermark ?? DEFAULT_OUTPUT_HIGH_WATERMARK;
  const low = opts.outputLowWatermark ?? DEFAULT_OUTPUT_LOW_WATERMARK;
  // [LAW:single-enforcer] Shared validation site: invalid watermark config
  // is rejected at construction so both transports surface the same error
  // shape (`BRIDGE_INVALID_ARG`) without each one re-implementing the check.
  if (!(high > low && low >= 0)) {
    throw new BridgeError(
      "BRIDGE_INVALID_ARG",
      `outputHighWatermark (${high}) must be > outputLowWatermark (${low}) >= 0`,
    );
  }

  const peers = new Map<Peer, PeerState>();
  const subscriptions = new Map<string, SubscriptionRecord>();
  const pausedPanes = new Set<number>();
  let nextPeerId = 1;

  // Fire-and-forget pause/continue/unsubscribe — tmux's response carries no
  // actionable information at this layer; a rejection means the pane or
  // subscription already went away, which is fine on cleanup paths.
  const swallow = (): void => undefined;

  const totalOutstanding = (paneId: number): number => {
    let sum = 0;
    for (const s of peers.values()) sum += s.outstanding.get(paneId) ?? 0;
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

  // Synthesized success response for refcounted no-op operations. command
  // number -1 makes the synthetic origin obvious in any logging that surfaces
  // the response.
  const synthesizeOk = (): CommandResponse => ({
    commandNumber: -1,
    timestamp: Date.now(),
    success: true,
    output: [],
  });

  const releaseName = (name: string, peer: Peer): boolean => {
    const rec = subscriptions.get(name);
    if (rec === undefined) return false;
    rec.owners.delete(peer);
    if (rec.owners.size === 0) {
      subscriptions.delete(name);
      return true;
    }
    return false;
  };

  // [LAW:dataflow-not-control-flow] Concurrent subscribes to the same
  // name share fate via a single `inflight` promise stored on the record.
  // The first subscriber installs the record + issues client.subscribeRaw;
  // subsequent peers with a matching (what, format) AWAIT that promise
  // before claiming ownership. If tmux rejects, every queued peer sees
  // the same rejection — no peer is left holding a phantom subscription.
  const subscribeForPeerImpl = async (
    peer: Peer,
    name: string,
    what: string,
    format: string,
  ): Promise<CommandResponse> => {
    const state = peers.get(peer);
    if (state === undefined) {
      throw new BridgeError(
        "BRIDGE_INTERNAL",
        "subscribeForPeer called for a peer that is not registered",
      );
    }
    const existing = subscriptions.get(name);
    if (existing !== undefined) {
      if (existing.what !== what || existing.format !== format) {
        throw new BridgeError(
          "BRIDGE_SUBSCRIPTION_FORMAT_CONFLICT",
          `subscription "${name}" is already held with a different ` +
            `(what, format) pair; unsubscribe first if you need to update it`,
        );
      }
      // Queue on the in-flight subscribe (if any). Awaiting here means a
      // tmux rejection on the first call rejects every queued peer too —
      // the same shape every async caller already handles. The first
      // call's catch path has cleared the record by the time we resume,
      // so success/failure is the only branch.
      if (existing.inflight !== undefined) {
        await existing.inflight;
      }
      // After settle, the record might still exist (success — the common
      // case) or have been deleted (failure — the await above already
      // propagated the rejection, so we never reach here in that case).
      // Claim ownership of the surviving record.
      if (!state.subscriptions.has(name)) {
        state.subscriptions.add(name);
        existing.owners.add(peer);
      }
      return synthesizeOk();
    }

    const inflight = client.subscribeRaw(name, what, format);
    const record: SubscriptionRecord = {
      what,
      format,
      owners: new Set([peer]),
      inflight,
    };
    subscriptions.set(name, record);
    state.subscriptions.add(name);
    try {
      const response = await inflight;
      record.inflight = undefined;
      return response;
    } catch (err) {
      // Rollback: tmux refused to install the subscription. Drop the
      // ENTIRE record (and every owner who optimistically joined while
      // the call was in flight) so the system stays consistent. Any peer
      // still awaiting `inflight` will see the same rejection re-thrown.
      record.inflight = undefined;
      for (const owner of record.owners) {
        const ownerState = peers.get(owner);
        ownerState?.subscriptions.delete(name);
      }
      record.owners.clear();
      subscriptions.delete(name);
      throw err;
    }
  };

  // Closure-scoped so both the returned object's `removePeer` member and
  // `dispose` reference it directly. A destructured `const { dispose } =
  // bridge; dispose();` would otherwise lose its `this` binding and
  // silently no-op the teardown loop.
  const removePeerImpl = (peer: Peer): void => {
    const state = peers.get(peer);
    if (state === undefined) return;
    peers.delete(peer);

    // (1) Drop outstanding bytes; resume panes whose remaining sum (across
    //     surviving peers) drops below the low watermark.
    const paneIds = [...state.outstanding.keys()];
    state.outstanding.clear();
    for (const paneId of paneIds) maybeResume(paneId);

    // (2) Refcount-decrement every subscription this peer held. Last-owner
    //     transitions fire client.unsubscribe.
    for (const name of state.subscriptions) {
      const lastOwner = releaseName(name, peer);
      if (lastOwner) void client.unsubscribe(name).catch(swallow);
    }
    state.subscriptions.clear();
  };

  return {
    registerPeer(): Peer {
      const peer: Peer = { id: nextPeerId++ };
      peers.set(peer, {
        peer,
        subscriptions: new Set(),
        outstanding: new Map(),
      });
      return peer;
    },

    removePeer: removePeerImpl,

    subscribeForPeer: subscribeForPeerImpl,

    async unsubscribeForPeer(
      peer: Peer,
      name: string,
    ): Promise<CommandResponse> {
      const state = peers.get(peer);
      if (state === undefined) {
        throw new BridgeError(
          "BRIDGE_INTERNAL",
          "unsubscribeForPeer called for a peer that is not registered",
        );
      }
      if (!state.subscriptions.has(name)) {
        throw new BridgeError(
          "BRIDGE_UNKNOWN_SUBSCRIPTION",
          `peer does not own subscription "${name}" (this prevents one ` +
            `connection from tearing down another's subscriptions)`,
        );
      }
      // [LAW:one-source-of-truth] If the original subscribe is still in
      // flight, queued joiners are awaiting the same `inflight` promise and
      // have not yet claimed ownership in `record.owners`. Releasing this
      // peer before the joiners' post-await blocks run would let the
      // last-owner check fire too early, deleting the record from
      // `subscriptions` while joiners still mutate `state.subscriptions`
      // — the joiners would end up with phantom entries pointing at a
      // detached record. Awaiting `inflight` and yielding one microtask
      // lets every queued `subscribeForPeer` continuation run first, so by
      // the time `releaseName` runs the owner set reflects post-join state.
      const rec = subscriptions.get(name);
      if (rec !== undefined && rec.inflight !== undefined) {
        try {
          await rec.inflight;
        } catch {
          // Subscribe rejection rolls back the record (see
          // subscribeForPeerImpl's catch); the peer's `state.subscriptions`
          // entry is cleared as part of that rollback. The re-check below
          // sees an empty state and returns synthesized OK — the bridge
          // never installed the binding, so no `client.unsubscribe` is owed.
        }
        // Yield once more so any joiner whose continuation was queued AFTER
        // this await still gets to claim ownership before we evaluate
        // last-owner. Microtask ordering is FIFO; this drain is the cheap
        // correctness anchor that makes the ordering observable to us.
        await Promise.resolve();
      }
      // Re-check after the await — rollback or a peer dispose during the
      // wait may have already cleared this peer's slot.
      if (!state.subscriptions.has(name)) {
        return synthesizeOk();
      }
      state.subscriptions.delete(name);
      const lastOwner = releaseName(name, peer);
      if (lastOwner) return client.unsubscribe(name);
      return synthesizeOk();
    },

    accountOutput(peer: Peer, paneId: number, bytes: number): void {
      const state = peers.get(peer);
      if (state === undefined) return;
      if (bytes <= 0) return;
      const prev = state.outstanding.get(paneId) ?? 0;
      state.outstanding.set(paneId, prev + bytes);
      maybePause(paneId);
    },

    ackOutput(peer: Peer, paneId: number, bytes: number): void {
      const state = peers.get(peer);
      if (state === undefined) return;
      if (bytes <= 0) return;
      const prev = state.outstanding.get(paneId) ?? 0;
      const next = Math.max(0, prev - bytes);
      if (next === 0) state.outstanding.delete(paneId);
      else state.outstanding.set(paneId, next);
      maybeResume(paneId);
    },

    clearPeerOutstanding(peer: Peer): void {
      const state = peers.get(peer);
      if (state === undefined) return;
      const paneIds = [...state.outstanding.keys()];
      state.outstanding.clear();
      // [LAW:dataflow-not-control-flow] Same maybeResume call as ackOutput;
      // only the data the helper sees on those panes (this peer's bytes
      // gone, others' remain) decides whether continue actually fires.
      for (const paneId of paneIds) maybeResume(paneId);
    },

    dispose(): void {
      // [LAW:single-enforcer] One peer-teardown path. dispose's body used
      // to inline a hand-written variant of removePeer; collapsing both
      // sites onto a single call removes a drift surface (a future change
      // to refcount semantics that lands in only one place would be a
      // real bug). The redundant per-pane maybeResume work removePeer
      // does is bounded by the number of paused panes — small.
      // [LAW:locality-or-seam] Calls the closure-scoped `removePeerImpl`
      // (not `this.removePeer`) so a destructured `const { dispose } =
      // bridge; dispose();` still tears down the helper correctly.
      for (const peer of [...peers.keys()]) removePeerImpl(peer);
      // Final defense: removePeer's maybeResume should have cleared every
      // entry from pausedPanes by now (totalOutstanding goes to 0 once the
      // last peer leaves), but flush unconditionally so a programming error
      // that left pausedPanes populated does not leave tmux stuck.
      for (const paneId of pausedPanes) {
        void client.setPaneAction(paneId, PaneAction.Continue).catch(swallow);
      }
      pausedPanes.clear();
    },
  };
}
