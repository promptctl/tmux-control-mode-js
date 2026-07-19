// src/connectors/subscription-ledger.ts
// [LAW:decomposition] Subscription ownership + per-name refcount, extracted
// from createBridgeConnection. This ledger's ONE invariant is: tmux sees
// `subscribe(name, what, format)` on the first peer that asks and
// `unsubscribe(name)` when the last one drops it. It shares nothing with the
// backpressure ledger except the opaque `Peer` token it indexes on.
//
// [LAW:single-enforcer] The subscription refcount lives in EXACTLY this file.
// Both transports (electron/main.ts, websocket/server.ts) compose the bridge;
// neither re-implements the bookkeeping. The refcount is
// `SubscriptionRecord.owners.size` — one Set per name, defined and mutated only
// here.
// [LAW:one-source-of-truth] Per-peer ownership is a bidirectional index kept in
// lockstep: `subscriptions` maps name → record (whose `owners` set is the
// refcount) and `ownedByPeer` maps peer → the names it holds. Every add/remove
// touches both; there is no third representation.

import { emptyKeysResponse, type CommandResponse } from "../protocol/types.js";
import {
  refreshClientSubscribe,
  refreshClientUnsubscribe,
} from "../protocol/encoder.js";
import type { TmuxConnection } from "../client.js";

import { BridgeError } from "./errors.js";
import type { Peer } from "./bridge-peer.js";

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

export interface SubscriptionLedgerDeps {
  /** Only `execute` is needed — the weakest sufficient view of the connection. */
  readonly client: Pick<TmuxConnection, "execute">;
}

export class SubscriptionLedger {
  private readonly subscriptions = new Map<string, SubscriptionRecord>();
  private readonly ownedByPeer = new Map<Peer, Set<string>>();

  constructor(private readonly deps: SubscriptionLedgerDeps) {}

  // Fire-and-forget on the genuinely-moot cleanup seam only: last-owner
  // unsubscribe during peer teardown. The subscribe/unsubscribe request paths
  // never swallow — they propagate tmux's rejection to the caller.
  private readonly swallow = (): void => undefined;

  /** Seed this peer's owned-names slot. Called once by the façade's
   *  `registerPeer`; presence of the slot is this ledger's registration truth. */
  register(peer: Peer): void {
    // [LAW:no-silent-failure] The façade mints a fresh `Peer` per registerPeer,
    // so a re-register is unreachable — but if it ever happened, a silent
    // `Map.set` overwrite would drop this peer's owned names without a trace.
    // Fail loud instead of overwriting.
    if (this.ownedByPeer.has(peer)) {
      throw new BridgeError(
        "BRIDGE_INTERNAL",
        `peer ${peer.id} is already registered with the subscription ledger`,
      );
    }
    this.ownedByPeer.set(peer, new Set());
  }

  private releaseName(name: string, peer: Peer): boolean {
    const rec = this.subscriptions.get(name);
    if (rec === undefined) return false;
    rec.owners.delete(peer);
    if (rec.owners.size === 0) {
      this.subscriptions.delete(name);
      return true;
    }
    return false;
  }

  /**
   * Forward a `subscribeRaw` RPC through the bridge.
   *
   * [LAW:dataflow-not-control-flow] Concurrent subscribes to the same name
   * share fate via a single `inflight` promise stored on the record. The first
   * subscriber installs the record + issues client.subscribeRaw; subsequent
   * peers with a matching (what, format) AWAIT that promise before claiming
   * ownership. If tmux rejects, every queued peer sees the same rejection — no
   * peer is left holding a phantom subscription.
   */
  async subscribe(
    peer: Peer,
    name: string,
    what: string,
    format: string,
  ): Promise<CommandResponse> {
    const owned = this.ownedByPeer.get(peer);
    if (owned === undefined) {
      throw new BridgeError(
        "BRIDGE_INTERNAL",
        "subscribe called for a peer that is not registered",
      );
    }
    const existing = this.subscriptions.get(name);
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
      // [LAW:one-source-of-truth] After the inflight settles, the record we
      // queued on may have been torn down WHILE we waited: a concurrent
      // last-owner `releasePeer` deletes it from `subscriptions` and fires the
      // tmux unsubscribe, even though our await resolved OK (the failure case
      // rethrows above and never reaches here). Claiming ownership on that
      // detached record would strand us with a phantom — a `name` in
      // `ownedByPeer` with no record in `subscriptions` — so we would believe
      // we are subscribed while tmux, having unsubscribed, sends us nothing.
      // Re-check record identity; if it was superseded, retry from the top so
      // we either join the live record or become a fresh first owner. (When no
      // await happened the map is unchanged and this is trivially true.)
      if (this.subscriptions.get(name) !== existing) {
        return this.subscribe(peer, name, what, format);
      }
      // Claim ownership of the surviving record.
      if (!owned.has(name)) {
        owned.add(name);
        existing.owners.add(peer);
      }
      return emptyKeysResponse();
    }

    const inflight = this.deps.client.execute(
      refreshClientSubscribe(name, what, format),
    );
    const record: SubscriptionRecord = {
      what,
      format,
      owners: new Set([peer]),
      inflight,
    };
    this.subscriptions.set(name, record);
    owned.add(name);
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
        this.ownedByPeer.get(owner)?.delete(name);
      }
      record.owners.clear();
      this.subscriptions.delete(name);
      throw err;
    }
  }

  /**
   * Forward an `unsubscribe` RPC through the bridge.
   *
   * - A peer that does not own `name` is rejected with
   *   `BRIDGE_UNKNOWN_SUBSCRIPTION` — preventing one connection from tearing
   *   down another connection's subscriptions.
   * - When the LAST owner drops the name, `client.unsubscribe(name)` is
   *   forwarded to tmux. Otherwise a synthesized success is returned.
   */
  async unsubscribe(peer: Peer, name: string): Promise<CommandResponse> {
    const owned = this.ownedByPeer.get(peer);
    if (owned === undefined) {
      throw new BridgeError(
        "BRIDGE_INTERNAL",
        "unsubscribe called for a peer that is not registered",
      );
    }
    if (!owned.has(name)) {
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
    // `subscriptions` while joiners still mutate their owned sets — the
    // joiners would end up with phantom entries pointing at a detached
    // record. Awaiting `inflight` and yielding one microtask lets every
    // queued `subscribe` continuation run first, so by the time
    // `releaseName` runs the owner set reflects post-join state.
    const rec = this.subscriptions.get(name);
    if (rec !== undefined && rec.inflight !== undefined) {
      try {
        await rec.inflight;
      } catch {
        // Subscribe rejection rolls back the record (see subscribe's catch);
        // this peer's owned-set entry is cleared as part of that rollback.
        // The re-check below sees an empty slot and returns synthesized OK —
        // the bridge never installed the binding, so no `client.unsubscribe`
        // is owed.
      }
      // Yield once more so any joiner whose continuation was queued AFTER
      // this await still gets to claim ownership before we evaluate
      // last-owner. Microtask ordering is FIFO; this drain is the cheap
      // correctness anchor that makes the ordering observable to us.
      await Promise.resolve();
    }
    // Re-check after the await — rollback or a peer teardown during the
    // wait may have already cleared this peer's slot.
    if (!owned.has(name)) {
      return emptyKeysResponse();
    }
    owned.delete(name);
    const lastOwner = this.releaseName(name, peer);
    if (lastOwner) {
      return this.deps.client.execute(refreshClientUnsubscribe(name));
    }
    return emptyKeysResponse();
  }

  /**
   * Refcount-decrement every subscription this peer held; last-owner
   * transitions fire `client.unsubscribe`. Idempotent — a peer with no slot
   * (never registered, or already released) is a no-op.
   */
  releasePeer(peer: Peer): void {
    const owned = this.ownedByPeer.get(peer);
    if (owned === undefined) return;
    this.ownedByPeer.delete(peer);
    for (const name of owned) {
      const lastOwner = this.releaseName(name, peer);
      if (lastOwner) {
        void this.deps.client
          .execute(refreshClientUnsubscribe(name))
          .catch(this.swallow);
      }
    }
  }

  /**
   * Tear down every peer this ledger holds (last-owner unsubscribes fire). The
   * ledger owns its own peer roster, so the composing façade fans `dispose`
   * out to here rather than tracking a separate peer set. [LAW:one-source-of-truth]
   */
  dispose(): void {
    for (const peer of [...this.ownedByPeer.keys()]) this.releasePeer(peer);
  }
}
