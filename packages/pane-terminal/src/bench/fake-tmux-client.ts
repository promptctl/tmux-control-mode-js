// packages/pane-terminal/src/bench/fake-tmux-client.ts
//
// Deterministic stand-in for `TmuxClient` used by every gate that does not
// need a real tmux process. Implements the surface PaneStream is documented
// to consume in design-docs/pane-session-v2.md (O2/O3/O6) — connection-state
// lifecycle, byte-output subscription, and capture-pane execution — plus
// test-only knobs to drive those inputs from a benchmark.
//
// [LAW:one-source-of-truth] Event/message and CommandResponse shapes come
//   from the library — `OutputMessage`/`ExtendedOutputMessage`/`CommandResponse`
//   are re-used as-is, never re-declared. PaneStream consuming a real
//   TmuxClient or a FakeTmuxClient sees structurally identical data.
// [LAW:behavior-not-structure] The fake exposes the *behaviors* PaneStream
//   needs (state changes, byte arrivals, capture-pane round-trips) — not the
//   internal structure of TmuxClient.
//
// Real TmuxClient surface NOT modeled here (out of scope for the gate
// harness, expanded as later steps need them):
//   - sendKeys / splitWindow / setSize / setPaneAction / setFlags / clearFlags
//   - requestReport / queryClipboard / listWindows / listPanes / detach
// If a future gate needs one of these, add it here — never let a bench grow
// its own private fake.

import type { ConnectionState } from "@promptctl/tmux-control-mode-js";
import type {
  OutputMessage,
  ExtendedOutputMessage,
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
  | FakeReconnectedMessage;

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

  // Capture-pane invocation log + scriptable response handler. Gate 4
  // (re-mount on same stream → exactly 1 capture) reads this counter; future
  // gates may script the response payload.
  private readonly captureLog: string[] = [];
  private captureHandler: (target: string) => string = () => "";
  private commandCounter = 0;

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

  on<T extends FakeMessageType>(
    type: T,
    handler: Handler<Extract<FakeMessage, { type: T }>>,
  ): void;
  on(type: "*", handler: Handler<FakeMessage>): void;
  on(type: string, handler: Handler<never>): void {
    const set = this.listeners.get(type as FakeMessageType) ?? new Set();
    set.add(handler as Handler<FakeMessage>);
    this.listeners.set(type as FakeMessageType, set);
  }

  off<T extends FakeMessageType>(
    type: T,
    handler: Handler<Extract<FakeMessage, { type: T }>>,
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

  /** Set round-trip latency (ms) for `execute()`. Used by attach + reconnect benches. */
  setRoundTripLatencyMs(ms: number): void {
    this.roundTripMs = ms;
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private dispatch(msg: FakeMessage): void {
    this.listeners.get(msg.type)?.forEach((h) => h(msg));
    this.listeners.get("*")?.forEach((h) => h(msg));
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
