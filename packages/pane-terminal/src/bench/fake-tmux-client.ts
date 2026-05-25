// packages/pane-terminal/src/bench/fake-tmux-client.ts
//
// Deterministic stand-in for `TmuxClient` used by every gate that does not
// need a real tmux process. Structurally satisfies `TmuxClientLike` — the
// PaneStream-shaped projection of the library's `TmuxClient` — so benches and
// unit tests can pass a `FakeTmuxClient` to `new PaneStream({ client })` with
// no cast.
//
// [LAW:one-source-of-truth] Event/message and CommandResponse shapes come
//   from the library — `OutputMessage`/`ExtendedOutputMessage`/`CommandResponse`/
//   `SubscriptionChangedMessage` are re-used as-is, never re-declared.
//   PaneStream consuming a real TmuxClient or a FakeTmuxClient sees
//   structurally identical data.
// [LAW:behavior-not-structure] The fake exposes the *behaviors* PaneStream
//   needs (state changes, byte arrivals, capture-pane round-trips,
//   subscribe/unsubscribe round-trips, subscription-changed delivery) — not
//   the internal structure of TmuxClient.
//
// Real TmuxClient surface NOT modeled here (out of scope for the gate
// harness, expanded as later steps need them):
//   - sendKeys / splitWindow / setSize / setPaneAction / setFlags / clearFlags
//   - requestReport / queryClipboard / listWindows / listPanes / detach
// If a future gate needs one of these, add it here — never let a bench grow
// its own private fake.

import type {
  ConnectionState,
  PaneByteSink,
  TmuxEventMap,
} from "@promptctl/tmux-control-mode-js";
import { PaneSinkRegistry } from "@promptctl/tmux-control-mode-js";
import type {
  OutputMessage,
  ExtendedOutputMessage,
  SubscriptionChangedMessage,
  CommandResponse,
} from "@promptctl/tmux-control-mode-js/protocol";

// Ambient `setTimeout` — `tsconfig.core.json` deliberately ships no DOM or
// Node types so core stays environment-agnostic. The fake's `execute()` needs
// timer semantics that exist in both runtimes; declaring the minimal shape
// here keeps the env-agnostic invariant ([LAW:locality-or-seam]) intact
// without dragging in `@types/node` or `lib.dom`.
declare const setTimeout: (handler: () => void, ms?: number) => unknown;

// The fake emits the subset of events PaneStream subscribes to. Pane-output
// events use the library's exact shape (paneId + `data: Uint8Array`) so
// PaneStream does not need a real-vs-fake adapter.
export type FakeOutputMessage = OutputMessage;
export type FakeExtendedOutputMessage = ExtendedOutputMessage;

export interface FakeConnectionStateMessage {
  readonly type: "connection-state";
  readonly state: ConnectionState;
}

export interface FakeReconnectedMessage {
  readonly type: "reconnected";
}

export type FakeMessage =
  | FakeOutputMessage
  | FakeExtendedOutputMessage
  | FakeConnectionStateMessage
  | FakeReconnectedMessage
  | SubscriptionChangedMessage;

export type FakeMessageType = FakeMessage["type"];

type Handler<T> = (ev: T) => void;

/**
 * Synchronous-injection fake. All lifecycle is driven by test code; the fake
 * never runs timers of its own. This is what makes the bench deterministic.
 */
export class FakeTmuxClient {
  // [LAW:one-source-of-truth] connectionState mirrors the library union; no
  // bespoke "fake" lifecycle vocabulary.
  private currentState: ConnectionState = { status: "connecting" };

  // [LAW:single-enforcer] One listener registry; per-event lookups come from
  // here only, so test-only `inject()` and consumer-facing `on/off` cannot
  // diverge.
  private readonly listeners = new Map<
    FakeMessageType | "*",
    Set<Handler<FakeMessage>>
  >();

  // [LAW:single-enforcer] Same `PaneSinkRegistry` every other
  //   `TmuxClientLike` in the monorepo uses. `attachPaneSink` delegates to
  //   it; `dispatch` calls `paneSinks.dispatch(msg)` before the per-type
  //   listener fan-out so the fake's byte-sink path matches production
  //   shape (pre-emit snapshot, throw-isolation from listener Set
  //   iteration). Tests that script throws on `on('output', …)` listeners
  //   would otherwise observe behavior the production bridges don't.
  private readonly paneSinks = new PaneSinkRegistry();

  // Capture-pane invocation log + scriptable response handler. Gate 4
  // (re-mount on same stream → exactly 1 capture) reads this counter; future
  // gates may script the response payload.
  private readonly captureLog: string[] = [];
  private captureHandler: (target: string) => string = () => "";
  private commandCounter = 0;

  // Subscription RPC log. PaneStream calls `subscribeRaw` at construction and
  // `unsubscribe` at dispose; the layout-change integration test inspects
  // these entries to verify the wiring.
  private readonly subscriptionLog: (
    | { kind: "subscribe"; name: string; what: string; format: string }
    | { kind: "unsubscribe"; name: string }
  )[] = [];

  // Round-trip latency injected into `execute()`. Gates 1 and 7 vary this to
  // measure the visibility-toggle / reconnect-burst timings against a known
  // simulated tmux response time. Default 0 = next-macrotask resolution.
  private roundTripMs = 0;

  // -------------------------------------------------------------------------
  // Public TmuxClient-shaped surface (subset)
  // -------------------------------------------------------------------------

  get connectionState(): ConnectionState {
    return this.currentState;
  }

  // The `on`/`off` overloads accept any `keyof TmuxEventMap` (matching the
  // library's `TmuxClient.on`/`off`) so a `FakeTmuxClient` structurally
  // satisfies `TmuxClientLike`. The fake never dispatches event types outside
  // `FakeMessage`, so listeners registered for unmodeled events simply never
  // fire — a behavior-correct no-op for any test that doesn't `inject*` them.
  on<K extends keyof TmuxEventMap>(
    type: K,
    handler: (ev: TmuxEventMap[K]) => void,
  ): void;
  on(type: "*", handler: Handler<FakeMessage>): void;
  on(type: string, handler: Handler<never>): void {
    const set = this.listeners.get(type as FakeMessageType) ?? new Set();
    set.add(handler as Handler<FakeMessage>);
    this.listeners.set(type as FakeMessageType, set);
  }

  off<K extends keyof TmuxEventMap>(
    type: K,
    handler: (ev: TmuxEventMap[K]) => void,
  ): void;
  off(type: "*", handler: Handler<FakeMessage>): void;
  off(type: string, handler: Handler<never>): void {
    this.listeners
      .get(type as FakeMessageType)
      ?.delete(handler as Handler<FakeMessage>);
  }

  /**
   * Mimics `TmuxClient.execute(cmd)` — used by PaneStream for capture-pane.
   * The `captureHandler` is the seam tests use to script payloads (e.g. a
   * fake scrollback dump). Resolution is scheduled via `setTimeout(...,
   * roundTripMs)` for every value (including 0) so gates 1/7 get a single,
   * deterministic macrotask boundary between the call site and the response.
   */
  execute(command: string): Promise<CommandResponse> {
    if (command.startsWith("capture-pane")) {
      this.captureLog.push(command);
    }
    const payload = this.captureHandler(command);
    const commandNumber = ++this.commandCounter;
    return new Promise((resolve) => {
      setTimeout(
        () =>
          resolve({
            commandNumber,
            timestamp: Date.now(),
            output: payload === "" ? [] : payload.split("\n"),
            success: true,
          }),
        this.roundTripMs,
      );
    });
  }

  /**
   * Models `TmuxClient.subscribeRaw` — appended to `subscriptionLog` and
   * resolved via the same `setTimeout(..., roundTripMs)` ladder as
   * `execute()`, so gate timing stays deterministic across both call sites.
   * No-op behaviorally: the fake does not auto-emit `subscription-changed`
   * messages. Use `injectSubscriptionChanged()` to drive the listener.
   */
  subscribeRaw(
    name: string,
    what: string,
    format: string,
  ): Promise<CommandResponse> {
    this.subscriptionLog.push({ kind: "subscribe", name, what, format });
    return this.resolveAck();
  }

  unsubscribe(name: string): Promise<CommandResponse> {
    this.subscriptionLog.push({ kind: "unsubscribe", name });
    return this.resolveAck();
  }

  // [LAW:locality-or-seam] Pane bytes fan out to sinks from
  //   `paneSinks.dispatch(msg)` inside the fake's internal `dispatch`
  //   path (see below) — the same shape as every other
  //   `TmuxClientLike` implementation. `attachPaneSink` is the public
  //   entry into that registry.
  attachPaneSink(paneId: number, sink: PaneByteSink): () => void {
    return this.paneSinks.attach(paneId, sink);
  }

  close(): void {
    this.setConnectionState({ status: "closed", reason: "disposed" });
    this.listeners.clear();
  }

  // -------------------------------------------------------------------------
  // Test-only knobs (intentionally distinct names — the production surface
  // never grows a `setX` for these because they are environmental.)
  // -------------------------------------------------------------------------

  /** Drive a state transition. Idempotent — repeating the same state is a no-op. */
  setConnectionState(next: ConnectionState): void {
    if (sameState(this.currentState, next)) return;
    const previous = this.currentState;
    this.currentState = next;
    this.dispatch({ type: "connection-state", state: next });
    if (previous.status === "reconnecting" && next.status === "ready") {
      this.dispatch({ type: "reconnected" });
    }
  }

  /** Push a byte chunk as if tmux had emitted it for the given pane. */
  injectOutput(paneId: number, data: Uint8Array): void {
    this.dispatch({ type: "output", paneId, data });
  }

  /** Push an extended-output (paused-pane catch-up) chunk. */
  injectExtendedOutput(paneId: number, data: Uint8Array, age: number): void {
    this.dispatch({ type: "extended-output", paneId, age, data });
  }

  /**
   * Push a `subscription-changed` event matching `SubscriptionChangedMessage`
   * exactly. Test code drives layout/size changes through this path; the fake
   * does not auto-emit on `subscribeRaw`.
   */
  injectSubscriptionChanged(
    name: string,
    paneId: number,
    value: string,
    opts: {
      readonly sessionId?: number;
      readonly windowId?: number;
      readonly windowIndex?: number;
    } = {},
  ): void {
    this.dispatch({
      type: "subscription-changed",
      name,
      sessionId: opts.sessionId ?? -1,
      windowId: opts.windowId ?? -1,
      windowIndex: opts.windowIndex ?? -1,
      paneId,
      value,
    });
  }

  /**
   * Persistently script the response body for *all subsequent* capture-pane
   * calls. Gates 1/4/7 set this once and call execute() many times — the
   * persistent shape is intentional. To change the response mid-bench, call
   * this method again.
   */
  setCapturePaneResponse(handler: (target: string) => string): void {
    this.captureHandler = handler;
  }

  /** How many capture-pane invocations have happened since construction. */
  capturePaneCount(): number {
    return this.captureLog.length;
  }

  /**
   * Frozen snapshot of the subscribe/unsubscribe RPC log in arrival order.
   * The integration-test path for layout subscriptions reads this to assert
   * "PaneStream issues exactly one `subscribeRaw` per pane and one matching
   * `unsubscribe` at dispose."
   */
  subscriptionLogEntries(): readonly (
    | { kind: "subscribe"; name: string; what: string; format: string }
    | { kind: "unsubscribe"; name: string }
  )[] {
    return this.subscriptionLog;
  }

  /** Set round-trip latency (ms) for `execute()`. Used by attach + reconnect benches. */
  setRoundTripLatencyMs(ms: number): void {
    this.roundTripMs = ms;
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private dispatch(msg: FakeMessage): void {
    // [LAW:single-enforcer] Sinks fire BEFORE the per-type listener
    //   fan-out, matching `TmuxClient.handleMessage` and every bridge.
    //   The registry's pre-emit snapshot isolates the per-chunk
    //   attachment set from re-entrant attach/detach inside `sink.write`,
    //   and running before `listeners` keeps canonical sink delivery
    //   resilient to throws in deprecated `on('output', …)` listeners.
    //
    // [LAW:types-are-the-program] Narrow to the pane-byte variants
    //   before handing off — `FakeOutputMessage` / `FakeExtendedOutputMessage`
    //   ARE `OutputMessage` / `ExtendedOutputMessage` (see the type
    //   aliases above), so the narrowed value is a structural
    //   `TmuxMessage` with no cast. Fake-only variants
    //   (`FakeConnectionStateMessage`, `FakeReconnectedMessage`) never
    //   reach `dispatch`, which is correct — the registry would no-op on
    //   them anyway.
    if (msg.type === "output" || msg.type === "extended-output") {
      this.paneSinks.dispatch(msg);
    }
    this.listeners.get(msg.type)?.forEach((h) => h(msg));
    this.listeners.get("*")?.forEach((h) => h(msg));
  }

  private resolveAck(): Promise<CommandResponse> {
    const commandNumber = ++this.commandCounter;
    return new Promise((resolve) => {
      setTimeout(
        () =>
          resolve({
            commandNumber,
            timestamp: Date.now(),
            output: [],
            success: true,
          }),
        this.roundTripMs,
      );
    });
  }
}

function sameState(a: ConnectionState, b: ConnectionState): boolean {
  if (a.status !== b.status) return false;
  if (a.status === "reconnecting" && b.status === "reconnecting") {
    return a.attempt === b.attempt && a.lastError === b.lastError;
  }
  if (a.status === "closed" && b.status === "closed") {
    return a.reason === b.reason;
  }
  return true;
}
