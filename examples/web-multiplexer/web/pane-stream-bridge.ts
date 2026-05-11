// examples/web-multiplexer/web/pane-stream-bridge.ts
//
// Two adapters that wire the demo's `TmuxBridge` pub/sub API to the
// `@promptctl/pane-terminal` package's `PaneStreamClient` + `PaneStream`.
//
// [LAW:locality-or-seam] The seam is here — not scattered across every
//   component. `BridgePaneStreamClient` is the only place that knows the
//   difference between `TmuxBridge.onEvent(handler)` (push-subscription,
//   unsubscribe-via-return) and `PaneStreamClient.on/off` (explicit registry).
//   One class absorbs the impedance mismatch; nothing downstream sees it.
// [LAW:one-source-of-truth] One `BridgePaneStreamClient` per bridge.
//   All `PaneStream` instances share it; no duplicate bridge subscriptions.
// [LAW:dataflow-not-control-flow] MobX boxes in `ObservablePaneStream` mirror
//   the stream's events into reactive values. The UI reads the boxes; it
//   never subscribes to `PaneStream.on()` directly.

import { makeAutoObservable, runInAction } from "mobx";
import type { ConnectionState } from "@promptctl/tmux-control-mode-js";
import { PaneStream } from "@promptctl/pane-terminal/stream";
import type {
  PaneStreamClient,
  PaneStreamOptions,
  PaneActivity,
  PaneStreamState,
} from "@promptctl/pane-terminal/stream";
import type {
  OutputMessage,
  ExtendedOutputMessage,
  SubscriptionChangedMessage,
  CommandResponse,
} from "../../../src/protocol/types.js";
import { tmuxEscape } from "../../../src/protocol/encoder.js";
import type { ConnState, TmuxBridge } from "./bridge.ts";

// Local structural match for the synthetic reconnect event shape that
// `PaneStream` expects from its client. Not exported from the package.
interface ReconnectedMessage {
  readonly type: "reconnected";
}

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
 * `PaneStreamClient` interface that `PaneStream` consumes. Create one per
 * bridge; share across all `PaneStream` instances for the same session.
 *
 * The adapter subscribes to `bridge.onEvent` and `bridge.onState` in its
 * constructor. These subscriptions live for the adapter's lifetime (which is
 * the app's lifetime in the demo — the bridge is never replaced).
 */
export class BridgePaneStreamClient implements PaneStreamClient {
  private _connectionState: ConnectionState = { status: "connecting" };
  // Becomes true on the first `ready` transition; subsequent `ready`
  // transitions are reconnects and fire the registered handlers.
  private everReady = false;

  private readonly outputSet = new Set<(ev: OutputMessage) => void>();
  private readonly extOutputSet = new Set<(ev: ExtendedOutputMessage) => void>();
  private readonly reconnectedSet = new Set<(ev: ReconnectedMessage) => void>();
  private readonly subChangedSet = new Set<
    (ev: SubscriptionChangedMessage) => void
  >();

  constructor(private readonly bridge: TmuxBridge) {
    // [LAW:dataflow-not-control-flow] One bridge subscription fans out to
    // per-event-type handler sets. No subscribe/unsubscribe churn when panes
    // mount/unmount — the bridge subscription is stable for the adapter's
    // lifetime; the per-type sets grow/shrink as PaneStream instances attach.
    bridge.onEvent((ev) => {
      if (ev.type === "output") {
        for (const h of this.outputSet) h(ev as unknown as OutputMessage);
      } else if (ev.type === "extended-output") {
        for (const h of this.extOutputSet) h(ev as unknown as ExtendedOutputMessage);
      } else if (ev.type === "subscription-changed") {
        for (const h of this.subChangedSet) h(ev);
      }
    });

    bridge.onState((state) => {
      const wasReady = this.everReady;
      this._connectionState = mapConnState(state);
      if (state === "ready") {
        if (wasReady) {
          // [LAW:single-enforcer] The only place that decides "this is a
          // reconnect" for all PaneStream instances on this bridge.
          for (const h of this.reconnectedSet) h({ type: "reconnected" });
        }
        this.everReady = true;
      }
    });
  }

  get connectionState(): ConnectionState {
    return this._connectionState;
  }

  on(event: "output", handler: (ev: OutputMessage) => void): void;
  on(
    event: "extended-output",
    handler: (ev: ExtendedOutputMessage) => void,
  ): void;
  on(event: "reconnected", handler: (ev: ReconnectedMessage) => void): void;
  on(
    event: "subscription-changed",
    handler: (ev: SubscriptionChangedMessage) => void,
  ): void;
  on(event: string, handler: (ev: never) => void): void {
    if (event === "output")
      this.outputSet.add(handler as (ev: OutputMessage) => void);
    else if (event === "extended-output")
      this.extOutputSet.add(handler as (ev: ExtendedOutputMessage) => void);
    else if (event === "reconnected")
      this.reconnectedSet.add(handler as (ev: ReconnectedMessage) => void);
    else if (event === "subscription-changed")
      this.subChangedSet.add(handler as (ev: SubscriptionChangedMessage) => void);
  }

  off(event: "output", handler: (ev: OutputMessage) => void): void;
  off(
    event: "extended-output",
    handler: (ev: ExtendedOutputMessage) => void,
  ): void;
  off(event: "reconnected", handler: (ev: ReconnectedMessage) => void): void;
  off(
    event: "subscription-changed",
    handler: (ev: SubscriptionChangedMessage) => void,
  ): void;
  off(event: string, handler: (ev: never) => void): void {
    if (event === "output")
      this.outputSet.delete(handler as (ev: OutputMessage) => void);
    else if (event === "extended-output")
      this.extOutputSet.delete(handler as (ev: ExtendedOutputMessage) => void);
    else if (event === "reconnected")
      this.reconnectedSet.delete(handler as (ev: ReconnectedMessage) => void);
    else if (event === "subscription-changed")
      this.subChangedSet.delete(
        handler as (ev: SubscriptionChangedMessage) => void,
      );
  }

  execute(command: string): Promise<CommandResponse> {
    return this.bridge.execute(command);
  }

  // PaneStream consumes this via the optional `subscribe?` capability on
  // `PaneStreamClient`. Without it, `PaneStream.subscribeToSize()` short-
  // circuits and `XtermSink.resize(cols, rows)` is never driven — terminals
  // stay at xterm's default 80x24 regardless of actual tmux pane size.
  //
  // [LAW:single-enforcer] Each segment is escaped via `tmuxEscape` from
  // `src/protocol/encoder.ts`, the canonical quoting authority for tmux
  // command arguments. Callers today pass only library-controlled values
  // (literal subscription name + `%<paneId>` + literal format), but reusing
  // the encoder's escaping discipline prevents drift if untrusted input
  // ever flows through here.
  subscribe(
    name: string,
    what: string,
    format: string,
  ): Promise<CommandResponse> {
    return this.bridge.execute(
      `refresh-client -B ${tmuxEscape(name)}:${tmuxEscape(what)}:${tmuxEscape(format)}`,
    );
  }

  unsubscribe(name: string): Promise<CommandResponse> {
    return this.bridge.execute(`refresh-client -B ${tmuxEscape(name)}`);
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
  isActive: boolean = false;

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
    this.stream.on("state-changed", (s) => runInAction(() => { this.state = s; }));
    this.stream.on("activity-changed", (a) => runInAction(() => {
      this.activity = a;
      this.isActive = true;
      if (this._activityTimer !== null) clearTimeout(this._activityTimer);
      this._activityTimer = setTimeout(
        () => runInAction(() => { this.isActive = false; }),
        ACTIVITY_TTL_MS,
      );
    }));
  }

  dispose(): void {
    if (this._activityTimer !== null) clearTimeout(this._activityTimer);
    this.stream.dispose();
  }
}
