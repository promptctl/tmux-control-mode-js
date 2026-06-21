// src/pane-output.ts
// Scope-based pane output subscriptions.
//
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
//   is the one topology writer. Neither is duplicated across TmuxClientLike impls.

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
 * Callers:
 * - `seed(entries)` — wholesale replace on bootstrap (list-panes -a output).
 * - `updateWindow(windowId, entries)` — differential update on layout-change
 *   (list-panes -t @W output); removes stale panes, adds new ones.
 * - `removeWindow(windowId)` — drop all panes for a closed window.
 * - `get(paneId)` — per-chunk lookup in SinkRegistry.dispatch.
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

// Internal per-scope bucket: token → sink. Token is unique per attachment.
type Bucket = Map<symbol, BytesSink>;

/**
 * Scope-bifurcated registry for `BytesSink` attachments.
 *
 * Stores attachments in four buckets keyed by scope kind. Dispatch for a
 * given `paneId` iterates all four matching buckets (pane, window, session,
 * server) and calls `sink.write(msg)` for each — in that order, most to
 * least specific.
 *
 * [LAW:single-enforcer] One dispatch path. All TmuxClientLike implementations
 *   own one instance; none duplicate the snapshot logic or the bucket layout.
 * [LAW:dataflow-not-control-flow] dispatch() runs the same four bucket lookups
 *   on every chunk. Which buckets are non-empty is data, not guarded control.
 * [LAW:types-are-the-program] Token-keyed Maps make per-attachment identity
 *   structural: each attach() call yields an independent entry even for the
 *   same sink instance, with no "is this sink already attached" check needed.
 */
export class SinkRegistry {
  // [LAW:one-source-of-truth] Four buckets are the sole attachment state.
  //   attach() writes one bucket. dispose() deletes from exactly that bucket.
  //   dispatch() reads all matching buckets. No second index exists.
  private readonly serverAttachments: Bucket = new Map();
  private readonly sessionAttachments = new Map<number, Bucket>();
  private readonly windowAttachments = new Map<number, Bucket>();
  private readonly paneAttachments = new Map<number, Bucket>();

  /**
   * Attach a sink to the given scope. Returns an idempotent disposer.
   *
   * Each call is an independent attachment — the same sink may be attached
   * multiple times; each yields its own token and disposer. The disposer
   * calls `sink.end()` exactly once on the first invocation.
   */
  attach(sink: BytesSink, scope: PaneScope): () => void {
    const token = Symbol("BytesSink");
    const bucket = this.getOrCreateBucket(scope);
    bucket.set(token, sink);

    // [LAW:dataflow-not-control-flow] Idempotency is structural — delete()
    //   returns true only on the first removal, so end() fires at most once
    //   without a separate `disposed` flag.
    return () => {
      const removed = bucket.delete(token);
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
   */
  dispatch(msg: ChunkPayload, meta: PaneMeta | undefined): void {
    // Snapshot all four buckets synchronously before any write() call.
    const paneSnap = snapshotBucket(this.paneAttachments.get(msg.paneId));
    const windowSnap =
      meta !== undefined
        ? snapshotBucket(this.windowAttachments.get(meta.windowId))
        : EMPTY;
    const sessionSnap =
      meta !== undefined
        ? snapshotBucket(this.sessionAttachments.get(meta.sessionId))
        : EMPTY;
    const serverSnap = snapshotBucket(this.serverAttachments);

    // [LAW:no-defensive-null-guards] All four snaps are non-null; EMPTY is
    //   a shared frozen array. The early exit is a performance gate (avoid
    //   iterating four empty arrays on the common no-consumer path), not a
    //   defensive null check.
    if (
      paneSnap === EMPTY &&
      windowSnap === EMPTY &&
      sessionSnap === EMPTY &&
      serverSnap === EMPTY
    )
      return;

    for (const sink of paneSnap) sink.write(msg);
    for (const sink of windowSnap) sink.write(msg);
    for (const sink of sessionSnap) sink.write(msg);
    for (const sink of serverSnap) sink.write(msg);
  }

  private getOrCreateBucket(scope: PaneScope): Bucket {
    switch (scope.kind) {
      case "server":
        return this.serverAttachments;
      case "session": {
        let b = this.sessionAttachments.get(scope.sessionId);
        if (b === undefined) {
          b = new Map();
          this.sessionAttachments.set(scope.sessionId, b);
        }
        return b;
      }
      case "window": {
        let b = this.windowAttachments.get(scope.windowId);
        if (b === undefined) {
          b = new Map();
          this.windowAttachments.set(scope.windowId, b);
        }
        return b;
      }
      case "pane": {
        let b = this.paneAttachments.get(scope.paneId);
        if (b === undefined) {
          b = new Map();
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
   * holds disposers from earlier `attach()` calls — the inner bucket Maps are
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
    ];
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

// [LAW:one-source-of-truth] Shared frozen empty array reused for every
//   absent bucket. `readonly never[]` is assignable to `readonly BytesSink[]`
//   and iterates zero times — no allocation on the no-consumer path.
const EMPTY: readonly never[] = Object.freeze([]);

function snapshotBucket(bucket: Bucket | undefined): readonly BytesSink[] {
  if (bucket === undefined || bucket.size === 0) return EMPTY;
  return Array.from(bucket.values());
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
 * [LAW:one-type-per-behavior] All TmuxClientLike implementations share this
 *   one tracker type; the staleness invariant is encoded here, not repeated
 *   in each client.
 * [LAW:dataflow-not-control-flow] The generation number IS a value — the
 *   proof that an async result belongs to the current topology epoch. The
 *   check is data deciding whether a result is authoritative, not control
 *   flow skipping an operation.
 */
export class TopologyEpochTracker {
  private bootstrapGen = 0;
  private readonly windowGens = new Map<number, number>();
  // [LAW:types-are-the-program] Global monotone counter — each startWindowRefresh
  // call gets a strictly-greater-than-all-prior token. After startBootstrap()
  // clears windowGens, any new startWindowRefresh still produces a token that
  // cannot alias a pre-clear token, because it is drawn from a sequence that
  // only ever increases. Per-window counters that reset after a clear would
  // allow pre-clear and post-clear tokens to collide (both start at 1).
  private windowEpoch = 0;

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
    return ++this.bootstrapGen;
  }

  /** Call before applying seed(). Returns false if a newer event superseded this query. */
  isBootstrapCurrent(gen: number): boolean {
    return this.bootstrapGen === gen;
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
 */
export function parsePaneListLine(
  line: string,
): { paneId: number; windowId: number; sessionId: number } | null {
  const m = line.match(/^%(\d+) @(\d+) \$(\d+)$/);
  if (m === null) return null;
  return {
    paneId: Number(m[1]),
    windowId: Number(m[2]),
    sessionId: Number(m[3]),
  };
}
