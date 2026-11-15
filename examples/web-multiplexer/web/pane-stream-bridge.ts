// examples/web-multiplexer/web/pane-stream-bridge.ts
//
// Two adapters that wire the demo's `TmuxBridge` pub/sub API to the
// window-terminal engine's `TmuxConnection` surface, plus a MobX
// observable wrapper around `PaneStream`.
//
// [LAW:locality-or-seam] The seam is here — not scattered across every
//   component. `BridgePaneStreamClient` is the only place that knows the
//   difference between `TmuxBridge.onEvent(handler)` (push-subscription,
//   unsubscribe-via-return) and `TmuxConnection.on/off` (explicit registry).
//   One class absorbs the impedance mismatch; nothing downstream sees it.
// [LAW:one-source-of-truth] One `BridgePaneStreamClient` per bridge.
//   All `PaneStream` instances share it; no duplicate bridge subscriptions.
// [LAW:dataflow-not-control-flow] MobX boxes in `ObservablePaneStream` mirror
//   the stream's events into reactive values. The UI reads the boxes; it
//   never subscribes to `PaneStream.on()` directly.

import { makeAutoObservable, runInAction } from "mobx";
// [LAW:one-way-deps] Browser code imports the pure pane-output core from the
// `/browser` subpath, never the root entry — the root pulls the Node-only
// transport (`node:child_process`), which a browser bundle cannot resolve.
import type {
  ConnectionState,
  AttachOptions,
  BytesSink,
  ClientSizeSurface,
  SubscriptionSurface,
  TmuxConnection,
  TmuxEventMap,
} from "@promptctl/tmux-control-mode-js/browser";
import {
  SinkRegistry,
  PaneTopologyManager,
  TopologyEpochTracker,
  parsePaneListLine,
  serverScope,
  subscribeRaw,
  unsubscribe,
  setSize,
  setWindowSize,
  clearWindowSize,
} from "@promptctl/tmux-control-mode-js/browser";
import { PaneStream } from "./window-terminal-internals.ts";
import type {
  PaneStreamOptions,
  PaneActivity,
  PaneStreamState,
} from "./window-terminal-internals.ts";
import type { CommandResponse } from "@promptctl/tmux-control-mode-js/protocol";
import type { ConnState, TmuxBridge } from "./bridge.ts";

function mapConnState(s: ConnState): ConnectionState {
  if (s === "ready") return { status: "ready" };
  if (s === "closed") return { status: "closed", reason: "transport-error" };
  return { status: "connecting" };
}

// ---------------------------------------------------------------------------
// BridgePaneStreamClient
// ---------------------------------------------------------------------------

/**
 * Adapts a `TmuxBridge` (demo's push-subscription interface) to the
 * `TmuxConnection` surface that `PaneStream` consumes. Create one per bridge;
 * share across all `PaneStream` instances for the same session.
 *
 * The adapter subscribes to `bridge.onEvent` and `bridge.onState` in its
 * constructor. These subscriptions live for the adapter's lifetime (which is
 * the app's lifetime in the demo — the bridge is never replaced).
 */
export class BridgePaneStreamClient
  implements TmuxConnection, SubscriptionSurface, ClientSizeSurface
{
  private _connectionState: ConnectionState = { status: "connecting" };
  // Becomes true on the first `ready` transition; subsequent `ready`
  // transitions are reconnects and fire the registered handlers.
  private everReady = false;

  // [LAW:one-source-of-truth] One registry keyed by event type: every
  //   non-byte event the bridge carries, plus the synthetic `connection-state`
  //   and `reconnected`, reaches whoever subscribed to it — the same surface a
  //   `TmuxClient` offers, so the window terminal follows a bridged window.
  private readonly handlers = new Map<string, Set<(ev: never) => void>>();
  // [LAW:single-enforcer] Same SinkRegistry + PaneTopologyManager every
  //   `TmuxConnection` in the monorepo uses. `attachBytesSink` delegates to
  //   `sinks.attach`; the bridge.onEvent handler calls
  //   `sinks.dispatch(ev, topology.get(paneId))` before the per-type fan-out.
  private readonly sinks = new SinkRegistry();
  private readonly topology = new PaneTopologyManager();
  private readonly topologyEpoch = new TopologyEpochTracker();

  constructor(private readonly bridge: TmuxBridge) {
    // [LAW:dataflow-not-control-flow] One bridge subscription fans out to
    // per-event-type handler sets. No subscribe/unsubscribe churn when panes
    // mount/unmount — the bridge subscription is stable for the adapter's
    // lifetime; the per-type sets grow/shrink as PaneStream instances attach.
    bridge.onEvent((ev) => {
      // [LAW:single-enforcer] Sinks fire BEFORE the per-type listener
      //   fan-out, matching `TmuxClient.handleMessage`. The registry's
      //   per-chunk snapshot isolates the attachment set from re-entrant
      //   attach/detach inside `sink.write`.
      // [LAW:single-enforcer] Pane bytes leave the bridge through the sink
      //   registry only — the per-pane `PaneStream` subscribes via
      //   `attachBytesSink(paneScope)`, never `on("output")`. Dispatch fires
      //   the registry's per-chunk snapshot, isolating the attachment set
      //   from re-entrant attach/detach inside `sink.write`.
      if (ev.type === "output" || ev.type === "extended-output") {
        this.sinks.dispatch(ev, this.topology.get(ev.paneId));
        return;
      }
      // Topology events update the table in lock-step with TmuxClient.
      if (ev.type === "layout-change") {
        // list-panes, not ev.layout: membership needs every pane, and tmux
        // 3.8 omits floating panes from the layout string.
        if (this.sinks.hasTopologyDependentSinks()) {
          void this.refreshWindowTopology(ev.windowId);
        }
      } else if (
        ev.type === "window-add" ||
        ev.type === "unlinked-window-add"
      ) {
        if (this.sinks.hasTopologyDependentSinks()) {
          void this.refreshWindowTopology(ev.windowId);
        }
      } else if (
        ev.type === "window-close" ||
        ev.type === "unlinked-window-close"
      ) {
        this.topology.removeWindow(ev.windowId);
        this.topologyEpoch.invalidateWindow(ev.windowId);
      } else if (ev.type === "sessions-changed") {
        if (this.sinks.hasTopologyDependentSinks()) {
          void this.bootstrapTopology();
        }
      }
      // Pane bytes already returned above (sink channel); every other event
      // fans out to its type's handlers.
      this.emit(ev);
    });

    bridge.onState((state) => {
      const wasReady = this.everReady;
      const next = mapConnState(state);
      const changed = next.status !== this._connectionState.status;
      this._connectionState = next;
      if (changed) this.emit({ type: "connection-state", state: next });
      if (state === "ready") {
        if (wasReady) {
          // [LAW:single-enforcer] The only place that decides "this is a
          // reconnect" for all PaneStream instances on this bridge.
          this.emit({ type: "reconnected" });
        }
        this.everReady = true;
        if (this.sinks.hasTopologyDependentSinks()) {
          void this.bootstrapTopology();
        }
      }
    });
  }

  get connectionState(): ConnectionState {
    return this._connectionState;
  }

  private emit(ev: TmuxEventMap[keyof TmuxEventMap]): void {
    const set = this.handlers.get(ev.type);
    if (set === undefined) return;
    for (const h of [...set]) (h as (e: typeof ev) => void)(ev);
  }

  on<K extends keyof TmuxEventMap>(
    event: K,
    handler: (ev: TmuxEventMap[K]) => void,
  ): void;
  on(event: string, handler: (ev: never) => void): void {
    let set = this.handlers.get(event);
    if (set === undefined) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler);
  }

  off<K extends keyof TmuxEventMap>(
    event: K,
    handler: (ev: TmuxEventMap[K]) => void,
  ): void;
  off(event: string, handler: (ev: never) => void): void {
    this.handlers.get(event)?.delete(handler);
  }

  execute(command: string): Promise<CommandResponse> {
    return this.bridge.execute(command);
  }

  // The demo's own bridge server keeps no per-peer subscription ledger, so a
  // subscription here is the plain `refresh-client -B` command.
  subscribeRaw(
    name: string,
    what: string,
    format: string,
  ): Promise<CommandResponse> {
    return subscribeRaw(this, name, what, format);
  }

  unsubscribe(name: string): Promise<CommandResponse> {
    return unsubscribe(this, name);
  }

  // Nor any claims on the client's size: a size here is the plain
  // `refresh-client -C`.
  setSize(width: number, height: number): Promise<CommandResponse> {
    return setSize(this, width, height);
  }

  setWindowSize(
    windowId: number,
    width: number,
    height: number,
  ): Promise<CommandResponse> {
    return setWindowSize(this, windowId, width, height);
  }

  clearWindowSize(windowId: number): Promise<CommandResponse> {
    return clearWindowSize(this, windowId);
  }

  // [LAW:locality-or-seam] Pane bytes fan out via `sinks.dispatch` in the
  //   bridge.onEvent handler above — same shape as every other
  //   `TmuxConnection` implementation. `attachBytesSink` is the public entry.
  attachBytesSink(sink: BytesSink, options?: AttachOptions): () => void {
    const scope = options?.scope ?? serverScope;
    const dispose = this.sinks.attach(sink, scope);
    if (
      (scope.kind === "session" || scope.kind === "window") &&
      this._connectionState.status === "ready"
    ) {
      void this.bootstrapTopology();
    }
    return dispose;
  }

  private async bootstrapTopology(): Promise<void> {
    const gen = this.topologyEpoch.startBootstrap();
    try {
      const r = await this.execute(
        "list-panes -a -F '#{pane_id} #{window_id} #{session_id}'",
      );
      if (!this.topologyEpoch.isBootstrapCurrent(gen)) return;
      const entries = r.output.flatMap((line) => {
        const parsed = parsePaneListLine(line);
        return parsed !== null ? [parsed] : [];
      });
      this.topology.seed(entries);
    } catch {
      /* non-fatal */
    }
  }

  private async refreshWindowTopology(windowId: number): Promise<void> {
    const gen = this.topologyEpoch.startWindowRefresh(windowId);
    try {
      const r = await this.execute(
        `list-panes -t @${windowId} -F '#{pane_id} #{window_id} #{session_id}'`,
      );
      if (!this.topologyEpoch.isWindowRefreshCurrent(windowId, gen)) return;
      const entries = r.output.flatMap((line) => {
        const parsed = parsePaneListLine(line);
        return parsed !== null ? [parsed] : [];
      });
      this.topology.updateWindow(windowId, entries);
    } catch {
      this.topology.removeWindow(windowId);
    }
  }
}

// [LAW:one-source-of-truth] Duration after the last byte for which `isActive`
// stays true. Lives here (activity model) not in the display layer.
const ACTIVITY_TTL_MS = 2000;

// ---------------------------------------------------------------------------
// ObservablePaneStream
// ---------------------------------------------------------------------------

/**
 * Wraps `PaneStream` and mirrors its `'state-changed'` and
 * `'activity-changed'` events into MobX observable boxes via `runInAction`.
 * UI components read `stream.state` and `stream.activity` as regular
 * MobX-observable values — no direct `PaneStream.on()` subscriptions in
 * component code.
 *
 * [LAW:one-source-of-truth] `PaneStream` is the single owner of state and
 * activity; this class mirrors, never duplicates.
 */
export class ObservablePaneStream {
  state: PaneStreamState;
  activity: PaneActivity = { lastByteAt: 0, bytesSinceLastAttach: 0 };
  // [LAW:dataflow-not-control-flow] `isActive` is a value with an explicit
  // lifetime, not a `Date.now()` computation in render. The timer is the sole
  // authority that clears it; MobX propagates the change to the UI.
  isActive = false;

  /** The underlying data carrier — pass to `<PaneTerminal stream={...} />`. */
  readonly stream: PaneStream;
  private _activityTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: PaneStreamOptions) {
    this.stream = new PaneStream(opts);
    this.state = this.stream.state;
    makeAutoObservable<this, "stream" | "_activityTimer">(this, {
      stream: false,
      _activityTimer: false,
    });
    this.stream.on("state-changed", (s) =>
      runInAction(() => {
        this.state = s;
      }),
    );
    this.stream.on("activity-changed", (a) =>
      runInAction(() => {
        this.activity = a;
        this.isActive = true;
        if (this._activityTimer !== null) clearTimeout(this._activityTimer);
        this._activityTimer = setTimeout(
          () =>
            runInAction(() => {
              this.isActive = false;
            }),
          ACTIVITY_TTL_MS,
        );
      }),
    );
  }

  dispose(): void {
    if (this._activityTimer !== null) clearTimeout(this._activityTimer);
    this.stream.dispose();
  }
}
