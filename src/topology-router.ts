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
  parsePaneListLine,
  serverScope,
  type AttachOptions,
  type BytesSink,
  type ChunkPayload,
} from "./pane-output.js";
import { IdlePaneSuppressor } from "./idle-pane-suppressor.js";

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
export type ReportTopologyError = (error: Error) => void;

// [LAW:no-silent-failure] A rejected command can carry any thrown value; normalize
//   to Error and give it a self-describing prefix so a consumer that logs only
//   `ev.error.message` sees the bootstrap context (not a bare `close 1006`),
//   while the original is preserved as `.cause` — the underlying reason (a real
//   tmux error, or a transport close) is not lost. [FRAMING:representation]
function bootstrapError(value: unknown): Error {
  const cause = value instanceof Error ? value : new Error(String(value));
  return new Error(`topology bootstrap failed: ${cause.message}`, { cause });
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
   * Called by the transport adapter when the connection closes.
   *
   * Calls `end()` exactly once on every still-attached sink and clears all
   * buckets. After this call `runCommand` is null; further `dispatchBytes`
   * calls are no-ops.
   */
  onTransportClose(): void {
    this.runCommand = null;
    // [LAW:no-ambient-temporal-coupling] runCommand is already null, so the
    //   suppressor's continue actions drop at the sender — this clears local
    //   paused-pane state without writing to a dead transport.
    this.suppressor?.dispose();
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
    //   of the scope value and the current runCommand state — not by a flag.
    if (
      (scope.kind === "session" || scope.kind === "window") &&
      this.runCommand !== null
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
    this.sinks.dispatch(payload, this.topology.get(payload.paneId));
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
      case "window-close":
      case "unlinked-window-close":
        // Synchronous topology removal + epoch invalidation. Any in-flight
        // list-panes result for this window will be discarded by the epoch check.
        this.topology.removeWindow(msg.windowId);
        this.epoch.invalidateWindow(msg.windowId);
        this.interest?.recompute();
        break;
      case "window-add":
      case "unlinked-window-add":
      case "layout-change":
        if (this.needsTopology()) {
          void this.refreshWindow(msg.windowId);
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
    if (this.runCommand === null) return;
    const run = this.runCommand;
    const gen = this.epoch.startBootstrap();
    try {
      const r = await run(
        "list-panes -a -F '#{pane_id} #{window_id} #{session_id}'",
      );
      if (!this.epoch.isBootstrapCurrent(gen)) return;
      const entries = r.output.flatMap((line) => {
        const parsed = parsePaneListLine(line);
        return parsed !== null ? [parsed] : [];
      });
      this.topology.seed(entries);
      this.interest?.recompute();
    } catch (err) {
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
      this.reportTopologyError(bootstrapError(err));
    }
  }

  private async refreshWindow(windowId: number): Promise<void> {
    if (this.runCommand === null) return;
    const run = this.runCommand;
    const gen = this.epoch.startWindowRefresh(windowId);
    try {
      const r = await run(
        `list-panes -t @${windowId} -F '#{pane_id} #{window_id} #{session_id}'`,
      );
      if (!this.epoch.isWindowRefreshCurrent(windowId, gen)) return;
      const entries = r.output.flatMap((line) => {
        const parsed = parsePaneListLine(line);
        return parsed !== null
          ? [{ paneId: parsed.paneId, sessionId: parsed.sessionId }]
          : [];
      });
      this.topology.updateWindow(windowId, entries);
      this.interest?.recompute();
    } catch {
      this.topology.removeWindow(windowId);
      this.interest?.recompute();
    }
  }
}
