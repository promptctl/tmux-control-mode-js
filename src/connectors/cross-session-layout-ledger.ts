// src/connectors/cross-session-layout-ledger.ts
// [LAW:decomposition] Which bridge peers asked for cross-session layout
// coverage. This ledger's ONE invariant: the shared TmuxClient holds exactly
// one `enableCrossSessionLayoutChange` reference per peer with enables
// outstanding, and gives it back when the peer's count reaches zero or the
// peer goes away. The relay
// behind the client ref-counts those references itself, so tmux sees one
// subscription however many peers enable.
//
// [LAW:one-source-of-truth] `peers` is the single record of who enabled:
// the bridge's event routing reads it (`isEnabled`) to decide which peers
// receive the decoded events, so delivery and the reference count cannot
// disagree.

import type { TmuxClient } from "../client.js";
import { isConnectionGone, TmuxCommandError } from "../errors.js";

import type { Peer } from "./bridge-peer.js";
import { BridgeError } from "./errors.js";

export interface CrossSessionLayoutLedgerDeps {
  readonly client: Pick<
    TmuxClient,
    "enableCrossSessionLayoutChange" | "disableCrossSessionLayoutChange"
  >;
  /**
   * Surface a release that a live tmux refused when a peer went away. The
   * peer has no caller left to answer, so this is the only place it can land.
   */
  readonly reportReleaseFailure: (error: BridgeError) => void;
}

// One peer's coverage. `count` is the peer's outstanding enables, counted per
// call exactly as `TmuxClient` counts them, so N enables need N disables.
// `held` is whether the relay holds this peer's one reference.
// [LAW:dataflow-not-control-flow] Every call queues a step on `queue`, and
// each step reconciles `held` toward `count > 0` rather than acting on a
// decision taken before it waited, so the peer's last call always wins: no
// interleaving of enables and disables can leave a reference the counts do
// not ask for.
interface Coverage {
  count: number;
  held: boolean;
  queue: Promise<void>;
}

export class CrossSessionLayoutLedger {
  // Registered peer → its coverage. Presence is this ledger's registration
  // truth, so a call for a removed peer cannot take a reference nothing
  // would give back.
  private readonly peers = new Map<Peer, Coverage>();

  constructor(private readonly deps: CrossSessionLayoutLedgerDeps) {}

  register(peer: Peer): void {
    if (this.peers.has(peer)) {
      throw new BridgeError(
        "BRIDGE_INTERNAL",
        `peer ${peer.id} is already registered with the cross-session layout ledger`,
      );
    }
    this.peers.set(peer, { count: 0, held: false, queue: Promise.resolve() });
  }

  /** Delivery follows the peer's calls, not the relay round trip: a peer that disabled stops receiving at once. */
  isEnabled(peer: Peer): boolean {
    return (this.peers.get(peer)?.count ?? 0) > 0;
  }

  /** Counted per call. Rejects, and counts for nothing, if the relay could not take the reference. */
  enable(peer: Peer): Promise<void> {
    const coverage = this.peers.get(peer);
    if (coverage === undefined) return unregistered(peer, "enable");
    coverage.count += 1;
    return this.serialize(coverage, async () => {
      try {
        await this.reconcile(coverage);
      } catch (err) {
        // A released peer was already zeroed; there is nothing to undo.
        if (coverage.count > 0) coverage.count -= 1;
        throw err;
      }
    });
  }

  /**
   * Undoes one enable; a no-op for a peer with none outstanding. A rejection
   * reports that tmux refused the relay's own cleanup; the peer's count has
   * already dropped either way.
   */
  disable(peer: Peer): Promise<void> {
    const coverage = this.peers.get(peer);
    if (coverage === undefined) return unregistered(peer, "disable");
    if (coverage.count === 0) return coverage.queue;
    coverage.count -= 1;
    return this.serialize(coverage, () => this.reconcile(coverage));
  }

  releasePeer(peer: Peer): void {
    const coverage = this.peers.get(peer);
    if (coverage === undefined) return;
    this.peers.delete(peer);
    coverage.count = 0;
    // [LAW:no-silent-failure] The peer is gone, so the failure goes to the
    // bridge's report seam. A connection already gone is quiet: the relay's
    // subscription died with it.
    void this.serialize(coverage, () => this.reconcile(coverage)).catch(
      (err: unknown) => {
        if (!isConnectionGone(err))
          this.deps.reportReleaseFailure(releaseFailureToBridgeError(err));
      },
    );
  }

  dispose(): void {
    for (const peer of [...this.peers.keys()]) this.releasePeer(peer);
  }

  private serialize(
    coverage: Coverage,
    step: () => Promise<void>,
  ): Promise<void> {
    const run = coverage.queue.then(step);
    // The caller receives `run`'s rejection; the queue only orders steps.
    coverage.queue = run.catch(() => undefined);
    return run;
  }

  private async reconcile(coverage: Coverage): Promise<void> {
    const want = coverage.count > 0;
    if (want && !coverage.held) {
      await this.deps.client.enableCrossSessionLayoutChange();
      coverage.held = true;
    } else if (!want && coverage.held) {
      // The relay gives its reference back whatever tmux says about the
      // cleanup, so the peer no longer holds it either way.
      coverage.held = false;
      await this.deps.client.disableCrossSessionLayoutChange();
    }
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

const releaseFailureToBridgeError = (err: unknown): BridgeError => {
  const detail =
    err instanceof Error ? err.message : `non-Error rejection (${typeof err})`;
  return new BridgeError(
    err instanceof TmuxCommandError ? "TMUX_ERROR" : "BRIDGE_INTERNAL",
    `cross-session layout release for a departed peer failed: ${detail}`,
  );
};
