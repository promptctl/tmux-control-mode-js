// src/connectors/cross-session-layout-ledger.ts
// [LAW:decomposition] Which bridge peers asked for cross-session layout
// coverage. This ledger's ONE invariant: the shared TmuxClient holds exactly
// one `enableCrossSessionLayoutChange` reference per peer that enabled it, and
// gives that reference back when the peer disables or goes away. The relay
// behind the client ref-counts those references itself, so tmux sees one
// subscription however many peers enable.
//
// [LAW:one-source-of-truth] `holders` is the single record of who enabled:
// the bridge's event routing reads it (`isEnabled`) to decide which peers
// receive the decoded events, so delivery and the reference count cannot
// disagree.

import type { TmuxClient } from "../client.js";

import type { Peer } from "./bridge-peer.js";

export interface CrossSessionLayoutLedgerDeps {
  readonly client: Pick<
    TmuxClient,
    "enableCrossSessionLayoutChange" | "disableCrossSessionLayoutChange"
  >;
}

export class CrossSessionLayoutLedger {
  // Peer → its enable call. Present from the moment the peer asks, so an
  // event that lands while the enable is still in flight already reaches it,
  // and a disable that races the enable waits for it before releasing.
  private readonly holders = new Map<Peer, Promise<void>>();

  // Fire-and-forget on the peer-teardown seam only, matching
  // SubscriptionLedger: the peer is gone, so there is no caller to report to.
  private readonly swallow = (): void => undefined;

  constructor(private readonly deps: CrossSessionLayoutLedgerDeps) {}

  isEnabled(peer: Peer): boolean {
    return this.holders.has(peer);
  }

  /** Idempotent per peer: a second enable from the same peer joins the first. */
  enable(peer: Peer): Promise<void> {
    const held = this.holders.get(peer);
    if (held !== undefined) return held;
    const enabling = this.deps.client.enableCrossSessionLayoutChange();
    this.holders.set(peer, enabling);
    // A rejected enable counts for nothing (the relay already undid its
    // reference), so the peer holds nothing either.
    enabling.catch(() => {
      if (this.holders.get(peer) === enabling) this.holders.delete(peer);
    });
    return enabling;
  }

  /** Idempotent per peer: disabling a peer that holds nothing is a no-op. */
  async disable(peer: Peer): Promise<void> {
    const held = this.holders.get(peer);
    if (held === undefined) return;
    this.holders.delete(peer);
    try {
      await held;
    } catch {
      // The enable failed, so there is no reference to give back.
      return;
    }
    await this.deps.client.disableCrossSessionLayoutChange();
  }

  releasePeer(peer: Peer): void {
    void this.disable(peer).catch(this.swallow);
  }

  dispose(): void {
    for (const peer of [...this.holders.keys()]) this.releasePeer(peer);
  }
}
