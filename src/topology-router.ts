// src/topology-router.ts
// TopologyRouter — the shared substrate component for pane-output routing.
//
// [LAW:one-source-of-truth] Every transport client composes one TopologyRouter rather than each
//   re-implementing the topology bootstrap + notification routing + byte dispatch that would
//   otherwise be duplicated across them.
// [LAW:single-enforcer] Bootstrap policy, race-protection, and notification routing live
//   here only. Transport adapters call onTransportReady / handleNotification / dispatchBytes;
//   they do NOT own a topology table, a sink registry, or a bootstrap method.
// [LAW:effects-at-boundaries] TopologyRouter is a pure substrate: it issues commands via
//   the injected runCommand callback (provided by the transport adapter) and does nothing
//   else to the outside world. It does NOT call the emitter — non-topology notifications
//   are still passed by the transport adapter to its own emitter.

import type {
  CommandResponse,
  PaneAction,
  TmuxMessage,
} from "./protocol/types.js";
import { refreshClientPaneAction } from "./protocol/encoder.js";
import {
  SinkRegistry,
  PaneTopologyManager,
  PaneInterestTracker,
  TopologyEpochTracker,
  PANE_LIST_FORMAT,
  type Contradiction,
  parsePaneList,
  serverScope,
  type AttachOptions,
  type BytesSink,
  type ChunkPayload,
} from "./pane-output.js";
import { IdlePaneSuppressor } from "./idle-pane-suppressor.js";
import { TmuxCommandError } from "./errors.js";

/** Construction options for {@link TopologyRouter}. */
export interface TopologyRouterOptions {
  /**
   * Pause panes no attachment is interested in, continuing them when interest
   * returns. Default off — when off the router does no interest tracking and no
   * pane-action traffic, and behaves exactly as before this option existed.
   * [LAW:no-mode-explosion]
   */
  readonly idlePaneSuppression?: boolean;
}

// [LAW:types-are-the-program] The command runner is a first-class param, not
// an ambient dependency. TopologyRouter has no TmuxClient reference — the transport
// adapter injects the one capability the router needs (executing a command string).
type RunCommand = (cmd: string) => Promise<CommandResponse>;

/**
 * Reporting seam for a failed topology bootstrap.
 *
 * [LAW:effects-at-boundaries] The router is a pure substrate with no emitter; it
 *   cannot perform the notification itself. It DESCRIBES the failure by calling
 *   this seam, and the transport adapter (which owns an emitter) PERFORMS the
 *   emission — wiring it to a `topology-error` event.
 * [LAW:no-silent-failure] This is a required construction dependency, not an
 *   optional callback: a TopologyRouter that silently drops bootstrap failures
 *   is not constructible.
 */
// Cap on output held for unplaced panes (see TopologyRouter.hold).
export const HELD_BYTES_LIMIT = 4 * 1024 * 1024;

export type ReportTopologyError = (error: Error) => void;

// [LAW:no-silent-failure] A rejected command can carry any thrown value; normalize
//   to Error and give it a self-describing prefix so a consumer that logs only
//   `ev.error.message` sees the bootstrap context (not a bare `close 1006`),
//   while the original is preserved as `.cause` — the underlying reason (a real
//   tmux error, or a transport close) is not lost. [FRAMING:representation]
//   This runs on the failure path, so it must be TOTAL: `String(value)` throws
//   for a null-prototype object or a throwing `toString`, and a throw here would
//   convert the caught rejection into an unhandled one — the exact silence this
//   removes. The coercion is guarded with a structural-tag fallback.
function topologyError(query: string, value: unknown): Error {
  let detail: string;
  try {
    detail = value instanceof Error ? value.message : String(value);
  } catch {
    detail = Object.prototype.toString.call(value);
  }
  return new Error(`topology ${query} failed: ${detail}`, { cause: value });
}

// tmux's %error answer to `list-panes -t @W` for a window that no longer exists.
function isWindowGone(err: unknown): boolean {
  return (
    err instanceof TmuxCommandError &&
    err.message.startsWith("can't find window")
  );
}

/**
 * TopologyRouter is the extracted, shared substrate for pane-output routing.
 *
 * It owns the topology table, the sink registry, the epoch/generation counter
 * for race-protection, the bootstrap coordinator, and the per-notification
 * routing logic. It has zero awareness of how TmuxMessages arrive or how
 * commands depart — those are the transport adapter's concern.
 *
 * Every transport adapter composes one TopologyRouter rather than duplicating
 * the routing logic.
 *
 * [LAW:one-source-of-truth] One implementation; three transport adapters share it.
 * [LAW:decomposition] The router does exactly one thing: route pane bytes and keep
 *   the topology table current. Connection lifecycle and event emission stay in the
 *   transport adapter.
 */
export class TopologyRouter {
  // [LAW:single-enforcer] SinkRegistry is the one byte-dispatch path.
  private readonly sinks = new SinkRegistry();
  // [LAW:one-source-of-truth] PaneTopologyManager is the sole topology table.
  private readonly topology = new PaneTopologyManager();
  // [LAW:single-enforcer] TopologyEpochTracker is the ONE race-protection mechanism.
  //   No second staleness guard co-exists with it.
  private readonly epoch = new TopologyEpochTracker();

  // Injected by the transport adapter on connection-ready. Null before ready
  // and after close. Non-null is the "can issue commands" invariant.
  // [LAW:no-ambient-temporal-coupling] The state machine is: null → ready → null.
  //   onTransportReady sets it; onTransportClose clears it.
  private runCommand: RunCommand | null = null;

  // The runner topology queries use: the live connection's only. An adapter
  // may keep `runCommand` through a reconnect backoff so queued pane actions
  // reach the next connection, but a query's answer must come from the
  // connection it was asked on.
  // [LAW:no-ambient-temporal-coupling] null → ready → (lost | close) → null.
  //   onTransportLost retires it before the adapter rejects what was in flight,
  //   so every failure path's identity check sees the drop, whatever the error.
  private queryRun: RunCommand | null = null;

  // Idle-pane suppression. Both null when the feature is off (the default), in
  // which case every `this.interest?.recompute()` is a genuine no-op and the
  // router issues no pane-action traffic. [LAW:no-mode-explosion]
  // [LAW:dataflow-not-control-flow] Presence of `interest` IS the enablement;
  //   no call site branches on a boolean flag.
  private readonly suppressor: IdlePaneSuppressor | null;
  private readonly interest: PaneInterestTracker | null;

  // [LAW:effects-at-boundaries] The one seam from a failed bootstrap effect to
  //   the outside world. The router computes; this reports.
  private readonly reportTopologyError: ReportTopologyError;

  // Chunks for panes topology did not know when they arrived, held while a
  // topology query that may place them is outstanding. Each carries the attach
  // seq at arrival so replay never reaches a sink attached afterwards.
  // Empty is the resting state; releaseHeld() drains it after every query and
  // onTransportClose() discards it with the connection.
  private held: { chunk: ChunkPayload; attachedBy: number }[] = [];
  // Bytes in `held`, and bytes refused because holding them would exceed
  // HELD_BYTES_LIMIT. The refusal is reported at the next settle.
  private heldBytes = 0;
  private refusedBytes = 0;
  // Topology queries started and not yet settled. Only bootstrap() and
  // refreshWindow() start queries, so the router owns this count; the epoch
  // tracker answers staleness, not liveness.
  private inFlight = 0;

  constructor(
    reportTopologyError: ReportTopologyError,
    options?: TopologyRouterOptions,
  ) {
    this.reportTopologyError = reportTopologyError;
    if (options?.idlePaneSuppression === true) {
      // [LAW:effects-at-boundaries] The suppressor's only path to tmux is this
      //   sender, which the router gates on the live runCommand.
      this.suppressor = new IdlePaneSuppressor((paneId, action) =>
        this.sendPaneAction(paneId, action),
      );
      this.interest = new PaneInterestTracker(
        this.sinks,
        this.topology,
        this.suppressor,
      );
    } else {
      this.suppressor = null;
      this.interest = null;
    }
  }

  // [LAW:dataflow-not-control-flow] One predicate answers "does anything need
  //   the topology table populated" — topology-scoped sinks, or idle suppression
  //   (which must know every pane to pause the idle ones). Every bootstrap /
  //   refresh gate reads this single source.
  private needsTopology(): boolean {
    return this.sinks.hasTopologyDependentSinks() || this.interest !== null;
  }

  // [LAW:effects-at-boundaries] The single seam from suppression policy to tmux.
  //   Drops the action when no connection can carry it — a detached control-mode
  //   client's pauses are moot, so teardown-time continues simply do not fire.
  private sendPaneAction(paneId: number, action: PaneAction): void {
    const run = this.runCommand;
    if (run === null) return;
    // Fire-and-forget: a rejection means the pane already went away, which is
    // fine for a best-effort suppression action. [LAW:no-silent-failure] does
    // not apply — there is no downstream that depends on this succeeding.
    void run(refreshClientPaneAction(paneId, action)).catch(() => undefined);
  }

  // ---------------------------------------------------------------------------
  // Transport adapter interface
  // ---------------------------------------------------------------------------

  /**
   * Called by the transport adapter when the connection is ready to accept
   * commands (e.g., once TmuxClient has consumed tmux's unsolicited startup
   * guard block, or post-welcome for WebSocket) — i.e. connectionState
   * reaching "ready", not merely the first byte arriving.
   *
   * Stores the runCommand callback and triggers a topology bootstrap if any
   * session- or window-scoped sinks are already attached.
   *
   * Idempotent for the same readiness state — re-calling with the same
   * connection context (e.g., on reconnect) triggers a fresh bootstrap.
   */
  onTransportReady(runCommand: RunCommand): void {
    this.runCommand = runCommand;
    this.queryRun = runCommand;
    // [LAW:no-ambient-temporal-coupling] No interest "replay" is needed here.
    //   Before runCommand exists, sendPaneAction drops every action — but the
    //   only panes the tracker can mark interesting pre-ready are pane-scope
    //   ones (topology is empty until bootstrap), so the dropped action is a
    //   Continue, and a control-mode client's panes default to RUNNING. A
    //   dropped pre-ready Continue therefore targets an already-running pane: a
    //   no-op, not lost state. Nothing is ever paused pre-ready, because pausing
    //   requires a delivered Pause, which cannot happen while runCommand is null.
    //   The bootstrap below recomputes the full universe and pauses the
    //   genuinely-idle panes with runCommand set.
    if (this.needsTopology()) {
      void this.bootstrap();
    }
  }

  /**
   * Called by the transport adapter the moment the connection drops, before it
   * rejects the commands in flight. Topology queries stop until the next
   * {@link onTransportReady}, whose bootstrap re-seeds; sinks stay attached.
   */
  onTransportLost(): void {
    this.queryRun = null;
  }

  /**
   * Called by the transport adapter when the connection closes.
   *
   * Calls `end()` exactly once on every still-attached sink and clears all
   * buckets. After this call `runCommand` is null; further `dispatchBytes`
   * calls are no-ops.
   */
  onTransportClose(): void {
    this.runCommand = null;
    this.queryRun = null;
    // [LAW:no-ambient-temporal-coupling] runCommand is already null, so the
    //   suppressor's continue actions drop at the sender — this clears local
    //   paused-pane state without writing to a dead transport.
    this.suppressor?.dispose();
    this.held = [];
    this.heldBytes = 0;
    this.refusedBytes = 0;
    this.sinks.endAll();
  }

  // ---------------------------------------------------------------------------
  // Sink registration
  // ---------------------------------------------------------------------------

  /**
   * Attach a byte sink at the given scope. Returns an idempotent disposer.
   *
   * If the scope is session- or window-scoped and the connection is ready,
   * a topology bootstrap is triggered immediately (race-safe: the epoch tracker
   * ensures only the most-recent bootstrap result is applied).
   */
  attachBytesSink(sink: BytesSink, options?: AttachOptions): () => void {
    const scope = options?.scope ?? serverScope;
    const dispose = this.sinks.attach(sink, scope);
    // [LAW:dataflow-not-control-flow] Bootstrap trigger is driven by the data
    //   of the scope value and the current queryRun state — not by a flag.
    if (
      (scope.kind === "session" || scope.kind === "window") &&
      this.queryRun !== null
    ) {
      void this.bootstrap();
    }
    // Attaching changed this scope's admit count. Recompute against current
    // topology (covers server/pane scope immediately); a session/window attach
    // that triggered a bootstrap recomputes again when seed() lands.
    this.interest?.recompute();
    return () => {
      dispose();
      this.interest?.recompute();
    };
  }

  // ---------------------------------------------------------------------------
  // Byte routing
  // ---------------------------------------------------------------------------

  /**
   * Dispatch one chunk to all matching sinks.
   *
   * Called by the transport adapter for every pane-output message. The topology
   * table is consulted per-chunk (dynamic membership — a scope added after
   * attach still matches future chunks for matching panes).
   */
  dispatchBytes(payload: ChunkPayload): void {
    const meta = this.topology.get(payload.paneId);
    this.sinks.dispatch(payload, meta);
    // A pane topology does not know yet matched no window/session scope. If a
    // query in flight may still place it, hold the chunk for replay instead of
    // losing it: output provoked from another tmux client is not ordered with
    // our command stream, so it can land before the attach-triggered
    // bootstrap (or a window-add refresh) does.
    if (
      meta === undefined &&
      this.sinks.hasTopologyDependentSinks() &&
      this.inFlight > 0
    ) {
      this.hold(payload);
    }
  }

  // [LAW:no-silent-failure] A query can stall (tmux's command queue is serial:
  //   one `run-shell 'sleep 30'` delays every reply behind it), so the hold is
  //   capped. Past the cap the newest chunks are refused, keeping the earliest
  //   output this hold exists for, and the refusal is reported, not hidden.
  private hold(payload: ChunkPayload): void {
    const size = payload.data.byteLength;
    if (this.heldBytes + size > HELD_BYTES_LIMIT) {
      this.refusedBytes += size;
      return;
    }
    this.heldBytes += size;
    // ChunkPayload data may not be retained past dispatch; copy to hold.
    this.held.push({
      chunk: { ...payload, data: payload.data.slice() },
      attachedBy: this.sinks.attachSeq(),
    });
  }

  // Replay every held chunk whose pane topology now knows, in arrival order,
  // to the window/session attachments that existed when it arrived. Chunks
  // still unplaced wait while a query remains outstanding; once none does,
  // nothing can place them and they are dropped (pane/server sinks already got
  // them live). Runs synchronously at the end of every query, so per-pane
  // order holds against any chunk dispatched after it.
  // [LAW:dataflow-not-control-flow] Called unconditionally on every settle;
  //   an empty list makes it a no-op.
  private releaseHeld(): void {
    const pending = this.held;
    const run = this.runCommand;
    this.held = [];
    this.heldBytes = 0;
    if (this.refusedBytes > 0) {
      this.reportTopologyError(
        new Error(
          `topology hold overflow: ${this.refusedBytes} bytes of early output ` +
            `for unplaced panes were not delivered to session/window sinks`,
        ),
      );
      this.refusedBytes = 0;
    }
    for (const h of pending) {
      // A replayed sink's write may close the transport; the rest of this
      // episode's chunks go with it.
      if (this.runCommand !== run) return;
      const meta = this.topology.get(h.chunk.paneId);
      if (meta !== undefined) {
        this.sinks.dispatch(h.chunk, meta, {
          kind: "replay",
          attachedBy: h.attachedBy,
        });
      } else if (this.inFlight > 0) {
        // Read per chunk: a replayed sink's write may attach a topology sink,
        // which starts a query that can still place the rest.
        // Already copied and counted once; re-holding cannot exceed the cap.
        this.held.push(h);
        this.heldBytes += h.chunk.data.byteLength;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Topology notification routing
  // ---------------------------------------------------------------------------

  /**
   * Route one TmuxMessage for its topology side effects.
   *
   * The router updates the topology table and triggers refreshes as needed.
   * It does NOT emit to any event listener — the transport adapter is responsible
   * for emitting non-pane messages to its own TypedEmitter.
   *
   * [LAW:single-enforcer] All topology mutations go through here. Transport
   *   adapters do not touch the topology table or the epoch tracker directly.
   */
  handleNotification(msg: TmuxMessage): void {
    switch (msg.type) {
      case "window-add":
      case "unlinked-window-add":
      case "window-close":
      case "unlinked-window-close":
        // Each says only that the window's membership changed: a close also
        // comes for a window leaving one session that lives on in another
        // (unlink-window, move-window), and an add for a known window brought
        // along with the session it had (move-window, link-window). Its panes
        // are unplaced and any query sent before the change is discarded; the
        // refresh re-places them, or fails because the window no longer
        // exists and leaves it removed.
        this.topology.removeWindow(msg.windowId);
        this.epoch.invalidateWindow(msg.windowId);
        this.interest?.recompute();
        if (this.needsTopology()) {
          void this.refreshWindow(msg.windowId);
        }
        break;
      case "layout-change":
        // A moved pane keeps its old entry, and tmux sends %output for it
        // before list-panes answers. join-pane/move-pane show up as a pane
        // the layout lists but the table places elsewhere; break-pane only as
        // the source layout omitting the pane, then %window-add. Either way
        // the pane is unplaced now and its output held until a refresh places
        // it. The layout cannot place anything: tmux 3.8 omits floating
        // panes, and it carries no session, so list-panes decides membership.
        // A layout that did not parse lists nothing, so it contradicts nothing.
        if (this.needsTopology()) {
          if (msg.layout.kind === "parsed") {
            const panes = msg.layout.panes.map((p) => p.paneId);
            this.epoch.recordLayout(msg.windowId, panes);
            this.requery(
              this.topology.unplaceContradicted(msg.windowId, panes),
              msg.windowId,
            );
          } else {
            this.epoch.forgetLayout(msg.windowId);
            void this.refreshWindow(msg.windowId);
          }
        }
        break;
      case "session-changed":
      case "sessions-changed":
        // Re-bootstrap on a real session change (switch-client, or a session
        // added/removed elsewhere) so the topology table reflects the newly
        // attached session or session list. Transport adapters now call
        // onTransportReady only once the connection's own startup handshake
        // is consumed (see TmuxClient.awaitingGreeting), so the bootstrap
        // that triggers is no longer racing an empty FIFO — this case is not
        // compensating for that anymore. tmux also emits `session-changed`
        // once, unconditionally, right after every attach's startup guard
        // block, so this still re-fires at startup too; the epoch tracker
        // makes that redundant-but-harmless rather than load-bearing.
        if (this.needsTopology()) {
          void this.bootstrap();
        }
        break;
      default:
        // All other message types: no topology side effect.
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // Private — bootstrap and per-window refresh
  // ---------------------------------------------------------------------------

  // [LAW:single-enforcer] One bootstrap implementation. No transport adapter
  //   re-implements it.
  private async bootstrap(): Promise<void> {
    if (this.queryRun === null) return;
    const run = this.queryRun;
    const gen = this.epoch.startBootstrap();
    this.inFlight++;
    try {
      const r = await run(`list-panes -a -F '${PANE_LIST_FORMAT}'`);
      if (!this.epoch.isBootstrapCurrent(gen)) {
        // A window-close mid-flight makes this result stale without starting a
        // replacement. Still the latest bootstrap means nothing newer will
        // seed, so re-query: otherwise the topology stays empty and every held
        // chunk is dropped. The re-run counts itself in flight before this
        // finally releases, so held chunks wait for it.
        if (
          this.queryRun === run &&
          this.needsTopology() &&
          this.epoch.isLatestBootstrap(gen)
        )
          void this.bootstrap();
        return;
      }
      this.topology.seed(parsePaneList(r.output));
      // [LAW:single-enforcer] A bootstrap sent before a move lists the moved
      //   pane in its old window; the epoch tracker hands back the layouts
      //   seen since it started, and their windows' refreshes already follow
      //   the move, so only what the layouts contradict is asked again.
      const left = new Set<number>();
      let lostTrack = false;
      for (const [windowId, panes] of this.epoch.takeLayouts()) {
        const c = this.topology.unplaceContradicted(windowId, panes);
        for (const id of c.left) left.add(id);
        lostTrack ||= c.lostTrack;
      }
      this.requery({ left, lostTrack });
      this.interest?.recompute();
    } catch (err) {
      // [FRAMING:representation] A bootstrap that settles after its transport
      //   episode ended is a shutdown/reconnect artifact, not a topology fault of
      //   the CURRENT connection — `connection-state` already represents that,
      //   so a follow-on topology-error would be a misleading second signal.
      //   Compare IDENTITY, not a value: `run` is the exact runner this bootstrap
      //   used, captured at entry. `this.runCommand !== run` is true both when the
      //   transport closed (now null) AND when it closed-then-reopened (now a new
      //   runner) — the value-only `=== null` check misses the reconnect (ABA)
      //   case, where a stale rejection would fire on a healthy new connection.
      //   Not a silent drop: the current connection's own bootstrap still reports.
      if (this.queryRun !== run) return;
      // [LAW:single-enforcer] Respect the ONE staleness authority on the failure
      //   path too: if a newer bootstrap has since started, it owns the outcome
      //   (it will seed a healthy topology or report its own failure), so this
      //   superseded rejection stays silent — reporting it would be a false alarm
      //   on an already-repaired connection. A failure that is still the latest
      //   bootstrap — including one whose gen was bumped only by a window-close —
      //   IS the authoritative topology state and must surface.
      if (!this.epoch.isLatestBootstrap(gen)) return;
      // [LAW:no-silent-failure] The bootstrap effect failed. An empty topology
      //   is NOT a handled fallback here: with no topology, dispatch matches only
      //   pane- and server-scoped sinks (meta === undefined), so every
      //   session/window-scoped consumer would silently receive zero bytes,
      //   indistinguishable from a genuinely empty tmux. Lift the failure to the
      //   seam so the consumer can tell the two apart. [LAW:effects-at-boundaries]
      //   Non-terminal: the event-driven bootstrap triggers (session-changed,
      //   window events, a new topology-scoped attach) re-attempt this, so a
      //   later success recovers a starved sink — no ambient retry timer needed.
      //   [LAW:no-ambient-temporal-coupling]
      this.reportTopologyError(topologyError("bootstrap", err));
    } finally {
      this.inFlight--;
      this.releaseHeld();
    }
  }

  // The query that re-places what the table was told it got wrong: a pane lost track
  // of needs the server-wide one, which supersedes every window refresh.
  // A new refresh supersedes any sent before the move.
  private requery(c: Contradiction, ...windows: number[]): void {
    if (c.lostTrack) {
      void this.bootstrap();
      return;
    }
    for (const id of new Set([...c.left, ...windows])) {
      void this.refreshWindow(id);
    }
  }

  private async refreshWindow(windowId: number): Promise<void> {
    if (this.queryRun === null) return;
    const run = this.queryRun;
    const gen = this.epoch.startWindowRefresh(windowId);
    this.inFlight++;
    try {
      const r = await run(
        `list-panes -t @${windowId} -F '${PANE_LIST_FORMAT}'`,
      );
      if (!this.epoch.isWindowRefreshCurrent(windowId, gen)) return;
      this.requery(
        this.topology.updateWindow(windowId, parsePaneList(r.output)),
      );
      this.interest?.recompute();
    } catch (err) {
      // [LAW:single-enforcer] Same staleness authority as the success path: a
      //   newer refresh or a window-close owns this window now.
      if (!this.epoch.isWindowRefreshCurrent(windowId, gen)) return;
      // [LAW:no-silent-failure] Same shutdown-artifact rule as bootstrap: the
      //   next connection's bootstrap re-seeds, so the table is left for it.
      if (this.queryRun !== run) return;
      // A refresh is sent because the window's rows are suspect, so they go
      // whatever the failure; their panes are held, not misrouted.
      this.topology.removeWindow(windowId);
      this.interest?.recompute();
      // A window that no longer exists is the answer a close's refresh
      // expects; any other failure may have left a live window's panes
      // unplaced, so re-place them with the server-wide query and report it.
      if (!isWindowGone(err)) {
        if (this.needsTopology()) void this.bootstrap();
        this.reportTopologyError(topologyError(`refresh of @${windowId}`, err));
      }
    } finally {
      this.inFlight--;
      this.releaseHeld();
    }
  }
}
