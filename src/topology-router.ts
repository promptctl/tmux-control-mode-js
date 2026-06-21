// src/topology-router.ts
// TopologyRouter — the shared substrate component for pane-output routing.
//
// [LAW:one-source-of-truth] All three transport clients (TmuxClient, WebSocketTmuxClient,
//   TmuxClientProxy) compose one TopologyRouter rather than each re-implementing the ~240
//   lines of topology bootstrap + notification routing + byte dispatch that were duplicated.
// [LAW:single-enforcer] Bootstrap policy, race-protection, and notification routing live
//   here only. Transport adapters call onTransportReady / handleNotification / dispatchBytes;
//   they do NOT own a topology table, a sink registry, or a bootstrap method.
// [LAW:effects-at-boundaries] TopologyRouter is a pure substrate: it issues commands via
//   the injected runCommand callback (provided by the transport adapter) and does nothing
//   else to the outside world. It does NOT call the emitter — non-topology notifications
//   are still passed by the transport adapter to its own emitter.

import type { CommandResponse, TmuxMessage } from "./protocol/types.js";
import {
  SinkRegistry,
  PaneTopologyManager,
  TopologyEpochTracker,
  parsePaneListLine,
  serverScope,
  type AttachOptions,
  type BytesSink,
  type ChunkPayload,
} from "./pane-output.js";

// [LAW:types-are-the-program] The command runner is a first-class param, not
// an ambient dependency. TopologyRouter has no TmuxClient reference — the transport
// adapter injects the one capability the router needs (executing a command string).
type RunCommand = (cmd: string) => Promise<CommandResponse>;

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

  // ---------------------------------------------------------------------------
  // Transport adapter interface
  // ---------------------------------------------------------------------------

  /**
   * Called by the transport adapter when the connection is ready to accept
   * commands (e.g., first byte from tmux stdout, or post-welcome for WebSocket).
   *
   * Stores the runCommand callback and triggers a topology bootstrap if any
   * session- or window-scoped sinks are already attached.
   *
   * Idempotent for the same readiness state — re-calling with the same
   * connection context (e.g., on reconnect) triggers a fresh bootstrap.
   */
  onTransportReady(runCommand: RunCommand): void {
    this.runCommand = runCommand;
    if (this.sinks.hasTopologyDependentSinks()) {
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
    return dispose;
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
        break;
      case "window-add":
      case "unlinked-window-add":
      case "layout-change":
        if (this.sinks.hasTopologyDependentSinks()) {
          void this.refreshWindow(msg.windowId);
        }
        break;
      case "sessions-changed":
        if (this.sinks.hasTopologyDependentSinks()) {
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
    } catch {
      // Non-fatal: topology races are handled at dispatch time via the fallback
      // to server-scope and pane-scope buckets even when meta is undefined.
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
    } catch {
      this.topology.removeWindow(windowId);
    }
  }
}
