// src/connectors/cross-session-layout-ledger.ts
// [LAW:decomposition] Which bridge peers asked for cross-session layout
// coverage. This ledger's ONE invariant: the shared TmuxClient holds exactly
// one `enableCrossSessionLayoutChange` reference per peer that enabled it, and
// gives that reference back when the peer disables or goes away. The relay
// behind the client ref-counts those references itself, so tmux sees one
// subscription however many peers enable.
//
// [LAW:one-source-of-truth] `peers` is the single record of who enabled:
// the bridge's event routing reads it (`isEnabled`) to decide which peers
// receive the decoded events, so delivery and the reference count cannot
// disagree.

import type { TmuxClient } from "../client.js";

import type { Peer } from "./bridge-peer.js";
import { BridgeError } from "./errors.js";

export interface CrossSessionLayoutLedgerDeps {
  readonly client: Pick<
    TmuxClient,
    "enableCrossSessionLayoutChange" | "disableCrossSessionLayoutChange"
  >;
}

// [LAW:types-are-the-program] One peer's coverage. `held` is present from the
// moment the peer asks, so an event landing while the enable is in flight
// already reaches it; `releasing` keeps delivering until the relay has the
// reference back, so delivery never stops ahead of the reference count.
type Coverage =
  | { readonly kind: "none" }
  | { readonly kind: "held"; readonly enabling: Promise<void> }
  | { readonly kind: "releasing"; readonly releasing: Promise<void> };

const NONE: Coverage = { kind: "none" };

export class CrossSessionLayoutLedger {
  // Registered peer → its coverage. Presence is this ledger's registration
  // truth, so a call for a removed peer cannot take a reference nothing
  // would give back.
  private readonly peers = new Map<Peer, Coverage>();

  // Fire-and-forget on the peer-teardown seam only, matching
  // SubscriptionLedger: the peer is gone, so there is no caller to report to.
  private readonly swallow = (): void => undefined;

  constructor(private readonly deps: CrossSessionLayoutLedgerDeps) {}

  register(peer: Peer): void {
    if (this.peers.has(peer)) {
      throw new BridgeError(
        "BRIDGE_INTERNAL",
        `peer ${peer.id} is already registered with the cross-session layout ledger`,
      );
    }
    this.peers.set(peer, NONE);
  }

  isEnabled(peer: Peer): boolean {
    const coverage = this.peers.get(peer);
    return coverage !== undefined && coverage.kind !== "none";
  }

  /** Idempotent per peer: a second enable from the same peer joins the first. */
  enable(peer: Peer): Promise<void> {
    const coverage = this.peers.get(peer);
    if (coverage === undefined) return unregistered(peer, "enable");
    switch (coverage.kind) {
      case "held":
        return coverage.enabling;
      case "releasing":
        // The release gives the old reference back whatever its outcome, so
        // the new reference is taken after it.
        return coverage.releasing.then(
          () => this.enable(peer),
          () => this.enable(peer),
        );
      case "none": {
        const enabling = this.deps.client.enableCrossSessionLayoutChange();
        const held: Coverage = { kind: "held", enabling };
        this.peers.set(peer, held);
        // A rejected enable counts for nothing (the relay already undid its
        // reference), so the peer holds nothing either.
        enabling.catch(() => this.settle(peer, held));
        return enabling;
      }
    }
  }

  /**
   * Idempotent per peer: disabling a peer that holds nothing is a no-op.
   * Gives the relay its reference back whatever the outcome; a rejection
   * reports that tmux refused the relay's own cleanup, not that the peer is
   * still enabled.
   */
  disable(peer: Peer): Promise<void> {
    const coverage = this.peers.get(peer);
    if (coverage === undefined) return unregistered(peer, "disable");
    switch (coverage.kind) {
      case "none":
        return Promise.resolve();
      case "releasing":
        return coverage.releasing;
      case "held": {
        const releasing = coverage.enabling.then(
          () => this.deps.client.disableCrossSessionLayoutChange(),
          // The enable failed, so there is no reference to give back.
          () => undefined,
        );
        const slot: Coverage = { kind: "releasing", releasing };
        this.peers.set(peer, slot);
        const settleSlot = (): void => this.settle(peer, slot);
        releasing.then(settleSlot, settleSlot);
        return releasing;
      }
    }
  }

  releasePeer(peer: Peer): void {
    if (!this.peers.has(peer)) return;
    void this.disable(peer).catch(this.swallow);
    this.peers.delete(peer);
  }

  dispose(): void {
    for (const peer of [...this.peers.keys()]) this.releasePeer(peer);
  }

  // Returns `peer` to "none" only if `from` is still its current coverage, so
  // a settle never clobbers a newer enable or a removal.
  private settle(peer: Peer, from: Coverage): void {
    if (this.peers.get(peer) === from) this.peers.set(peer, NONE);
  }
}

// [LAW:no-silent-failure] A call for a peer this ledger never registered, or
// already released, would take a relay reference nothing gives back.
function unregistered(peer: Peer, op: string): Promise<never> {
  return Promise.reject(
    new BridgeError(
      "BRIDGE_INTERNAL",
      `cross-session layout ${op} called for peer ${peer.id}, which is not registered`,
    ),
  );
}
