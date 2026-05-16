// packages/pane-terminal/src/stream/reseed-scheduler.ts
//
// `ReseedScheduler` — one per `TmuxClient`, owns reconnect-driven re-seed
// dispatch ordering across every `PaneStream` registered to that client.
// Streams declare their priority and reseed callback; the scheduler decides
// who paints first.
//
// [LAW:one-source-of-truth] One scheduler per client (module-scope WeakMap),
//   so the reconnect handler is registered exactly once per `TmuxClient` and
//   the priority decision lives in one place.
// [LAW:single-enforcer] All reconnect-triggered re-seeds flow through
//   `runReseed()`. Streams cannot self-dispatch on `'reconnected'`.
// [LAW:dataflow-not-control-flow] The handler always runs the same dispatch
//   loop; the priority *value* each registered stream returns decides what
//   happens.
//
// O6 from design-docs/pane-session-v2.md: visible-attached → other-attached
// → detached. Detached streams need nothing (tmux re-emits live bytes once
// reconnected; the next attach will trigger a fresh capture-pane).

import type { TmuxClientLike } from "./pane-stream.js";

// Ambient `Promise` is part of ES2022 lib (already in tsconfig.core.json).
// Nothing else here needs DOM/Node globals.

/**
 * Reseed priority for a stream. Lower = earlier dispatch.
 * - 0 visible-attached (sink visible AND has non-zero box; user is looking)
 * - 1 other-attached  (sink attached but offscreen / minimized tab)
 * - 2 detached        (no sink; the scheduler skips these)
 */
export type ReseedPriority = 0 | 1 | 2;

/**
 * A registrant the scheduler can ask "what's your priority right now?" and
 * "please re-seed yourself, sequentially with the others." `PaneStream`
 * implements this interface — the scheduler does not know about state
 * machines or capture-pane, only about ordering and sequencing.
 */
export interface ReseedTarget {
  /** Current priority. Read once per dispatch sweep. */
  priority(): ReseedPriority;
  /** Perform the re-seed. The scheduler awaits this before moving on. */
  reseed(): Promise<void>;
}

export class ReseedScheduler {
  private readonly registered = new Set<ReseedTarget>();
  private currentRun: Promise<void> | null = null;
  private readonly client: TmuxClientLike;

  // Pre-bound reconnect handler — created once at construction so the
  // scheduler can `off()` itself if a future API ever needs to (e.g. when
  // the WeakMap entry is replaced under a re-keyed client during testing).
  private readonly onReconnected = (): void => {
    void this.runReseed();
  };

  constructor(client: TmuxClientLike) {
    this.client = client;
    // O6: subscribe ONCE per client. PaneStreams register themselves with
    // *us*; the client doesn't see N handlers for one event.
    client.on("reconnected", this.onReconnected);
  }

  register(target: ReseedTarget): void {
    this.registered.add(target);
  }

  unregister(target: ReseedTarget): void {
    this.registered.delete(target);
  }

  /** Tests inspect this. */
  size(): number {
    return this.registered.size;
  }

  /**
   * Dispatch a reseed pass across all registered targets. If a previous run
   * is still in flight (e.g. reconnect fired again before the first sweep
   * finished), the second call returns the in-flight Promise — sequential
   * dispatch is preserved across overlapping reconnects.
   *
   * Public so tests can drive it directly without waiting for a real
   * reconnect event.
   */
  runReseed(): Promise<void> {
    if (this.currentRun !== null) return this.currentRun;
    this.currentRun = this.dispatch().finally(() => {
      this.currentRun = null;
    });
    return this.currentRun;
  }

  private async dispatch(): Promise<void> {
    // Snapshot order at the start of the sweep. Streams may register or
    // unregister mid-dispatch; the snapshot keeps the visible→attached
    // ordering stable, while the membership check below skips any
    // stream that disposed itself between snapshot and its turn.
    const snapshot = Array.from(this.registered);
    snapshot.sort((a, b) => a.priority() - b.priority());

    for (const t of snapshot) {
      if (!this.registered.has(t)) continue; // disposed mid-sweep
      if (t.priority() >= 2) continue; // detached — nothing to reseed
      // Sequential await: tmux is single-threaded; parallel capture-pane
      // requests just queue at the protocol layer, and serializing keeps
      // first-paint latency for the visible stream tight.
      await t.reseed();
    }
  }
}

// ---------------------------------------------------------------------------
// Module-scope per-client registry
// ---------------------------------------------------------------------------

// [LAW:one-source-of-truth] Module-scope WeakMap keyed by client. A second
// `getScheduler(sameClient)` always returns the same scheduler — the
// reconnect handler is therefore registered exactly once per client over
// the client's lifetime.
const SCHEDULERS = new WeakMap<TmuxClientLike, ReseedScheduler>();

export function getScheduler(client: TmuxClientLike): ReseedScheduler {
  const existing = SCHEDULERS.get(client);
  if (existing !== undefined) return existing;
  const created = new ReseedScheduler(client);
  SCHEDULERS.set(client, created);
  return created;
}
