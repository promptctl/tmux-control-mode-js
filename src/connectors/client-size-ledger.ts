// src/connectors/client-size-ledger.ts
// [LAW:decomposition] Each peer's share of the bridge client's size. This
// ledger's ONE invariant is: a peer's sizes go through a claim of its own on
// the tmux client, and the peer's departure releases it.
//
// [LAW:one-source-of-truth] The claims themselves live on the TmuxClient
// (src/client-size.ts), not here: the WebSocket server builds one bridge per
// socket, and every socket may share one client, so only the client sees
// every page's claim. This ledger only maps a peer to the claim it holds.

import type { TmuxClient } from "../client.js";
import type { ClientSizeClaim, ClientSizeSurface } from "../client-size.js";

import { BridgeError } from "./errors.js";
import type { Peer } from "./bridge-peer.js";

export interface ClientSizeLedgerDeps {
  readonly client: Pick<TmuxClient, "claimSize">;
}

export class ClientSizeLedger {
  private readonly claims = new Map<Peer, ClientSizeClaim>();

  constructor(private readonly deps: ClientSizeLedgerDeps) {}

  // [LAW:no-silent-failure] exception: a departed peer has no one to answer,
  // and a release sends only commands tmux accepts (src/client-size.ts), so
  // what it can reject with is a connection already gone.
  private readonly swallow = (): void => undefined;

  register(peer: Peer): void {
    if (this.claims.has(peer)) {
      throw new BridgeError(
        "BRIDGE_INTERNAL",
        `peer ${peer.id} is already registered with the client-size ledger`,
      );
    }
    this.claims.set(peer, this.deps.client.claimSize());
  }

  /** The claim `peer` declares its sizes through. */
  sizeOf(peer: Peer): ClientSizeSurface {
    const claim = this.claims.get(peer);
    if (claim === undefined) {
      throw new BridgeError(
        "BRIDGE_INTERNAL",
        `a size was declared for peer ${peer.id}, which is not registered`,
      );
    }
    return claim;
  }

  /** Withdraw every size this peer declared. Idempotent. */
  releasePeer(peer: Peer): void {
    const claim = this.claims.get(peer);
    if (claim === undefined) return;
    this.claims.delete(peer);
    void claim.release().catch(this.swallow);
  }

  dispose(): void {
    for (const peer of [...this.claims.keys()]) this.releasePeer(peer);
  }
}
