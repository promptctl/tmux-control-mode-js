// src/connectors/bridge-peer.ts
// [LAW:decomposition] The `Peer` token is the seam the bridge's two ledgers
// (SubscriptionLedger, BackpressureLedger) and the composing façade all index
// on. It lives in its own module so the dependency graph is strictly one-way:
// the façade and both ledgers depend on this, and nothing depends back.
// [LAW:one-way-deps]
//
// A `Peer` is an opaque per-connection handle allocated by the bridge's
// `registerPeer` and passed back into every subsequent call referring to that
// peer. Transports never read its fields; the ledgers use object identity as a
// Map key. Using an opaque token instead of a transport-specific value (a
// WebContents reference, a WebSocket reference, a string id) keeps the
// bookkeeping completely structural — the ledgers never learn what a peer
// physically is.

export interface Peer {
  /** Stable id, only useful for logging / debugging. Unique per bridge. */
  readonly id: number;
}
