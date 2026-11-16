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
  ChunkPayload,
  EmitterTmuxMessage,
  RunCommand,
  SubscriptionSurface,
  TmuxConnection,
  TmuxEventMap,
} from "@promptctl/tmux-control-mode-js/browser";
import {
  DeliveryQueue,
  TopologyRouter,
  isConnectionGone,
  subscribeRaw,
  unsubscribe,
} from "@promptctl/tmux-control-mode-js/browser";
import { PaneStream } from "./window-terminal-internals.ts";
import type {
  PaneStreamOptions,
  PaneActivity,
  PaneStreamState,
} from "./window-terminal-internals.ts";
import type { CommandResponse } from "@promptctl/tmux-control-mode-js/protocol";
import type { ConnState, TmuxBridge } from "./bridge.ts";
import { toConnectionState } from "./bridge.ts";

// ---------------------------------------------------------------------------
// BridgePaneStreamClient
// ---------------------------------------------------------------------------

/**
 * Adapts a `TmuxBridge` (demo's push-subscription interface) to the
 * `TmuxConnection` surface that `PaneStream` consumes. Create one per bridge;
 * share across all `PaneStream` instances for the same session.
 *
 * The adapter subscribes to `bridge.onPaneOutput`, `bridge.onEvent` and
 * `bridge.onState` in its constructor. These subscriptions live for the
 * adapter's lifetime (which is
 * the app's lifetime in the demo — the bridge is never replaced).
 */
export class BridgePaneStreamClient
  implements TmuxConnection, SubscriptionSurface
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
  // [LAW:single-enforcer] Pane bytes are routed by the same TopologyRouter
  //   every connector in the library composes: this adapter feeds it the
  //   bridge's bytes, notifications and connection changes, and owns no
  //   topology of its own.
  // [LAW:single-enforcer] The queue owns when consumer code runs, as in the
  //   library's connectors: each bridge callback is one step, and the events
  //   it announces are delivered after it, behind the sink writes and
  //   topology errors the router posted before them.
  private readonly delivery = new DeliveryQueue();
  private readonly router = new TopologyRouter(this.delivery, (error) =>
    this.emit({ type: "topology-error", error }),
  );
  // Tells the router the current connection is gone. Before the first ready
  // there is none, so there is nothing to retire.
  private retire: () => void = () => undefined;

  constructor(private readonly bridge: TmuxBridge) {
    // [LAW:dataflow-not-control-flow] One bridge subscription fans out to
    // per-event-type handler sets. No subscribe/unsubscribe churn when panes
    // mount/unmount — the bridge subscription is stable for the adapter's
    // lifetime; the per-type sets grow/shrink as PaneStream instances attach.
    // [LAW:single-enforcer] Pane bytes reach consumers through the router's
    //   sinks only, stepped in the same queue as events so arrival order holds.
    bridge.onPaneOutput((chunk) =>
      this.delivery.step(this.onBridgeOutput, chunk),
    );
    bridge.onEvent((ev) => this.delivery.step(this.onBridgeEvent, ev));
    bridge.onState((state) => this.delivery.step(this.onBridgeState, state));
  }

  private readonly onBridgeOutput = (chunk: ChunkPayload): void => {
    this.router.dispatchBytes(chunk);
  };

  // The router takes what topology needs from every event, which then fans
  // out to its type's handlers.
  private readonly onBridgeEvent = (ev: EmitterTmuxMessage): void => {
    this.router.handleNotification(ev);
    this.announce(ev);
  };

  private readonly onBridgeState = (state: ConnState): void => {
    // [LAW:no-ambient-temporal-coupling] The router moves to the new
    //   connection before any consumer hears of it, so a `connection-state`
    //   handler never queries a dropped connection. The bridge reconnects
    //   after `closed`, and each PaneStream keeps its sink across that, so
    //   leaving `ready` is a lost connection, never the router's close
    //   (which ends every sink for good).
    this.retire();
    this.retire = () => undefined;
    if (state === "ready") {
      // The runner names the connection: each ready gets its own, so late
      // evidence about an earlier connection retires nothing.
      // [LAW:no-ambient-temporal-coupling] A reply saying the connection is
      //   gone can beat the bridge's own state change (Electron's
      //   BRIDGE_CLOSED races main's `closed` over IPC; the server's error
      //   frame races its socket's close); it retires the connection, as
      //   the library's renderer runner does. Both demo bridges answer
      //   BRIDGE_CLOSED only for a connection that is gone.
      const run: RunCommand = (command) =>
        this.execute(command).catch((err: unknown) => {
          if (isConnectionGone(err)) this.router.onTransportLost(run);
          throw err;
        });
      this.router.onTransportReady(run);
      this.retire = () => this.router.onTransportLost(run);
    }
    const next = toConnectionState(state);
    const changed = next.status !== this._connectionState.status;
    this._connectionState = next;
    if (changed) this.announce({ type: "connection-state", state: next });
    if (state !== "ready") return;
    if (this.everReady) {
      // [LAW:single-enforcer] The only place that decides "this is a
      // reconnect" for all PaneStream instances on this bridge.
      this.announce({ type: "reconnected" });
    }
    this.everReady = true;
  };

  private announce(ev: TmuxEventMap[keyof TmuxEventMap]): void {
    this.delivery.post(this.emit, ev);
  }

  get connectionState(): ConnectionState {
    return this._connectionState;
  }

  // Delivered by the queue: the router posts topology errors to it, and
  // announce posts every other event.
  private readonly emit = (ev: TmuxEventMap[keyof TmuxEventMap]): void => {
    const set = this.handlers.get(ev.type);
    if (set === undefined) return;
    for (const h of [...set]) (h as (e: typeof ev) => void)(ev);
  };

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

  setSize(width: number, height: number): Promise<CommandResponse> {
    return this.bridge.setSize(width, height);
  }

  setWindowSize(
    windowId: number,
    width: number,
    height: number,
  ): Promise<CommandResponse> {
    return this.bridge.setWindowSize(windowId, width, height);
  }

  clearWindowSize(windowId: number): Promise<CommandResponse> {
    return this.bridge.clearWindowSize(windowId);
  }

  attachBytesSink(sink: BytesSink, options?: AttachOptions): () => void {
    return this.router.attachBytesSink(sink, options);
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
