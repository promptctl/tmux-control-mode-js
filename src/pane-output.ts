// src/pane-output.ts
// Scope-based pane output subscriptions.
//

import type {
  NewWindowResult,
  PaneRecord,
  SessionRecord,
  WindowRecord,
} from "./protocol/types.js";
import { latin1ToBytes } from "./protocol/byte-codec.js";

// [LAW:types-are-the-program] BytesSink is the byte contract; PaneScope
//   encodes membership as a value (a discriminated union), not as a method.
//   The four scope kinds are four arms of one union, not four entry points.
// [LAW:one-type-per-behavior] Two consumer behaviors: BytesSink (chunk-shaped)
//   and the line callback introduced in attachLineSink (.2). Each has one
//   contract and one attach method. The four scope kinds are not separate
//   behaviors — they're values that parameterize the one behavior.
// [LAW:dataflow-not-control-flow] Scope membership is per-chunk data lookup
//   (topology table + scope description), not pre-computed control flow.
//   Topology changes update the table; the next chunk reads the updated state.
// [LAW:single-enforcer] SinkRegistry is the one dispatch path. PaneTopologyManager
//   is the one topology writer. Neither is duplicated across TmuxConnection implementations.

// ---------------------------------------------------------------------------
// ChunkPayload — what a BytesSink receives
// ---------------------------------------------------------------------------

/**
 * The pane-byte payload delivered to every BytesSink on each chunk.
 *
 * [LAW:types-are-the-program] The `type` discriminator (`'output'` vs
 * `'extended-output'`) and the `age` field from the wire protocol are consumed
 * by the substrate before dispatch and never reach the sink. This type encodes
 * exactly what a sink reads — nothing more.
 *
 * `data` is the same `Uint8Array` instance shared by every sink matching the
 * same chunk. Treat it as read-only. Copy before retention.
 */
export interface ChunkPayload {
  readonly paneId: number;
  readonly data: Uint8Array;
}

// ---------------------------------------------------------------------------
// BytesSink — the byte consumer contract
// ---------------------------------------------------------------------------

/**
 * Byte-shaped consumer contract for pane output.
 *
 * Implementors receive one `ChunkPayload` per tmux chunk. Chunks do not align
 * with anything semantic — a UTF-8 multi-byte sequence may straddle two
 * chunks, an ANSI escape may, a log line may. Implementors that need
 * cross-chunk state (streaming UTF-8 decode, ANSI parser) must carry it
 * between `write` calls.
 *
 * ## Contract
 *
 * - `write(msg)` MUST be synchronous and non-throwing.
 * - `msg.data` is shared across all sinks for the same chunk — read-only.
 * - `end()` is called exactly once after the final `write`, regardless of
 *   cause (disposer called, connection closed). Not optional — stateless
 *   sinks implement it as a no-op. [LAW:types-are-the-program]: optional
 *   cleanup hedges the contract.
 */
export interface BytesSink {
  write(msg: ChunkPayload): void;
  end(): void;
}

// ---------------------------------------------------------------------------
// PaneScope — the membership contract
// ---------------------------------------------------------------------------

/**
 * Describes which panes a sink is interested in.
 *
 * Each scope is a **standing query** against the tmux topology, not a
 * snapshot. Topology changes (new panes, pane moves, window closes) propagate
 * automatically — the consumer does not re-subscribe.
 *
 * [LAW:one-type-per-behavior] All four variants are arms of one union, not
 *   four methods or four sink types. Adding a fifth scope kind is a new arm,
 *   not a new method. The union is the type; the factory functions below are
 *   the consumer-facing value constructors.
 */
export type PaneScope =
  | { readonly kind: "server" }
  | { readonly kind: "session"; readonly sessionId: number }
  | { readonly kind: "window"; readonly windowId: number }
  | { readonly kind: "pane"; readonly paneId: number };

// [LAW:one-source-of-truth] Consumers reach for these factories, never for
//   object literals, so the union's shape is the one canonical definition.
/** Subscribe to all panes on the tmux server, including future sessions. Default scope. */
export const serverScope: PaneScope = Object.freeze({
  kind: "server",
} as const);

/** Subscribe to all panes in the given session, including future panes. */
export function sessionScope(sessionId: number): PaneScope {
  return { kind: "session", sessionId };
}

/** Subscribe to all panes in the given window, including future panes. */
export function windowScope(windowId: number): PaneScope {
  return { kind: "window", windowId };
}

/** Subscribe to exactly one pane. */
export function paneScope(paneId: number): PaneScope {
  return { kind: "pane", paneId };
}

// ---------------------------------------------------------------------------
// AttachOptions
// ---------------------------------------------------------------------------

/** Options for `attachBytesSink`. */
export interface AttachOptions {
  /** Which panes to receive. Defaults to `serverScope` (every pane on the server). */
  readonly scope?: PaneScope;
}

// ---------------------------------------------------------------------------
// PaneMeta + PaneTopologyManager — the authoritative membership table
// ---------------------------------------------------------------------------

/**
 * Topology metadata for a single pane — the session and window it currently
 * belongs to.
 */
export interface PaneMeta {
  readonly sessionId: number;
  readonly windowId: number;
}

/**
 * Maintains the paneId → {sessionId, windowId} table from bootstrap queries
 * and tmux topology notifications.
 *
 * [LAW:one-source-of-truth] This is the sole writer to the topology table.
 *   SinkRegistry.dispatch is the sole reader. No second table exists.
 */
export class PaneTopologyManager {
  // [LAW:one-source-of-truth] paneId → {sessionId, windowId}.
  private readonly table = new Map<number, PaneMeta>();
  // Reverse index: windowId → Set<paneId>. Needed for O(panes-in-window)
  // removal on window-close and for differential update on layout-change.
  private readonly windowIndex = new Map<number, Set<number>>();

  get(paneId: number): PaneMeta | undefined {
    return this.table.get(paneId);
  }

  /**
   * Enumerate every pane currently known to the topology.
   *
   * The sole consumer is `PaneInterestTracker`, which needs the universe of
   * panes to recompute admitting-attachment counts. Returns the live key
   * iterator — callers must consume it synchronously (the tracker does), as a
   * concurrent topology mutation would invalidate it.
   */
  paneIds(): IterableIterator<number> {
    return this.table.keys();
  }

  /**
   * Wholesale replace the topology table from a full pane listing.
   * Called on bootstrap (list-panes -a) and on sessions-changed.
   */
  seed(
    entries: readonly {
      paneId: number;
      windowId: number;
      sessionId: number;
    }[],
  ): void {
    this.table.clear();
    this.windowIndex.clear();
    for (const { paneId, windowId, sessionId } of entries) {
      this.table.set(paneId, { sessionId, windowId });
      let set = this.windowIndex.get(windowId);
      if (set === undefined) {
        set = new Set();
        this.windowIndex.set(windowId, set);
      }
      set.add(paneId);
    }
  }

  /**
   * Differential update for one window. Removes panes that moved away or
   * closed, adds new panes. Called on layout-change (list-panes -t @W output).
   */
  updateWindow(
    windowId: number,
    entries: readonly { paneId: number; sessionId: number }[],
  ): void {
    const prev = this.windowIndex.get(windowId);
    const next = new Set(entries.map((e) => e.paneId));

    // Remove panes no longer in this window.
    // [LAW:one-source-of-truth] Only delete when table still maps the pane to
    // this window. A concurrent refresh for another window may have already
    // updated the entry — if so, that newer mapping is authoritative.
    if (prev !== undefined) {
      for (const paneId of prev) {
        if (
          !next.has(paneId) &&
          this.table.get(paneId)?.windowId === windowId
        ) {
          this.table.delete(paneId);
        }
      }
    }

    // Add / update entries
    for (const { paneId, sessionId } of entries) {
      this.table.set(paneId, { sessionId, windowId });
    }

    if (next.size === 0) {
      this.windowIndex.delete(windowId);
    } else {
      this.windowIndex.set(windowId, next);
    }
  }

  /**
   * Unplace every pane whose placement a layout of `windowId` contradicts:
   * one it lists that the table maps to another window (moved in), and one
   * the table maps here that it omits (broken out, or floated — tmux 3.8
   * omits floating panes). The refreshes that follow re-place them; until
   * then they match no window/session scope. Returns the windows moved-in
   * panes left, whose membership any earlier query misstates.
   */
  unplaceContradicted(
    windowId: number,
    layoutPanes: readonly number[],
  ): ReadonlySet<number> {
    const listed = new Set(layoutPanes);
    for (const paneId of this.windowIndex.get(windowId) ?? []) {
      if (
        !listed.has(paneId) &&
        this.table.get(paneId)?.windowId === windowId
      ) {
        this.table.delete(paneId);
      }
    }
    const lost = new Set<number>();
    for (const paneId of listed) {
      const meta = this.table.get(paneId);
      if (meta !== undefined && meta.windowId !== windowId) {
        this.table.delete(paneId);
        lost.add(meta.windowId);
      }
    }
    return lost;
  }

  /**
   * Remove all panes belonging to a window (window-close / unlinked-window-close).
   */
  removeWindow(windowId: number): void {
    const panes = this.windowIndex.get(windowId);
    if (panes === undefined) return;
    for (const paneId of panes) {
      // [LAW:one-source-of-truth] Only remove when table still maps the pane to
      // this window. windowIndex may lag behind table if the pane moved to
      // another window and that window's refresh ran first.
      if (this.table.get(paneId)?.windowId === windowId) {
        this.table.delete(paneId);
      }
    }
    this.windowIndex.delete(windowId);
  }
}

// ---------------------------------------------------------------------------
// SinkRegistry — scope-bifurcated dispatch
// ---------------------------------------------------------------------------

// One attachment: the sink plus its attach sequence number. The record object
// IS the attachment's identity, so the same sink attached twice is two entries.
interface Attachment {
  readonly seq: number;
  readonly sink: BytesSink;
}

// Internal per-scope bucket of attachments, in attach order.
type Bucket = Set<Attachment>;

/**
 * Which attachments a dispatch may write to.
 *
 * Live dispatch admits every scope and every attachment. Replay of a held
 * chunk (see TopologyRouter) admits only the topology scopes, since pane and
 * server attachments already received it live, and only attachments made at or
 * before the chunk arrived (`attachedBy` = `SinkRegistry.attachSeq()` then).
 * [LAW:single-enforcer] Admission is a value on the one dispatch path, not a
 *   second dispatch method.
 */
// [LAW:types-are-the-program] Exactly the two legal admissions: a replay that
//   reached pane/server scopes again would duplicate delivery, so it cannot be
//   expressed.
export type DispatchAdmission =
  | { readonly kind: "live" }
  | { readonly kind: "replay"; readonly attachedBy: number };

export const liveAdmission: DispatchAdmission = { kind: "live" };

/**
 * Scope-bifurcated registry for `BytesSink` attachments.
 *
 * Stores attachments in four buckets keyed by scope kind. Dispatch for a
 * given `paneId` iterates all four matching buckets (pane, window, session,
 * server) and calls `sink.write(msg)` for each — in that order, most to
 * least specific.
 *
 * [LAW:single-enforcer] One dispatch path. All TmuxConnection implementations
 *   own one instance; none duplicate the snapshot logic or the bucket layout.
 * [LAW:dataflow-not-control-flow] dispatch() runs the same four bucket lookups
 *   on every chunk. Which buckets are non-empty is data, not guarded control.
 * [LAW:types-are-the-program] Attachment-record Sets make per-attachment
 *   identity structural: each attach() call yields an independent entry even
 *   for the same sink instance, with no "is this sink already attached" check.
 */
export class SinkRegistry {
  // [LAW:one-source-of-truth] Four buckets are the sole attachment state.
  //   attach() writes one bucket. dispose() deletes from exactly that bucket.
  //   dispatch() reads all matching buckets. No second index exists.
  private readonly serverAttachments: Bucket = new Set();
  private readonly sessionAttachments = new Map<number, Bucket>();
  private readonly windowAttachments = new Map<number, Bucket>();
  private readonly paneAttachments = new Map<number, Bucket>();
  // Monotone: every attach draws a strictly greater seq than all before it.
  private lastSeq = 0;

  /**
   * Attach a sink to the given scope. Returns an idempotent disposer.
   *
   * Each call is an independent attachment — the same sink may be attached
   * multiple times; each yields its own entry and disposer. The disposer
   * calls `sink.end()` exactly once on the first invocation.
   */
  attach(sink: BytesSink, scope: PaneScope): () => void {
    const attachment: Attachment = { seq: ++this.lastSeq, sink };
    const bucket = this.getOrCreateBucket(scope);
    bucket.add(attachment);

    // [LAW:dataflow-not-control-flow] Idempotency is structural — delete()
    //   returns true only on the first removal, so end() fires at most once
    //   without a separate `disposed` flag.
    return () => {
      const removed = bucket.delete(attachment);
      if (!removed) return;
      if (bucket.size === 0) this.pruneEmptyBucket(scope);
      sink.end();
    };
  }

  /**
   * True when at least one session-scoped or window-scoped sink is attached.
   * Used to suppress topology bootstraps when no consumer needs topology.
   * [LAW:dataflow-not-control-flow] Bootstrap is data-driven: fire only when
   *   there are consumers that would benefit. No topology-dependent sinks =
   *   no bootstrap = no extra command on the wire.
   */
  hasTopologyDependentSinks(): boolean {
    return this.sessionAttachments.size > 0 || this.windowAttachments.size > 0;
  }

  // ---------------------------------------------------------------------------
  // Admitting-attachment counts — read surface for PaneInterestTracker
  //
  // [LAW:decomposition] Counting is a distinct concern from byte dispatch. The
  //   registry owns the buckets, so it answers "how many attachments admit this
  //   scope"; it does NOT own the topology needed to sum a pane's admit count
  //   across scopes (that join lives in PaneInterestTracker). Each count is the
  //   bucket size — `?? 0` maps "no bucket for this id" to the domain value
  //   zero, not a defensive guard. [LAW:no-defensive-null-guards]
  // ---------------------------------------------------------------------------

  /** Attachments admitting every pane (serverScope). */
  serverAttachmentCount(): number {
    return this.serverAttachments.size;
  }

  /** Attachments admitting every pane in the given session. */
  sessionAttachmentCount(sessionId: number): number {
    return this.sessionAttachments.get(sessionId)?.size ?? 0;
  }

  /** Attachments admitting every pane in the given window. */
  windowAttachmentCount(windowId: number): number {
    return this.windowAttachments.get(windowId)?.size ?? 0;
  }

  /** Attachments admitting exactly this pane. */
  paneAttachmentCount(paneId: number): number {
    return this.paneAttachments.get(paneId)?.size ?? 0;
  }

  /**
   * Pane ids named by a pane-scoped attachment.
   *
   * [LAW:one-source-of-truth] These panes belong to the interest universe even
   *   when topology has not yet learned of them — a `paneScope(%N)` attachment
   *   is an explicit declaration that %N is interesting. Returns the live key
   *   iterator; consume synchronously.
   */
  paneScopedPaneIds(): IterableIterator<number> {
    return this.paneAttachments.keys();
  }

  /**
   * Dispatch one chunk to all matching attachments.
   *
   * `meta` is the topology lookup result for `msg.paneId` — undefined when
   * the pane is unknown (topology race). In that case only pane-scoped and
   * server-scoped attachments match.
   *
   * [LAW:dataflow-not-control-flow] Same four snapshot+iterate paths on every
   *   chunk, regardless of which buckets are populated. Snapshots are taken
   *   before the first write so re-entrant attach/detach in a sink's write
   *   cannot back-fill or skip the current chunk.
   *
   * `admission` narrows which attachments are written; see DispatchAdmission.
   */
  dispatch(
    msg: ChunkPayload,
    meta: PaneMeta | undefined,
    admission: DispatchAdmission = liveAdmission,
  ): void {
    // Snapshot all four buckets synchronously before any write() call. The
    // up-front capture is load-bearing across buckets too: a pane-sink's write
    // attaching a server-sink must not deliver to it this chunk, so all four
    // memberships are frozen before the first write fires.
    const everyScope = admission.kind === "live";
    const paneSnap = everyScope
      ? snapshotBucket(this.paneAttachments.get(msg.paneId))
      : undefined;
    const windowSnap =
      meta !== undefined
        ? snapshotBucket(this.windowAttachments.get(meta.windowId))
        : undefined;
    const sessionSnap =
      meta !== undefined
        ? snapshotBucket(this.sessionAttachments.get(meta.sessionId))
        : undefined;
    const serverSnap = everyScope
      ? snapshotBucket(this.serverAttachments)
      : undefined;

    // [LAW:no-defensive-null-guards] `undefined` is the no-sinks sentinel, not
    //   a defensive guard. The early exit is a performance gate (skip four
    //   no-op writeSnapshot calls on the common no-consumer path).
    if (
      paneSnap === undefined &&
      windowSnap === undefined &&
      sessionSnap === undefined &&
      serverSnap === undefined
    )
      return;

    const by =
      admission.kind === "live"
        ? Number.POSITIVE_INFINITY
        : admission.attachedBy;
    writeSnapshot(paneSnap, msg, by);
    writeSnapshot(windowSnap, msg, by);
    writeSnapshot(sessionSnap, msg, by);
    writeSnapshot(serverSnap, msg, by);
  }

  /**
   * The seq of the most recent attachment. A chunk stamped with this value
   * admits exactly the attachments that existed when it arrived.
   */
  attachSeq(): number {
    return this.lastSeq;
  }

  private getOrCreateBucket(scope: PaneScope): Bucket {
    switch (scope.kind) {
      case "server":
        return this.serverAttachments;
      case "session": {
        let b = this.sessionAttachments.get(scope.sessionId);
        if (b === undefined) {
          b = new Set();
          this.sessionAttachments.set(scope.sessionId, b);
        }
        return b;
      }
      case "window": {
        let b = this.windowAttachments.get(scope.windowId);
        if (b === undefined) {
          b = new Set();
          this.windowAttachments.set(scope.windowId, b);
        }
        return b;
      }
      case "pane": {
        let b = this.paneAttachments.get(scope.paneId);
        if (b === undefined) {
          b = new Set();
          this.paneAttachments.set(scope.paneId, b);
        }
        return b;
      }
    }
  }

  /**
   * End every attached sink and clear all buckets.
   *
   * Called by the transport adapter when the connection closes. Guarantees
   * `end()` is called exactly once per attached sink even if the caller still
   * holds disposers from earlier `attach()` calls — the inner bucket Sets are
   * cleared first so any subsequent disposer invocation sees `bucket.delete()`
   * return `false` and becomes a no-op.
   *
   * [LAW:one-source-of-truth] Transport-close sink teardown lives here; no
   * transport adapter re-implements the sweep.
   */
  endAll(): void {
    // Collect inner bucket references before clearing outer maps.
    const innerBuckets: Bucket[] = [
      ...this.sessionAttachments.values(),
      ...this.windowAttachments.values(),
      ...this.paneAttachments.values(),
    ];
    // Collect all sinks before any bucket is mutated.
    const allSinks: BytesSink[] = [
      ...this.serverAttachments.values(),
      ...innerBuckets.flatMap((b) => [...b.values()]),
    ].map((a) => a.sink);
    // Clear inner buckets first — existing disposers see empty bucket and
    // become no-ops, preventing double-end on concurrent disposal.
    for (const b of innerBuckets) b.clear();
    // Clear server bucket and outer maps.
    this.serverAttachments.clear();
    this.sessionAttachments.clear();
    this.windowAttachments.clear();
    this.paneAttachments.clear();
    // Call end() on collected sinks exactly once each.
    for (const sink of allSinks) sink.end();
  }

  private pruneEmptyBucket(scope: PaneScope): void {
    switch (scope.kind) {
      case "server":
        return; // serverAttachments is never pruned
      case "session":
        this.sessionAttachments.delete(scope.sessionId);
        return;
      case "window":
        this.windowAttachments.delete(scope.windowId);
        return;
      case "pane":
        this.paneAttachments.delete(scope.paneId);
        return;
    }
  }
}

// A bucket's membership frozen at dispatch entry. Three shapes, no wrapper
// object (a tagged wrapper would allocate per chunk — the exact cost this
// representation exists to avoid):
//   undefined        — no sinks for this scope (the no-consumer common case).
//   Attachment       — exactly one (the dominant one-terminal case); the bare
//                      reference IS the frozen membership, no array.
//   Attachment[]     — two or more, copied to freeze against re-entrant
//                      mutation while iterating.
// [LAW:types-are-the-program] The union is exactly as wide as the domain: a
//   frozen membership is empty, single, or many — nothing else representable.
//   The array arm is mutable (not `readonly`) so `Array.isArray` narrows it in
//   writeSnapshot; immutability is guaranteed structurally — the array is
//   module-private, built once by snapshotBucket and only ever iterated.
type SinkSnapshot = undefined | Attachment | Attachment[];

// [LAW:dataflow-not-control-flow] The size branch selects a *materialization*
//   strategy, not a behavior: every shape delivers the chunk to exactly the
//   sinks present at dispatch entry. Capturing the sole reference for size===1
//   is the allocation-free freeze for the hot path — over a steady %output
//   stream this is the largest per-chunk allocation eliminated. The `Array.from`
//   copy remains only for size>=2, where live-iterating a mutating Set is the
//   real re-entrancy hazard.
function snapshotBucket(bucket: Bucket | undefined): SinkSnapshot {
  if (bucket === undefined || bucket.size === 0) return undefined;
  if (bucket.size === 1) {
    // The single (only) entry: returning its reference allocates nothing —
    // V8's escape analysis scalar-replaces the non-escaping Set iterator.
    for (const attachment of bucket) return attachment;
  }
  return Array.from(bucket.values());
}

// [LAW:dataflow-not-control-flow] Dispatches on the snapshot's shape, not on
//   any behavioral condition — the write to each frozen member runs the same
//   way regardless of how membership was materialized. Live dispatch passes
//   attachedBy = +∞, so the seq comparison admits every member.
function writeSnapshot(
  snap: SinkSnapshot,
  msg: ChunkPayload,
  attachedBy: number,
): void {
  if (snap === undefined) return;
  if (Array.isArray(snap)) {
    for (const a of snap) if (a.seq <= attachedBy) a.sink.write(msg);
    return;
  }
  if (snap.seq <= attachedBy) snap.sink.write(msg);
}

// ---------------------------------------------------------------------------
// PaneInterestTracker — derives per-pane interest from scope attachments
// ---------------------------------------------------------------------------

/**
 * Notified when a pane crosses the boundary between "some attachment admits
 * it" (interesting) and "none does" (idle).
 *
 * [LAW:effects-at-boundaries] The tracker that drives this listener is pure —
 *   it computes transitions and calls these methods. Whatever acts on the
 *   world (pausing/continuing tmux panes) implements this interface at the
 *   boundary; the tracker never touches tmux itself.
 */
export interface PaneInterestListener {
  onPaneBecameInteresting(paneId: number): void;
  onPaneBecameIdle(paneId: number): void;
}

/**
 * Derives, for every pane in the interest universe, whether any attachment
 * admits it — and fires {@link PaneInterestListener} on each transition.
 *
 * A pane's **admitting-attachment count** is the scope-correct sum:
 *
 * ```
 * admit(p) = paneAttachmentCount(p)
 *          + windowAttachmentCount(window(p))
 *          + sessionAttachmentCount(session(p))
 *          + serverAttachmentCount()
 * ```
 *
 * The pane is *interesting* iff `admit(p) > 0`. The **universe** of panes is
 * every pane known to topology plus every pane named by a pane-scoped
 * attachment (the latter may not yet be in topology).
 *
 * [LAW:dataflow-not-control-flow] `recompute()` rebuilds the whole interest map
 *   from current data (topology + attachment counts) and diffs against the
 *   prior map on every mutating event — attach, dispose, and every topology
 *   mutation. There is no per-event "which panes are affected" branching: the
 *   same full recompute runs every time, and the data decides which panes
 *   transitioned. This is correct under topology moves for free — a pane that
 *   moves from an admitting session to a non-admitting one simply recomputes to
 *   a different admit count. recompute() is off the per-chunk hot path (it runs
 *   only on attach/dispose/topology events), so the O(universe) sweep is cheap.
 * [LAW:single-enforcer] The interest map is the sole record of which panes are
 *   currently interesting. The listener is told only the deltas.
 */
export class PaneInterestTracker {
  // [LAW:one-source-of-truth] paneId → interesting. A pane absent from this map
  //   is outside the tracked universe (topology does not know it and no
  //   pane-scope attachment names it). Reassigned wholesale each recompute.
  private state = new Map<number, boolean>();

  constructor(
    private readonly registry: SinkRegistry,
    private readonly topology: PaneTopologyManager,
    private readonly listener: PaneInterestListener,
  ) {}

  /**
   * Recompute every pane's interest and fire the listener on each transition.
   *
   * Transitions fired:
   * - **interesting**: a pane enters the universe already interesting, or flips
   *   idle → interesting.
   * - **idle**: a pane enters the universe with no admitting attachment (the
   *   join pulse that lets a suppressor pause a freshly-discovered idle pane),
   *   or flips interesting → idle.
   *
   * A pane that *leaves* the universe (topology dropped it and no pane-scope
   * attachment names it) fires nothing — the pane is gone from tmux, so neither
   * pausing nor continuing it is meaningful.
   */
  recompute(): void {
    const serverCount = this.registry.serverAttachmentCount();

    // Universe = topology panes ∪ pane-scope-named panes. Both iterators are
    // consumed synchronously here, before any mutation can invalidate them.
    const next = new Map<number, boolean>();
    for (const paneId of this.topology.paneIds()) {
      next.set(paneId, this.isInteresting(paneId, serverCount));
    }
    for (const paneId of this.registry.paneScopedPaneIds()) {
      next.set(paneId, this.isInteresting(paneId, serverCount));
    }

    // Diff against prior state. A pane whose interest is unchanged — including
    // one no longer in the universe (absent from `next`) — produces no call.
    for (const [paneId, interesting] of next) {
      if (this.state.get(paneId) === interesting) continue;
      if (interesting) this.listener.onPaneBecameInteresting(paneId);
      else this.listener.onPaneBecameIdle(paneId);
    }

    this.state = next;
  }

  private isInteresting(paneId: number, serverCount: number): boolean {
    const meta = this.topology.get(paneId);
    const admit =
      this.registry.paneAttachmentCount(paneId) +
      serverCount +
      (meta !== undefined
        ? this.registry.windowAttachmentCount(meta.windowId) +
          this.registry.sessionAttachmentCount(meta.sessionId)
        : 0);
    return admit > 0;
  }
}

// ---------------------------------------------------------------------------
// TopologyEpochTracker — stale-result guard for async topology queries
// ---------------------------------------------------------------------------

/**
 * Tracks generation counters so async topology queries can detect when a
 * synchronous notification arrived between the query send and the apply.
 *
 * JavaScript's event model processes synchronous notification handlers
 * before Promise microtasks in the same I/O frame. When `window-close @X`
 * and `%end` (for a `list-panes` response that includes @X) arrive in the
 * same TCP segment, the `removeWindow` call fires synchronously before
 * `seed()` or `updateWindow()` runs as a microtask. Without epoch guards
 * the microtask would re-add @X's panes, contradicting the notification.
 *
 * [LAW:one-type-per-behavior] All TmuxConnection implementations share this
 *   one tracker type; the staleness invariant is encoded here, not repeated
 *   in each client.
 * [LAW:dataflow-not-control-flow] The generation number IS a value — the
 *   proof that an async result belongs to the current topology epoch. The
 *   check is data deciding whether a result is authoritative, not control
 *   flow skipping an operation.
 */
export class TopologyEpochTracker {
  private bootstrapGen = 0;
  // [LAW:types-are-the-program] The gen of the most recently *started* bootstrap.
  //   Distinct from bootstrapGen, which is also bumped by invalidateWindow: a
  //   window-close invalidates an in-flight bootstrap's SUCCESS (its seed would
  //   re-add the closed window's panes) but does NOT start a replacement, so it
  //   must not make a genuine bootstrap FAILURE look superseded. The success path
  //   asks isBootstrapCurrent; the failure path asks isLatestBootstrap — two
  //   distinct staleness questions, one enforcer. [LAW:single-enforcer]
  private latestBootstrapStartGen = 0;
  private readonly windowGens = new Map<number, number>();
  // [LAW:types-are-the-program] Global monotone counter — each startWindowRefresh
  // call gets a strictly-greater-than-all-prior token. After startBootstrap()
  // clears windowGens, any new startWindowRefresh still produces a token that
  // cannot alias a pre-clear token, because it is drawn from a sequence that
  // only ever increases. Per-window counters that reset after a clear would
  // allow pre-clear and post-clear tokens to collide (both start at 1).
  private windowEpoch = 0;
  // Each window's latest layout pane list since the last bootstrap started:
  // a bootstrap reply can predate a move these record, so its seed is checked
  // against them once (takeLayouts).
  private readonly layoutsSinceBootstrap = new Map<number, readonly number[]>();

  /**
   * Call immediately before the `list-panes -a` execute(). Returns captured gen.
   *
   * Also clears all window-refresh generations: a bootstrap is a full table
   * replacement via `seed()`, so any in-flight `list-panes -t @W` result is
   * superseded — `isWindowRefreshCurrent` will return false for a missing key.
   * Post-clear window refreshes draw from the global `windowEpoch` and therefore
   * cannot alias any pre-clear token.
   */
  startBootstrap(): number {
    this.windowGens.clear();
    this.layoutsSinceBootstrap.clear();
    this.latestBootstrapStartGen = ++this.bootstrapGen;
    return this.latestBootstrapStartGen;
  }

  /** Call before applying seed(). Returns false if a newer event superseded this query. */
  isBootstrapCurrent(gen: number): boolean {
    return this.bootstrapGen === gen;
  }

  /**
   * Call on the bootstrap FAILURE path. True iff this bootstrap is still the
   * most recently *started* one — i.e. no newer bootstrap has superseded it.
   *
   * A newer bootstrap owns the topology outcome (it will seed a healthy table or
   * report its own failure), so a superseded attempt's rejection must stay
   * silent to avoid a false alarm on an already-repaired connection. A failure
   * that is NOT superseded by a newer *start* — including one whose gen was
   * bumped only by `invalidateWindow` — is the authoritative topology state and
   * must be reported. [LAW:no-silent-failure]
   */
  isLatestBootstrap(gen: number): boolean {
    return this.latestBootstrapStartGen === gen;
  }

  /** Call on every `layout-change`, with the panes its layout lists. */
  recordLayout(windowId: number, panes: readonly number[]): void {
    this.layoutsSinceBootstrap.set(windowId, panes);
  }

  /** Call after a current bootstrap seeds. Returns and forgets the layouts recorded since it started. */
  takeLayouts(): [number, readonly number[]][] {
    const taken = [...this.layoutsSinceBootstrap];
    this.layoutsSinceBootstrap.clear();
    return taken;
  }

  /** Call immediately before the `list-panes -t @W` execute(). Returns captured gen. */
  startWindowRefresh(windowId: number): number {
    const gen = ++this.windowEpoch;
    this.windowGens.set(windowId, gen);
    return gen;
  }

  /** Call before applying updateWindow(). Returns false if a newer event superseded this query. */
  isWindowRefreshCurrent(windowId: number, gen: number): boolean {
    return this.windowGens.get(windowId) === gen;
  }

  /**
   * Call on `window-close` / `unlinked-window-close`. Invalidates any
   * in-flight bootstrap (it would re-add the closed window's panes) and
   * any in-flight per-window refresh for the same window.
   *
   * Deletes the window entry rather than incrementing it: the window is
   * gone and no future refresh will be started for this id (until a new
   * window-add assigns the same id). `isWindowRefreshCurrent` returns
   * false for a missing key (`undefined !== gen`), so in-flight refreshes
   * are still correctly discarded. Deletion keeps the Map bounded.
   */
  invalidateWindow(windowId: number): void {
    this.bootstrapGen++;
    this.layoutsSinceBootstrap.delete(windowId);
    this.windowGens.delete(windowId);
  }
}

// ---------------------------------------------------------------------------
// Topology parsing helpers — used by TmuxClient and bridge clients
// ---------------------------------------------------------------------------

/**
 * Parse one line from `list-panes -a -F '#{pane_id} #{window_id} #{session_id}'`
 * output (or the window-scoped variant `list-panes -t @W`).
 *
 * Returns null for unparseable lines (trailing blank, unexpected format).
 *
 * This is response-block output, where `TmuxParser.processLine()` no longer
 * strips a trailing `\r` run (needed so raw `capture-pane -p` bytes
 * survive) — so on a CRLF transport, the last line of this list can
 * legitimately carry one, and (per a doubled-up CRLF) more than one. `\r*$`
 * tolerates any run of them, the same way `parseSessionRecordLine`'s
 * `Number()` comparison does for its own last field.
 */
export function parsePaneListLine(
  line: string,
): { paneId: number; windowId: number; sessionId: number } | null {
  const m = line.match(/^%(\d+) @(\d+) \$(\d+)\r*$/);
  if (m === null) return null;
  return {
    paneId: Number(m[1]),
    windowId: Number(m[2]),
    sessionId: Number(m[3]),
  };
}

// [LAW:one-source-of-truth] Decode a single latin1-container field to real
// Unicode text, once, at this boundary — the exact idiom CommandResponse's
// own doc comment names. Every text field on WindowRecord/PaneRecord passes
// through here; no downstream consumer re-decodes.
const fieldDecoder = new TextDecoder();
function decodeField(latin1Field: string): string {
  return fieldDecoder.decode(latin1ToBytes(latin1Field));
}

// tmux's #{session_id}/#{window_id}/#{pane_id} format variables are always
// sigil-prefixed ($N / @N / %N respectively — see SPEC.md and
// parsePaneListLine's regex below); Number() on the raw field is NaN.
function parseSigilId(field: string): number {
  return Number(field.slice(1));
}

// Reverses protocol/encoder.ts's `escapeFreeTextField`: a backslash-prefixed
// `t` is a literal tab, a backslash-prefixed backslash is a literal
// backslash. Only `pane_current_path` in the tab-separated pane listing is
// encoded this way (see that function's doc comment for why the other
// free-text pane fields need no such treatment) — this is the sole reverse,
// and the two must only ever change together. `paneCwd()` reads the same
// variable alone on its line, unescaped, so its parser does not use this.
// Scanning left to right and consuming exactly one escape pair per backslash
// keeps a run of escapes unambiguous regardless of what precedes it in the
// field.
function unescapeFreeTextField(field: string): string {
  let out = "";
  for (let i = 0; i < field.length; i++) {
    const ch = field[i];
    if (ch === "\\") {
      const next = field[i + 1];
      if (next === "\\") {
        out += "\\";
        i++;
        continue;
      }
      if (next === "t") {
        out += "\t";
        i++;
        continue;
      }
    }
    out += ch;
  }
  return out;
}

/**
 * Parse one line from the fixed, library-owned `list-windows -a -F '...'`
 * format built by `listWindowsCommand()` (protocol/encoder.ts): tab-separated
 * `#{session_id} #{session_name} #{window_id} #{window_name}
 * #{window_width} #{window_height}`.
 *
 * Returns null for an unparseable line (trailing blank, unexpected field
 * count) — the caller filters, matching `parsePaneListLine`'s discipline.
 */
export function parseWindowRecordLine(line: string): WindowRecord | null {
  const fields = line.split("\t");
  if (fields.length !== 6) return null;
  const [sessionId, sessionName, windowId, windowName, width, height] = fields;
  return {
    sessionId: parseSigilId(sessionId),
    sessionName: decodeField(sessionName),
    windowId: parseSigilId(windowId),
    windowName: decodeField(windowName),
    width: Number(width),
    height: Number(height),
  };
}

/**
 * Parse one line from the fixed, library-owned `list-panes -a -F '...'`
 * format built by `listPanesCommand()` (protocol/encoder.ts): tab-separated
 * `#{session_id} #{session_name} #{window_id} #{window_name} #{pane_id}
 * #{pane_current_path} #{pane_pid} #{pane_start_command}
 * #{pane_current_command} #{pane_width} #{pane_height}`, with
 * `pane_current_path` backslash-escaped by the encoder (see
 * `escapeFreeTextField` there) so a literal tab or backslash in the cwd
 * cannot desync this split.
 *
 * Returns null for an unparseable line, same discipline as
 * `parseWindowRecordLine`.
 */
export function parsePaneRecordLine(line: string): PaneRecord | null {
  const fields = line.split("\t");
  if (fields.length !== 11) return null;
  const [
    sessionId,
    sessionName,
    windowId,
    windowName,
    paneId,
    cwd,
    pid,
    startCommand,
    currentCommand,
    width,
    height,
  ] = fields;
  return {
    sessionId: parseSigilId(sessionId),
    sessionName: decodeField(sessionName),
    windowId: parseSigilId(windowId),
    windowName: decodeField(windowName),
    paneId: parseSigilId(paneId),
    cwd: decodeField(unescapeFreeTextField(cwd)),
    pid: Number(pid),
    startCommand: decodeField(startCommand),
    currentCommand: decodeField(currentCommand),
    width: Number(width),
    height: Number(height),
  };
}

/**
 * Parse the whole reply to `newWindow()`'s `new-window -P -F` (protocol/
 * encoder.ts): exactly one line, `@N\t%N`. Returns null for any other
 * reply — a different line count included — same discipline as
 * `parseWindowRecordLine`.
 */
export function parseNewWindowReply(
  lines: readonly string[],
): NewWindowResult | null {
  const match = lines.length === 1 ? /^(@\d+)\t(%\d+)$/.exec(lines[0]) : null;
  if (match === null) return null;
  return { windowId: parseSigilId(match[1]), paneId: parseSigilId(match[2]) };
}

/**
 * Parse the whole reply to `paneCwd()`'s `display-message -p
 * '#{pane_current_path}'`: exactly one line, decoded to Unicode text, with
 * trailing `\r` CRLF residue dropped the way `parsePaneListLine` drops it
 * (see `parser.ts`'s `processLine()`). "" is tmux's answer when it cannot read the pane's cwd (dead pane,
 * or a child that does not own the pty yet); `paneCwd()` rejects it. Null for
 * any other shape, including the two lines a path with a newline prints.
 */
export function parsePaneCwdReply(lines: readonly string[]): string | null {
  return lines.length === 1 ? decodeField(lines[0].replace(/\r*$/, "")) : null;
}

/**
 * Parse one line from the fixed, library-owned `list-sessions -F '...'`
 * format built by `listSessionsCommand()` (protocol/encoder.ts): tab-separated
 * `#{session_id} #{session_name} #{session_windows} #{session_attached}`.
 *
 * Returns null for an unparseable line, same discipline as
 * `parseWindowRecordLine`/`parsePaneRecordLine`.
 *
 * `#{session_attached}` is tmux's count of attached clients (0/1/2/...), not
 * a boolean flag, so `attached` is any non-zero count rather than an
 * `=== "1"` check. Compared via `Number()`, not string equality, so a
 * trailing `\r` surviving on this field (response-block output no longer
 * strips it, since raw pane-capture bytes need it — see `parser.ts`'s
 * `feed()`) tolerates the same way `windowCount` already does, instead of
 * flipping an unattached session to attached.
 */
export function parseSessionRecordLine(line: string): SessionRecord | null {
  const fields = line.split("\t");
  if (fields.length !== 4) return null;
  const [sessionId, sessionName, windowCount, attached] = fields;
  return {
    sessionId: parseSigilId(sessionId),
    sessionName: decodeField(sessionName),
    windowCount: Number(windowCount),
    attached: Number(attached) !== 0,
  };
}
