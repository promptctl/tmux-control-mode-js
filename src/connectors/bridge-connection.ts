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
   * Forward a `subscribe` RPC through the bridge. Every helper-managed peer
   * subscribes through here, never directly through `client.subscribe`.
   *
   * Behavior:
   *   - First peer to claim `name` writes the canonical `(what, format)`
   *     and forwards `client.subscribe(name, what, format)` to tmux.
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

    removePeer(peer: Peer): void {
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
    },

    async subscribeForPeer(
      peer: Peer,
      name: string,
      what: string,
      format: string,
    ): Promise<CommandResponse> {
      const state = peers.get(peer);
      if (state === undefined) {
        // [LAW:no-defensive-null-guards] Trust-boundary check: a transport
        // that mishandles its own peer lifecycle (calling subscribe after
        // removePeer) would otherwise silently corrupt the bookkeeping. The
        // throw fails loudly at the bridge boundary instead.
        throw new BridgeError(
          "BRIDGE_INTERNAL",
          "subscribeForPeer called for a peer that is not registered",
        );
      }

      const existing = subscriptions.get(name);
      if (existing !== undefined) {
        // Divergent re-subscribe: a peer claims an existing name with a
        // different (what, format). Reject — silently overwriting tmux's
        // binding would change the format observed by prior subscribers.
        if (existing.what !== what || existing.format !== format) {
          throw new BridgeError(
            "BRIDGE_SUBSCRIPTION_FORMAT_CONFLICT",
            `subscription "${name}" is already held with a different ` +
              `(what, format) pair; unsubscribe first if you need to update it`,
          );
        }
        // Same key — just claim ownership (idempotent for repeat callers).
        if (!state.subscriptions.has(name)) {
          state.subscriptions.add(name);
          existing.owners.add(peer);
        }
        return synthesizeOk();
      }

      // First subscriber for this name: store the canonical (what, format)
      // OPTIMISTICALLY before the await so a concurrent subscribe from
      // another peer with the same key short-circuits to the synthesized-ok
      // path (matching the refcount the await is about to establish).
      const record: SubscriptionRecord = {
        what,
        format,
        owners: new Set([peer]),
      };
      subscriptions.set(name, record);
      state.subscriptions.add(name);
      try {
        return await client.subscribe(name, what, format);
      } catch (err) {
        // Rollback: tmux refused to install the subscription. Drop our
        // ownership claim so a retry from this peer (or any other peer) can
        // re-establish the canonical record cleanly.
        record.owners.delete(peer);
        state.subscriptions.delete(name);
        if (record.owners.size === 0) subscriptions.delete(name);
        throw err;
      }
    },

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
      for (const peer of [...peers.keys()]) {
        const state = peers.get(peer);
        if (state === undefined) continue;
        peers.delete(peer);
        state.outstanding.clear();
        for (const name of state.subscriptions) {
          const lastOwner = releaseName(name, peer);
          if (lastOwner) void client.unsubscribe(name).catch(swallow);
        }
        state.subscriptions.clear();
      }
      // Resume any panes the helper had paused so tmux is not left stuck
      // after teardown.
      for (const paneId of pausedPanes) {
        void client.setPaneAction(paneId, PaneAction.Continue).catch(swallow);
      }
      pausedPanes.clear();
    },
  };
}
