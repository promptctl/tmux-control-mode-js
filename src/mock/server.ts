// src/mock/server.ts
// MockTmuxServer — a protocol-faithful, in-process tmux control-mode endpoint.
//
// It is the parser run backwards behind a transport: it speaks the exact wire
// the real `tmux -C` speaks (via serializeMessage), framing every command the
// client sends in a `%begin … %end`/`%error` guard block and pushing scripted
// notifications — with NO tmux process, NO child_process, NO sockets. Drop it
// into `new TmuxClient(server)` and the whole library runs against a scripted
// scenario; that is both the library's own deterministic integration harness
// and the tutorial ("learn the protocol without installing tmux").
//
// [LAW:decomposition] Two parts, cut clean:
//   - MECHANISM (this class): command numbering, FIFO guard-block framing,
//     serialization, the TmuxTransport surface, delivery ordering. Protocol-
//     universal; knows nothing about any particular session.
//   - POLICY (the injected MockScenario): what a command replies with and what
//     topology greets the client. Per-scenario; knows nothing about framing.
// [LAW:effects-at-boundaries] Pure: no Node deps (TmuxTransport is a type-only
//   import, erased at runtime), no clock unless one is injected. The same build
//   runs in Node tests and the browser tutorial.

import type { TmuxTransport, SendResult } from "../transport/types.js";
import { createCloseGate } from "../transport/close-gate.js";
import type { TmuxMessage } from "../protocol/types.js";
import { serializeMessage } from "../protocol/serializer.js";

// ---------------------------------------------------------------------------
// Scenario — the policy seam
// ---------------------------------------------------------------------------

/**
 * The reply a sent command produces, as a discriminated union so the two
 * outcomes (success → `%end`, failure → `%error`) are distinct by construction
 * rather than a boolean a callsite must remember to read.
 * [LAW:types-are-the-program]
 */
export type CommandReply =
  | { readonly kind: "ok"; readonly output?: readonly string[] }
  | { readonly kind: "error"; readonly output?: readonly string[] };

/**
 * A scripted scenario: pure policy the server consults. It never frames,
 * numbers, or serializes — that is the server's job.
 */
export interface MockScenario {
  /**
   * Notifications delivered to the client the moment {@link MockTmuxServer.start}
   * is called — the initial topology a freshly-attached control client would
   * see. Optional; omit for a server that only reacts to commands.
   */
  readonly greeting?: readonly TmuxMessage[];

  /**
   * Reactive reply for one command line (already newline-stripped). Return
   * `undefined` to accept the default: `{ kind: "ok" }` with no output — which
   * is exactly how real tmux answers the majority of commands. MUST be pure:
   * return the reply as data; do not call {@link MockTmuxServer.emit} from here
   * (that would be an effect mid-decision and could interleave a notification
   * into a guard block). [LAW:effects-at-boundaries]
   */
  respond?(command: string): CommandReply | undefined;
}

/**
 * Construction options. The clock is the one world-effect the server needs (the
 * `%begin`/`%end` timestamp); injecting it keeps the core deterministic — tests
 * get a fixed value, the tutorial passes a real wall clock.
 * [LAW:no-ambient-temporal-coupling]
 */
export interface MockServerOptions {
  /** Seconds-since-epoch source for guard timestamps. Default: `() => 0`. */
  readonly now?: () => number;
}

// [LAW:one-source-of-truth] SPEC.md §4 / SPEC_MANIFEST §4: control-client
// command guards carry flags = 1 (CMDQ_STATE_CONTROL). The client never reads
// this field; it is emitted for wire fidelity (the tutorial shows the real
// shape).
const CONTROL_FLAGS = 1;

const DEFAULT_SCENARIO: MockScenario = {};

// ---------------------------------------------------------------------------
// MockTmuxServer
// ---------------------------------------------------------------------------

export class MockTmuxServer implements TmuxTransport {
  private readonly scenario: MockScenario;
  private readonly now: () => number;

  private readonly dataCallbacks: ((chunk: string) => void)[] = [];

  // [LAW:one-source-of-truth] Same shared gate the real transports use — one
  // definition of "closed, and why" and exactly-once dispatch, not a third
  // independent copy of the pattern.
  private readonly closeGate = createCloseGate();

  // [LAW:single-enforcer] Command numbering lives here only — one monotonic
  // counter, incremented per command, shared by a command's begin and end/error
  // guards. The client correlates by FIFO order, not by this value (SPEC §4);
  // the number is opaque-but-faithful.
  private commandNumber = 0;

  // Line buffer for inbound commands — tmux reads LF-terminated input
  // (EVBUFFER_EOL_LF), so a `send()` may carry a partial or batched command;
  // we split on "\n" and act per complete line.
  private inputBuffer = "";

  // [LAW:no-ambient-temporal-coupling] Outbound delivery is owned by an explicit
  // trampoline, never event-loop timing. send()/emit()/start() ENQUEUE whole
  // wire lines and call flush(); flush is re-entrancy-guarded, so a notification
  // produced synchronously while a prior line is being delivered (e.g. the
  // bootstrap command TmuxClient issues the instant it sees the greeting) is
  // appended and drained by the outer loop — never delivered re-entrantly into
  // the parser. Delivery is synchronous + deterministic; real tmux's async
  // timing is out of scope here and is added by the chaos decorator (.19).
  private readonly outbound: string[] = [];
  private flushing = false;

  private started = false;

  // The commands the client has sent, newline-stripped, in order — for assertions.
  private readonly commandLog: string[] = [];

  constructor(
    scenario: MockScenario = DEFAULT_SCENARIO,
    options?: MockServerOptions,
  ) {
    this.scenario = scenario;
    this.now = options?.now ?? (() => 0);
  }

  // -------------------------------------------------------------------------
  // TmuxTransport surface
  // -------------------------------------------------------------------------

  send(command: string): SendResult {
    // [LAW:no-silent-failure] A closed mock refuses like a dead tmux would —
    // the seam's contract, not a test convenience.
    if (this.closeGate.state().closed) {
      return { ok: false, reason: this.closeGate.deniedSendReason() };
    }
    this.inputBuffer += command;

    // [LAW:dataflow-not-control-flow] Every complete line runs the same handle
    // step; the line's content (empty = detach, else a command) decides the
    // effect, not a branch on whether to process. The `!closed` guard is not
    // a control-flow branch on content — it stops the batch the instant a
    // line closes the transport, since a detach mid-batch (SPEC §4.1) ends
    // the connection and no line after it was ever going to reach a live
    // tmux.
    let newlineIdx = this.inputBuffer.indexOf("\n");
    while (newlineIdx !== -1 && !this.closeGate.state().closed) {
      const line = this.inputBuffer.slice(0, newlineIdx);
      this.inputBuffer = this.inputBuffer.slice(newlineIdx + 1);
      this.handleCommandLine(line);
      newlineIdx = this.inputBuffer.indexOf("\n");
    }
    return { ok: true };
  }

  onData(callback: (chunk: string) => void): void {
    this.dataCallbacks.push(callback);
  }

  onClose(callback: (reason?: string) => void): void {
    this.closeGate.onClose(callback);
  }

  close(): void {
    this.closeGate.dispatch(undefined);
  }

  // -------------------------------------------------------------------------
  // Scripting surface — what tests and the tutorial drive
  // -------------------------------------------------------------------------

  /**
   * Begin the session: deliver the scenario's greeting topology. Idempotent —
   * the greeting is delivered at most once, so a double call (or a re-attach)
   * does not double-seed.
   *
   * [LAW:one-source-of-truth] Real tmux emits one unsolicited %begin/%end
   * guard pair on attach, before any client-issued command's response or any
   * notification (SPEC.md §5) — TmuxClient depends on seeing exactly this
   * shape to leave "connecting" (see TmuxClient.awaitingGreeting). Emitting
   * it here, ahead of the scenario's own greeting notifications, keeps this
   * mock protocol-faithful: without it, every client attached to this server
   * would treat its first real command's guard block as the unsolicited
   * greeting and hang forever waiting for a response that already happened.
   */
  start(): void {
    if (this.closeGate.state().closed || this.started) return;
    this.started = true;
    const number = ++this.commandNumber;
    const timestamp = this.now();
    this.enqueueMessage({
      type: "begin",
      timestamp,
      commandNumber: number,
      flags: CONTROL_FLAGS,
    });
    this.enqueueMessage({
      type: "end",
      timestamp,
      commandNumber: number,
      flags: CONTROL_FLAGS,
    });
    for (const msg of this.scenario.greeting ?? []) this.enqueueMessage(msg);
    this.flush();
  }

  /**
   * Push one server-to-client notification, serialized to its exact wire line.
   * Whole-block atomicity (send() enqueues an entire guard block in one call)
   * guarantees this never lands inside a `%begin`/`%end` pair — Block Purity
   * (SPEC_MANIFEST §4.1) holds by construction. [LAW:single-enforcer]
   */
  emit(msg: TmuxMessage): void {
    if (this.closeGate.state().closed) return;
    this.enqueueMessage(msg);
    this.flush();
  }

  /** Convenience for the 90% case: push a `%output` chunk for one pane. */
  emitOutput(paneId: number, data: Uint8Array): void {
    this.emit({ type: "output", paneId, data });
  }

  /** The commands the client has sent, newline-stripped, in order. */
  get sentCommands(): readonly string[] {
    return this.commandLog;
  }

  // -------------------------------------------------------------------------
  // Internal — command framing (the mechanism)
  // -------------------------------------------------------------------------

  private handleCommandLine(line: string): void {
    // A bare newline (empty command line) is the detach byte — tmux exits the
    // control client (SPEC §4.1). Faithful: end the connection.
    if (line === "") {
      this.closeGate.dispatch(undefined);
      return;
    }

    this.commandLog.push(line);
    // [LAW:no-defensive-null-guards] exception: MockScenario is a public
    // policy seam consumers implement — a trust boundary, same reasoning as
    // TmuxTransport.send()'s own contract-violation guards. A respond() that
    // throws (violating its documented MUST-be-pure contract) must not make
    // this method throw: send() promises SendResult, never a throw.
    let reply: CommandReply;
    try {
      reply = this.scenario.respond?.(line) ?? { kind: "ok" as const };
    } catch (err) {
      reply = {
        kind: "error",
        output: [err instanceof Error ? err.message : String(err)],
      };
    }
    const number = ++this.commandNumber;
    const timestamp = this.now();

    // [LAW:one-source-of-truth] begin/end/error are serialized through the same
    // serializeMessage as every other message — guard lines are not special-
    // cased strings. The whole block is enqueued atomically (Block Purity).
    this.enqueueMessage({
      type: "begin",
      timestamp,
      commandNumber: number,
      flags: CONTROL_FLAGS,
    });
    for (const outLine of reply.output ?? []) this.enqueueLine(outLine);
    const terminator = reply.kind === "error" ? "error" : "end";
    this.enqueueMessage({
      type: terminator,
      timestamp,
      commandNumber: number,
      flags: CONTROL_FLAGS,
    });

    this.flush();
  }

  private enqueueMessage(msg: TmuxMessage): void {
    this.enqueueLine(serializeMessage(msg));
  }

  // One wire line → one delivered chunk, LF-terminated (tmux output is line-
  // oriented). The parser tolerates any chunking, but per-line delivery keeps
  // the tutorial's wire view honest and gives the chaos decorator a clean seam.
  private enqueueLine(line: string): void {
    this.outbound.push(line + "\n");
  }

  private flush(): void {
    // [LAW:no-ambient-temporal-coupling] Re-entrancy guard: a nested flush()
    // (reached when delivering a line synchronously drives the client to send a
    // command) just returns; the outer loop drains whatever it enqueued. So the
    // client's parser.feed is never called re-entrantly.
    if (this.flushing) return;
    this.flushing = true;
    while (this.outbound.length > 0) {
      const chunk = this.outbound.shift() as string;
      for (const cb of this.dataCallbacks) cb(chunk);
    }
    this.flushing = false;
  }
}
