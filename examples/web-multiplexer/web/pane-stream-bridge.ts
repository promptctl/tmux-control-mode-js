// examples/web-multiplexer/web/pane-stream-bridge.ts
//
// Two adapters that wire the demo's `TmuxBridge` pub/sub API to the
// `@promptctl/pane-terminal` package's `TmuxClientLike` surface, plus a MobX
// observable wrapper around `PaneStream`.
//
// [LAW:locality-or-seam] The seam is here — not scattered across every
//   component. `BridgePaneStreamClient` is the only place that knows the
//   difference between `TmuxBridge.onEvent(handler)` (push-subscription,
//   unsubscribe-via-return) and `TmuxClientLike.on/off` (explicit registry).
//   One class absorbs the impedance mismatch; nothing downstream sees it.
// [LAW:one-source-of-truth] One `BridgePaneStreamClient` per bridge.
//   All `PaneStream` instances share it; no duplicate bridge subscriptions.
// [LAW:dataflow-not-control-flow] MobX boxes in `ObservablePaneStream` mirror
//   the stream's events into reactive values. The UI reads the boxes; it
//   never subscribes to `PaneStream.on()` directly.

import { makeAutoObservable, runInAction } from "mobx";
import type {
  ConnectionState,
  PaneByteSink,
  TmuxClientLike,
  TmuxEventMap,
} from "@promptctl/tmux-control-mode-js";
import { attachPaneSinkViaEmitter } from "@promptctl/tmux-control-mode-js";
import { PaneStream } from "@promptctl/pane-terminal/stream";
import type {
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

// `reconnected` event payload — derived from the library's TmuxEventMap so
// any future shape change at the source propagates here automatically.
type ReconnectedMessage = TmuxEventMap["reconnected"];
import { tmuxEscape } from "../../../src/protocol/encoder.js";
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
 * `TmuxClientLike` surface that `PaneStream` consumes. Create one per bridge;
 * share across all `PaneStream` instances for the same session.
 *
 * The adapter subscribes to `bridge.onEvent` and `bridge.onState` in its
 * constructor. These subscriptions live for the adapter's lifetime (which is
 * the app's lifetime in the demo — the bridge is never replaced).
 */
export class BridgePaneStreamClient implements TmuxClientLike {
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
      // [LAW:types-are-the-program] `ev` is the canonical `TmuxMessage`
      // discriminated union; narrowing on `ev.type` produces the exact
      // variant the per-type handler set expects, with no cast needed.
      if (ev.type === "output") {
        for (const h of this.outputSet) h(ev);
      } else if (ev.type === "extended-output") {
        for (const h of this.extOutputSet) h(ev);
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

  // The generic `on`/`off` overloads accept any `keyof TmuxEventMap` so this
  // adapter structurally satisfies `TmuxClientLike`. The bridge only routes
  // events for the four types this adapter cares about; listeners registered
  // for any other event type sit in no set and are correctly never fired.
  on<K extends keyof TmuxEventMap>(
    event: K,
    handler: (ev: TmuxEventMap[K]) => void,
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

  off<K extends keyof TmuxEventMap>(
    event: K,
    handler: (ev: TmuxEventMap[K]) => void,
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

  // [LAW:single-enforcer] Each segment is escaped via `tmuxEscape` from
  // `src/protocol/encoder.ts`, the canonical quoting authority for tmux
  // command arguments. Callers today pass only library-controlled values
  // (literal subscription name + `%<paneId>` + literal format), but reusing
  // the encoder's escaping discipline prevents drift if untrusted input
  // ever flows through here.
  subscribeRaw(
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

  // [LAW:locality-or-seam] Bridge events flow through this adapter's per-type
  //   handler sets (the `outputSet` / `extOutputSet` above). `attachPaneSink`
  //   adapts that emitter shape to the `PaneByteSink` seam via the shared
  //   library helper — same shape as every other emitter-backed bridge.
  // [LAW:single-enforcer] One implementation, shared with the library's
  //   bridge classes.
  attachPaneSink(paneId: number, sink: PaneByteSink): () => void {
    return attachPaneSinkViaEmitter(this, paneId, sink);
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
