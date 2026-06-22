// packages/pane-terminal/src/bench/fake-tmux-client.ts
//
// Deterministic stand-in for `TmuxClient` used by benches and unit tests that
// do not need a real tmux process. Structurally satisfies `TmuxConnection` —
// the PaneStream-shaped projection of the library's `TmuxClient` — so a
// `FakeTmuxClient` passes to `new PaneStream({ client })` with no cast.
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
// Real TmuxClient surface NOT modeled here — the fake implements only the
// `TmuxConnection` projection PaneStream consumes. If a consumer needs another
// method from TmuxClient's public surface, add it here — never let a bench grow
// its own private fake.

// [LAW:one-way-deps] Browser-safe core only (see pane-stream.ts) — never the
// Node-coupled root entry.
import type {
  ConnectionState,
  AttachOptions,
  BytesSink,
  TmuxEventMap,
} from "@promptctl/tmux-control-mode-js/browser";
import {
  SinkRegistry,
  PaneTopologyManager,
  serverScope,
} from "@promptctl/tmux-control-mode-js/browser";
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

/**
 * Subset of `FakeMessage` that flows through the emitter — pane bytes are
 * excluded, mirroring production's `EmitterMessage` (which `Exclude`s
 * `PaneOutputMessage`). Wildcard `'*'` listeners on a `FakeTmuxClient` see
 * only this type, so test code cannot accidentally exercise a byte-delivery
 * path that production does not have.
 *
 * [LAW:types-are-the-program] If a future bench test wants pane bytes, it
 * must call `attachBytesSink` — the wildcard surface refuses to carry
 * them, same as production.
 */
export type FakeEmitterMessage = Exclude<
  FakeMessage,
  FakeOutputMessage | FakeExtendedOutputMessage
>;

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

  // [LAW:single-enforcer] Same SinkRegistry + PaneTopologyManager as TmuxClient.
  //   `attachBytesSink` delegates to `sinks.attach`; `dispatch` calls
  //   `sinks.dispatch(msg, topology.get(paneId))` before the per-type listener
  //   fan-out so the fake's byte-sink path matches production shape. Tests that
  //   need scope-based dispatch use `seedTopology(entries)` to seed the table.
  private readonly sinks = new SinkRegistry();
  private readonly topology = new PaneTopologyManager();

  // Capture-pane invocation log + scriptable response handler. The log lets a
  // consumer assert re-mount churn on one stream issues exactly one capture;
  // the handler scripts the response payload.
  private readonly captureLog: string[] = [];
  private captureHandler: (target: string) => string = () => "";
  private commandCounter = 0;

  // Subscription RPC log. PaneStream calls `subscribeRaw` at construction and
  // `unsubscribe` at dispose; the log lets a consumer assert exactly that
  // wiring — one subscribe per pane, one matching unsubscribe.
  private readonly subscriptionLog: (
    | { kind: "subscribe"; name: string; what: string; format: string }
    | { kind: "unsubscribe"; name: string }
  )[] = [];

  // Round-trip latency injected into `execute()`. A consumer varies this to
  // measure visibility-toggle / reconnect-burst timing against a known
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
  // satisfies `TmuxConnection`. The fake never dispatches event types outside
  // `FakeMessage`, so listeners registered for unmodeled events simply never
  // fire — a behavior-correct no-op for any test that doesn't `inject*` them.
  //
  // `TmuxEventMap` does not contain `'output'` or `'extended-output'`;
  // pane bytes flow through `attachBytesSink` only.
  // The wildcard `'*'` overload's handler argument is `FakeEmitterMessage`,
  // which excludes byte messages — same shape as production's
  // `EmitterMessage`. Test code cannot accidentally rely on wildcard byte
  // delivery that real clients refuse.
  on<K extends keyof TmuxEventMap>(
    type: K,
    handler: (ev: TmuxEventMap[K]) => void,
  ): void;
  on(type: "*", handler: Handler<FakeEmitterMessage>): void;
  on(type: string, handler: Handler<never>): void {
    const set = this.listeners.get(type as FakeMessageType) ?? new Set();
    set.add(handler as Handler<FakeMessage>);
    this.listeners.set(type as FakeMessageType, set);
  }

  off<K extends keyof TmuxEventMap>(
    type: K,
    handler: (ev: TmuxEventMap[K]) => void,
  ): void;
  off(type: "*", handler: Handler<FakeEmitterMessage>): void;
  off(type: string, handler: Handler<never>): void {
    this.listeners
      .get(type as FakeMessageType)
      ?.delete(handler as Handler<FakeMessage>);
  }

  /**
   * Mimics `TmuxClient.execute(cmd)` — used by PaneStream for capture-pane.
   * The `captureHandler` is the seam tests use to script payloads (e.g. a
   * fake scrollback dump). Resolution is scheduled via `setTimeout(...,
   * roundTripMs)` so every value (including 0) yields a single, deterministic
   * macrotask boundary between the call site and the response.
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
   * `execute()`, so timing stays deterministic across both call sites.
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

  // [LAW:locality-or-seam] Pane bytes fan out via `sinks.dispatch` inside
  //   the fake's internal `dispatch` path — same shape as every other
  //   `TmuxConnection` implementation. `attachBytesSink` is the public entry.
  attachBytesSink(sink: BytesSink, options?: AttachOptions): () => void {
    return this.sinks.attach(sink, options?.scope ?? serverScope);
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
   * calls. Callers set this once and call execute() many times — the
   * persistent shape is intentional. To change the response mid-bench, call
   * this method again.
   */
  setCapturePaneResponse(handler: (target: string) => string): void {
    this.captureHandler = handler;
  }

  capturePaneCount(): number {
    return this.captureLog.length;
  }

  /**
   * Frozen snapshot of the subscribe/unsubscribe RPC log in arrival order, so a
   * consumer can assert PaneStream issues exactly one `subscribeRaw` per pane
   * and one matching `unsubscribe` at dispose.
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

  /**
   * Seed the topology table for tests that use session/window-scoped
   * attachments. The fake's execute() returns empty output so the automatic
   * bootstrap is a no-op; tests that need scope-based routing call this
   * directly before attaching sinks.
   */
  seedTopology(
    entries: readonly {
      paneId: number;
      windowId: number;
      sessionId: number;
    }[],
  ): void {
    this.topology.seed(entries);
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private dispatch(msg: FakeMessage): void {
    // [LAW:single-enforcer] Pane bytes flow exclusively through the sink
    //   registry — same channel discipline as `TmuxClient.handleMessage`
    //   and every bridge. The wildcard `'*'` listener (typed against
    //   `FakeEmitterMessage`) cannot reach byte messages, matching
    //   production where `EmitterMessage` excludes `PaneOutputMessage`.
    //
    // [LAW:types-are-the-program] `FakeOutputMessage` /
    //   `FakeExtendedOutputMessage` ARE `OutputMessage` /
    //   `ExtendedOutputMessage` (see the type aliases above), so the
    //   narrowed value is a structural `TmuxMessage` with no cast.
    if (msg.type === "output" || msg.type === "extended-output") {
      this.sinks.dispatch(msg, this.topology.get(msg.paneId));
      return;
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
