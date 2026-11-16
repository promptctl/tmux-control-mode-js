// src/client.ts
// TmuxClient — local tmux connection. One class, all three transports.
//
// [LAW:types-are-the-program] TmuxConnection is the 5-method slim interface.
//   TmuxClient implements it. All tmux commands are free functions over execute
//   in src/commands/.
// [LAW:one-source-of-truth] Command correlation state lives exclusively here.
// [LAW:single-enforcer] The FIFO of callers, each command line ended by its
//   numbered sentinel (SPEC §5.6), is the sole mechanism for matching
//   responses.

import {
  sameConnectionState,
  type ConnectionState,
} from "./connection-state.js";
import { DeliveryQueue } from "./delivery-queue.js";
import { TmuxParser } from "./protocol/parser.js";
import {
  commandLine,
  detachClient,
  refreshClientSubscribe,
  refreshClientUnsubscribe,
  sentinelLineNumber,
} from "./protocol/encoder.js";
import type {
  BeginMessage,
  CommandResponse,
  EndMessage,
  ErrorMessage,
  ExitMessage,
  ProtocolErrorMessage,
  TmuxMessage,
} from "./protocol/types.js";
import { TypedEmitter } from "./emitter.js";
import type { EmitterMessage, TmuxEventMap } from "./emitter.js";
import {
  type AttachOptions,
  type BytesSink,
  type ChunkPayload,
} from "./pane-output.js";
import { TopologyRouter } from "./topology-router.js";
import type { TopologyRouterOptions } from "./topology-router.js";
import { CrossSessionLayoutRelay } from "./cross-session-layout.js";
import {
  ClientSizeClaims,
  type ClientSizeClaim,
  type ClientSizeSurface,
} from "./client-size.js";
import { CONTROL_FLAGS, isPaneOutput } from "./protocol/types.js";
import type { TmuxTransport, SendResult } from "./transport/types.js";
import {
  TmuxCommandError,
  TmuxProtocolError,
  invalidCommand,
  TransportClosedError,
  TransportSendError,
} from "./errors.js";

// Re-export for consumers that need it
export type { SplitOptions } from "./protocol/encoder.js";
export type { ClientSizeClaim, ClientSizeSurface } from "./client-size.js";

// [LAW:one-source-of-truth] The router owns its option's meaning and default;
//   the client's public option type extends that same shape, not a copy.
export interface TmuxClientOptions extends TopologyRouterOptions {
  /**
   * The client was spawned with the `ignore-size` flag, as
   * `watchServerArgs` does (`watchServerOptions` sets this). Its sizes never
   * count toward window sizing: they are sent, and the flag is never
   * cleared. Default off: the client's size claims clear the flag to put the
   * client into window sizing.
   */
  readonly ignoreSize?: boolean;
}

// ---------------------------------------------------------------------------
// TmuxConnection — the minimal 5-method interface
//
// All tmux command free functions (src/commands/) accept this. Consumers
// that only need to send commands and receive bytes should type against this,
// not the full TmuxClient class.
//
// [LAW:types-are-the-program] The strongest true theorem about what a consumer
// needs from a tmux connection is these five capabilities.
// ---------------------------------------------------------------------------

export interface TmuxConnection {
  execute(command: string): Promise<CommandResponse>;
  on<K extends keyof TmuxEventMap>(
    event: K,
    handler: (ev: TmuxEventMap[K]) => void,
  ): void;
  on(event: "*", handler: (ev: EmitterMessage) => void): void;
  off<K extends keyof TmuxEventMap>(
    event: K,
    handler: (ev: TmuxEventMap[K]) => void,
  ): void;
  off(event: "*", handler: (ev: EmitterMessage) => void): void;
  attachBytesSink(sink: BytesSink, options?: AttachOptions): () => void;
  readonly connectionState: ConnectionState;
}

/**
 * Format subscriptions (`refresh-client -B`) as methods of the connection, so
 * a connection that shares one tmux client between many consumers can track
 * each consumer's subscriptions and end them when that consumer goes away.
 * `TmuxClient`, `WebSocketTmuxClient` and the Electron renderer client all
 * implement it.
 *
 * [LAW:single-enforcer] Through a bridge, the bridge's per-peer subscription
 *   ledger is the one owner of a subscription's lifetime; a `refresh-client -B`
 *   sent with `execute()` bypasses it and outlives the page that sent it.
 */
export interface SubscriptionSurface {
  subscribeRaw(
    name: string,
    what: string,
    format: string,
  ): Promise<CommandResponse>;
  unsubscribe(name: string): Promise<CommandResponse>;
}

// ---------------------------------------------------------------------------
// Internal correlation state
// ---------------------------------------------------------------------------

// [LAW:types-are-the-program] The reject channel carries exactly four shapes:
// tmux's %error receipt, a malformed %end/%error guard terminator, the
// transport's refusal to send at all, or the transport dying before tmux ever
// replied.
interface PendingEntry {
  // Which command line this client wrote it is: its sentinel names it.
  readonly lineNumber: number;
  readonly resolve: (response: CommandResponse) => void;
  readonly reject: (
    err:
      | TmuxCommandError
      | TmuxProtocolError
      | TransportSendError
      | TransportClosedError,
  ) => void;
}

// The reply block tmux is writing: its %begin, announced when it closes, and
// its lines so far.
interface OpenBlock {
  readonly begin: BeginMessage;
  readonly output: string[];
}

type TerminatorError = Extract<ProtocolErrorMessage, { kind: "terminator" }>;

// [LAW:types-are-the-program] How a block closed: %end (a reply), %error, or
// a terminator the parser could not read.
type BlockReply = CommandResponse | TmuxCommandError | TmuxProtocolError;

function blockReply(
  block: OpenBlock,
  terminator: EndMessage | ErrorMessage | TerminatorError,
): BlockReply {
  const response: CommandResponse = {
    commandNumber: block.begin.commandNumber,
    timestamp: block.begin.timestamp,
    output: block.output,
    success: terminator.type === "end",
  };
  switch (terminator.type) {
    case "end":
      return response;
    case "error":
      return new TmuxCommandError(response);
    case "protocol-error":
      return new TmuxProtocolError(
        terminator.commandNumber,
        terminator.line,
        block.output,
      );
  }
}

// The command line tmux is answering: its caller, what its commands replied
// so far, and the first that failed — tmux runs nothing after it, so it is
// the line's outcome.
interface AnsweringLine {
  readonly caller: PendingEntry;
  readonly responses: CommandResponse[];
  failure: TmuxCommandError | TmuxProtocolError | null;
}

// A line's reply, once its sentinel closes it: its failure, or every
// command's output, numbered by its first block — by the sentinel's when tmux
// ran no command for the line.
function settleLine(line: AnsweringLine, sentinel: BeginMessage): void {
  if (line.failure !== null) {
    line.caller.reject(line.failure);
    return;
  }
  const first = line.responses[0] ?? sentinel;
  line.caller.resolve({
    commandNumber: first.commandNumber,
    timestamp: first.timestamp,
    output: line.responses.flatMap((response) => response.output),
    success: true,
  });
}

function answeringWhat(line: AnsweringLine | null): string {
  return line === null
    ? "while no line was awaiting a reply"
    : `while line ${line.caller.lineNumber} was awaiting its reply`;
}

// ---------------------------------------------------------------------------
// TmuxClient
// ---------------------------------------------------------------------------

export class TmuxClient
  implements TmuxConnection, SubscriptionSurface, ClientSizeSurface
{
  private readonly transport: TmuxTransport;
  private readonly parser: TmuxParser;
  private readonly emitter: TypedEmitter;
  // [LAW:single-enforcer] When listeners and sinks run: each message tmux
  //   sends, each transport close and each close() is one step, and what it
  //   announced is delivered once the step has committed.
  private readonly delivery = new DeliveryQueue();
  private readonly emit = (msg: EmitterMessage): void => this.emitter.emit(msg);

  // [LAW:single-enforcer] The FIFO, the line being answered and the open
  // block are the sole correlation state. The FIFO holds one entry per
  // execute() whose line no %begin has claimed yet.
  private readonly pending: PendingEntry[] = [];
  private answering: AnsweringLine | null = null;
  private openBlock: OpenBlock | null = null;
  // How many command lines execute() has numbered.
  private linesWritten = 0;
  // Commands a closing transport refused: never sent, so outside the FIFO —
  // no reply can claim one, whatever the transport sends next — and settled
  // by the close, with the connection's true end.
  private readonly awaitingClose: PendingEntry[] = [];

  // [LAW:one-source-of-truth] connectionState is the single lifecycle field.
  private currentConnectionState: ConnectionState = { status: "connecting" };
  private userClosed = false;

  // [LAW:one-source-of-truth] tmux's text for why the command it was started
  // with failed. Written only while that command's reply is awaited
  // (connectionState "connecting"): by the reply's own settle (see
  // startupReplied), or by a line tmux wrote outside any guard block in its
  // place, which is how it reports a startup command it could not parse.
  // Later, such a line is `run-shell` output and says nothing about the end.
  private startupFailure: string | undefined;

  // [LAW:single-enforcer] The 'exit' this connection announced, once: tmux's
  // own %exit, or the transport's close when tmux never sent one. Whatever
  // rejects because the connection ended carries this reason.
  private announcedExit: ExitMessage | undefined;

  // [LAW:one-source-of-truth] All byte routing, topology, and bootstrap logic
  //   lives in TopologyRouter. TmuxClient injects execute() as the command runner.
  private readonly router: TopologyRouter;

  // [LAW:effects-at-boundaries] The relay describes cross-session layout
  // events via this callback; TmuxClient performs the actual emission,
  // mirroring how TopologyRouter's bootstrap-failure callback works above.
  private readonly crossSessionLayoutRelay: CrossSessionLayoutRelay;

  // [LAW:single-enforcer] Every size this client sends goes through a claim:
  //   its own methods hold one, and a bridge takes one per peer.
  private readonly sizes: ClientSizeClaims;
  private readonly ownSize: ClientSizeClaim;

  constructor(transport: TmuxTransport, options?: TmuxClientOptions) {
    this.transport = transport;
    this.emitter = new TypedEmitter();
    this.sizes = new ClientSizeClaims(
      (command) => this.execute(command),
      options?.ignoreSize === true,
    );
    this.ownSize = this.sizes.claim();
    // The relay and the router post what they report to this client's queue.
    this.crossSessionLayoutRelay = new CrossSessionLayoutRelay(
      this,
      this.delivery,
      this.emit,
    );
    // [LAW:effects-at-boundaries] The router describes a bootstrap failure; this
    //   adapter owns the emitter and performs the emission.
    this.router = new TopologyRouter(
      this.delivery,
      (error) => this.emit({ type: "topology-error", error }),
      options,
    );
    // [LAW:no-ambient-temporal-coupling] Each message tmux sends is one step,
    //   heard before the next commits, so what a listener does about a
    //   message — attach a sink, dispose one, close — holds from the next
    //   message on, however the transport split its reads.
    const handleMessage = this.handleMessage.bind(this);
    const handleProtocolError = this.handleProtocolError.bind(this);
    this.parser = new TmuxParser(
      (msg) => this.delivery.step(handleMessage, msg),
      (error) => this.delivery.step(handleProtocolError, error),
    );

    this.parser.onOutputLine = (_commandNumber, line) => {
      this.openBlock?.output.push(line);
    };
    this.parser.onUnguardedLine = (line) => {
      if (this.currentConnectionState.status === "connecting" && line !== "") {
        this.startupFailure = line;
      }
    };

    transport.onData((chunk) => {
      this.parser.feed(chunk);
    });
    transport.onClose((reason) => {
      // [LAW:one-source-of-truth] This classifies the TRANSPORT's own close
      // signal (`reason`, the raw parameter above) — independent of, and
      // free to disagree with, whichever reason the 'exit' event carried.
      // See ConnectionState's doc comment in connection-state.ts for why.
      this.delivery.step(() =>
        this.endConnection(
          this.startupFailure ?? reason,
          this.userClosed
            ? "disposed"
            : reason === undefined
              ? "exit"
              : "transport-error",
        ),
      );
    });
  }

  // ---------------------------------------------------------------------------
  // TmuxConnection implementation
  // ---------------------------------------------------------------------------

  get connectionState(): ConnectionState {
    return this.currentConnectionState;
  }

  // [LAW:single-enforcer] execute is the sole public command dispatch path.
  // Plain command string in → response out. No sendRaw escape hatch for callers.
  execute(command: string): Promise<CommandResponse> {
    return new Promise((resolve, reject) => {
      // The command is judged before the connection, as the WebSocket client
      // and the Electron renderer do, so a bad command gets one error type
      // on every TmuxConnection, open or closed.
      const invalid = invalidCommand(command);
      if (invalid !== null) {
        reject(invalid);
        return;
      }
      // [LAW:no-silent-failure] 'closed' is terminal (see endConnection)
      // and settlePendingOnClose already ran once, for good, when it happened
      // — it will never run again. TmuxTransport is a public seam third
      // parties implement (a trust boundary, same reasoning as the throwing-
      // send catch below); a transport that incorrectly still reports
      // {ok: true} after its own close would otherwise hang this promise
      // forever with no diagnostic. currentConnectionState is already the
      // one reliably-updated source of truth for "the transport told us it
      // closed," so this consults it rather than trusting a third-party
      // transport to get its own closed bookkeeping right.
      if (this.currentConnectionState.status === "closed") {
        // The same answer a command held at the close got: the connection
        // ended before tmux could take it.
        reject(new TransportClosedError(this.announcedExit?.reason));
        return;
      }
      // Enqueue BEFORE send: a synchronous transport (the mock's trampoline)
      // may deliver %begin within send() and must find this entry in the FIFO.
      const entry: PendingEntry = {
        lineNumber: ++this.linesWritten,
        resolve,
        reject,
      };
      this.pending.push(entry);
      try {
        const sent = this.transport.send(
          commandLine(command, entry.lineNumber),
        );
        // [LAW:no-silent-failure] A refused send leaves the FIFO — the
        // command never reached tmux, so no %begin will ever claim this
        // entry. The `.ok` access stays inside this try: a contract-
        // violating transport that returns a non-SendResult value throws
        // here too, falling into the same rollback path below rather than
        // leaking this entry via an uncaught TypeError.
        // A closing transport's refusal waits for the close, like a command
        // tmux took and never answered: the close settles it after the
        // router has retired, so a dying connection never reads as one
        // refused command.
        if (!sent.ok) {
          this.dropPending(entry);
          if (sent.closing) this.awaitingClose.push(entry);
          else reject(new TransportSendError(sent.reason));
        }
      } catch (err) {
        // [LAW:no-defensive-null-guards] exception: TmuxTransport is a public
        // seam consumers implement — a trust boundary. A throwing send
        // violates the SendResult contract, but the FIFO's correlation
        // integrity [LAW:one-source-of-truth] must not depend on outside code
        // keeping promises: roll the entry back and stay loud — the rethrow
        // rejects this promise with the original error.
        this.dropPending(entry);
        throw err;
      }
    });
  }

  on<K extends keyof TmuxEventMap>(
    event: K,
    handler: (ev: TmuxEventMap[K]) => void,
  ): void;
  on(event: "*", handler: (ev: EmitterMessage) => void): void;
  on(event: string, handler: (ev: never) => void): void {
    this.emitter.on(event as "*", handler as (ev: EmitterMessage) => void);
  }

  off<K extends keyof TmuxEventMap>(
    event: K,
    handler: (ev: TmuxEventMap[K]) => void,
  ): void;
  off(event: "*", handler: (ev: EmitterMessage) => void): void;
  off(event: string, handler: (ev: never) => void): void {
    this.emitter.off(event as "*", handler as (ev: EmitterMessage) => void);
  }

  attachBytesSink(sink: BytesSink, options?: AttachOptions): () => void {
    return this.router.attachBytesSink(sink, options);
  }

  // async: a name the encoder refuses rejects, as execute() does.
  async subscribeRaw(
    name: string,
    what: string,
    format: string,
  ): Promise<CommandResponse> {
    return this.execute(refreshClientSubscribe(name, what, format));
  }

  async unsubscribe(name: string): Promise<CommandResponse> {
    return this.execute(refreshClientUnsubscribe(name));
  }

  // ---------------------------------------------------------------------------
  // Client size (`refresh-client -C`). This client's own methods are one claim
  // among those a bridge takes for its peers; see src/client-size.ts.
  // ---------------------------------------------------------------------------

  /** A share of this client's size for one consumer, withdrawn by `release()`. */
  claimSize(): ClientSizeClaim {
    return this.sizes.claim();
  }

  setSize(width: number, height: number): Promise<CommandResponse> {
    return this.ownSize.setSize(width, height);
  }

  setWindowSize(
    windowId: number,
    width: number,
    height: number,
  ): Promise<CommandResponse> {
    return this.ownSize.setWindowSize(windowId, width, height);
  }

  clearWindowSize(windowId: number): Promise<CommandResponse> {
    return this.ownSize.clearWindowSize(windowId);
  }

  // ---------------------------------------------------------------------------
  // Cross-session layout coverage (not on TmuxConnection — opt-in, like
  // attachBytesSink). Ref-counted: each `enableCrossSessionLayoutChange` call
  // pairs with one `disableCrossSessionLayoutChange` call. See
  // src/cross-session-layout.ts for the mechanism.
  // ---------------------------------------------------------------------------

  enableCrossSessionLayoutChange(): Promise<void> {
    return this.crossSessionLayoutRelay.enable();
  }

  disableCrossSessionLayoutChange(): Promise<void> {
    return this.crossSessionLayoutRelay.disable();
  }

  // ---------------------------------------------------------------------------
  // Lifecycle (not on TmuxConnection — callers that attach sinks don't need it)
  // ---------------------------------------------------------------------------

  close(): void {
    this.delivery.step(() => {
      this.userClosed = true;
      this.transport.close();
    });
  }

  // Detach is NOT in TmuxConnection and NOT a free function — it sends a bare
  // newline which has no %begin/%end correlation and cannot use execute().
  // [LAW:no-silent-failure] The refusal is representable, not swallowed: a
  // transport may refuse because it is dead (detach moot; the death reports
  // through onClose) or because it is not yet open (detach did nothing) —
  // the returned result lets the caller tell which, while the actual close
  // still announces itself only through onClose, the canonical exit path.
  detach(): SendResult {
    return this.transport.send(detachClient());
  }

  // ---------------------------------------------------------------------------
  // Internal — lifecycle state
  // ---------------------------------------------------------------------------

  // Rolls an entry back out of the FIFO after a send that could not enqueue
  // work with tmux; a no-op if a synchronous response already claimed it.
  // [LAW:decomposition] execute() pushes `entry` and calls this synchronously
  // with no intervening push, so `entry` is either still the tail (roll back
  // with pop) or was already shifted off the head by a synchronous %begin
  // (already claimed, nothing to do) — never anywhere else in the array.
  private dropPending(entry: PendingEntry): void {
    if (this.pending[this.pending.length - 1] === entry) this.pending.pop();
  }

  // [LAW:single-enforcer] The one way a connection ends: the transport's
  // close, or a reply stream that can no longer be matched to its commands
  // (handleProtocolError). It announces, after its caller's own cause, 'exit'
  // when tmux never sent its own %exit (a killed server), the sinks' end, then
  // 'closed'.
  // [LAW:types-are-the-program] 'closed' is documented (connection-state.ts)
  // as terminal for TmuxClient — no automatic transition leaves it. Enforced
  // once, here, the one path into it: the transport's own close arriving
  // after this end changes nothing.
  // [LAW:no-ambient-temporal-coupling] The whole end commits within the
  // caller's step, before any listener hears of it, so a command a listener
  // issues meets execute's 'closed' refusal and never reaches tmux.
  private endConnection(
    reason: string | undefined,
    closedReason: Exclude<
      Extract<ConnectionState, { status: "closed" }>["reason"],
      "refused"
    >,
  ): void {
    if (this.currentConnectionState.status === "closed") return;
    const exit = this.recordExit(reason);
    this.router.onTransportClose();
    this.settlePendingOnClose(exit.reason);
    this.transition({ status: "closed", reason: closedReason });
  }

  // [LAW:no-silent-failure] The transport is gone — no %begin/%end/%error will
  // ever arrive for these commands. Reject them now instead of leaving their
  // promises unsettled forever; clearing the correlation state first means a
  // message that somehow arrives after close (see endConnection's
  // terminal-state guard) cannot double-settle an already-rejected entry.
  // A line whose sentinel never replied rejects with its failure when one
  // came; otherwise tmux may have run some of its commands, and only the
  // sentinel says it ran them all.
  private settlePendingOnClose(reason: string | undefined): void {
    const line = this.answering;
    this.answering = null;
    this.openBlock = null;
    const queued = [
      ...this.pending.splice(0, this.pending.length),
      ...this.awaitingClose.splice(0, this.awaitingClose.length),
    ];

    line?.caller.reject(line.failure ?? new TransportClosedError(reason));
    for (const entry of queued) {
      entry.reject(new TransportClosedError(reason));
    }
  }

  // [LAW:single-enforcer] The one place this connection's 'exit' is recorded
  // and announced, once: a second exit (the transport's close after a %exit,
  // or a second %exit from a misbehaving transport) changes nothing.
  private recordExit(reason: string | undefined): ExitMessage {
    if (this.announcedExit !== undefined) return this.announcedExit;
    this.announcedExit = { type: "exit", reason };
    this.announce(this.announcedExit);
    return this.announcedExit;
  }

  // [LAW:no-ambient-temporal-coupling] The first reply tmux sends answers the
  // command it was started with, so the unsolicited reply that closes while
  // the state is still 'connecting' is that one. It is the one place readiness
  // is asserted (when that guard block closes, not on first byte) and it alone
  // names the startup failure: a line that came before a reply tmux did send
  // is not its failure, and a later unsolicited reply finds 'ready' and
  // changes neither.
  private startupReplied(failure: string | undefined): void {
    if (this.currentConnectionState.status !== "connecting") return;
    this.startupFailure = failure;
    this.transition({ status: "ready" });
    this.router.onTransportReady((cmd) => this.execute(cmd));
  }

  // [LAW:single-enforcer] The one writer of connectionState, and the one
  // announcer of its changes.
  private transition(next: ConnectionState): void {
    if (sameConnectionState(this.currentConnectionState, next)) return;
    this.currentConnectionState = next;
    this.announce({ type: "connection-state", state: next });
  }

  private announce(msg: EmitterMessage): void {
    this.delivery.post(this.emit, msg);
  }

  // ---------------------------------------------------------------------------
  // Internal message handler
  // ---------------------------------------------------------------------------

  // [LAW:single-enforcer] All FIFO correlation transitions happen here only.
  private handleMessage(msg: TmuxMessage): void {
    // [LAW:no-ambient-temporal-coupling] 'closed' is terminal (see
    // endConnection): once committed, nothing more should reach
    // consumers. Without this, a chunk delivered after the transport already
    // closed — a real race under delayed/chaotic delivery — could still
    // dispatch here: the correlation state is already cleared and settled.
    if (this.currentConnectionState.status === "closed") return;
    if (msg.type === "begin") {
      // The first block of a line this client wrote claims the line's caller.
      if (msg.flags === CONTROL_FLAGS && this.answering === null) {
        const caller = this.pending.shift();
        this.answering =
          caller === undefined
            ? null
            : { caller, responses: [], failure: null };
      }
      this.openBlock = { begin: msg, output: [] };
      return;
    }
    if (msg.type === "end" || msg.type === "error") {
      this.closeBlock(msg);
      return;
    }
    if (msg.type === "exit") {
      // %exit is announced when tmux says it (SPEC §23 requires it observable
      // on its own), not when the transport later closes. A failed startup
      // command explains the end better than tmux's bare %exit; the same
      // holds for the transport's close (constructor).
      this.recordExit(this.startupFailure ?? msg.reason);
      return;
    }

    // [LAW:single-enforcer] Pane bytes flow exclusively through the router's
    // byte-dispatch path. ChunkPayload strips wire discriminator fields before
    // dispatch — sinks receive only {paneId, data}. [LAW:types-are-the-program]
    if (isPaneOutput(msg)) {
      const chunk: ChunkPayload = { paneId: msg.paneId, data: msg.data };
      this.router.dispatchBytes(chunk);
      return;
    }

    // [LAW:one-source-of-truth] Topology mutations live in TopologyRouter.
    //   The router handles window-close, window-add, layout-change, sessions-changed;
    //   this adapter remains unaware of topology update logic.
    // [LAW:effects-at-boundaries] The router does NOT call the emitter. This adapter
    //   is responsible for emitting non-byte messages to event listeners.
    this.router.handleNotification(msg);
    this.announce(msg);
  }

  // [LAW:single-enforcer] Every block closes here, however it ended.
  // [LAW:dataflow-not-control-flow] tmux says on the guard whether the block
  // answers a line this client wrote, and its output whether it is a line's
  // sentinel; the two pick its owner. A reply to a command no caller wrote
  // never reaches a caller.
  // A block's %begin is announced with its close, so a sentinel's, which
  // frames execute()'s line as its newline does, is never announced: no
  // notification falls inside a block, so the order of events is tmux's.
  // A protocol error is always announced.
  private closeBlock(
    terminator: EndMessage | ErrorMessage | TerminatorError,
  ): void {
    const block = this.openBlock;
    this.openBlock = null;
    // A guard tmux wrote with no block open closes nothing.
    if (block === null) {
      this.announce(terminator);
      return;
    }
    if (block.begin.flags !== CONTROL_FLAGS) {
      this.announce(block.begin);
      this.settleUnsolicited(blockReply(block, terminator));
      this.announce(terminator);
      return;
    }
    const line = this.answering;
    // tmux fails a sentinel's line, so a block closed by %end is a command's
    // reply even when its output reads as a sentinel's: a pane title can.
    const ended =
      terminator.type === "end" ? null : sentinelLineNumber(block.output);
    if (ended !== null) {
      if (terminator.type === "protocol-error") this.announce(terminator);
      if (line?.caller.lineNumber !== ended) {
        this.lostLine(
          `tmux ended command line ${ended} ${answeringWhat(line)}`,
        );
        return;
      }
      this.answering = null;
      settleLine(line, block.begin);
      return;
    }
    this.announce(block.begin);
    this.announce(terminator);
    if (line === null) {
      this.lostLine(
        "tmux answered a command line while no line was awaiting a reply",
      );
      return;
    }
    const reply = blockReply(block, terminator);
    if (reply instanceof Error) line.failure ??= reply;
    else line.responses.push(reply);
  }

  // [LAW:no-silent-failure] tmux's replies no longer follow the lines this
  // client wrote: a sentinel's reply was lost, damaged or forged. No later
  // reply can be matched to its caller, so none is handed to one: the
  // connection ends, as on a malformed %begin.
  private lostLine(reason: string): void {
    this.endConnection(reason, "transport-error");
    this.transport.close();
  }

  // [LAW:one-type-per-behavior] Every block tmux marks as not answering a
  // line this client wrote — the command line tmux was started with, a hook,
  // a background command — becomes one `unsolicited-response`; whether it
  // failed and what it said are in the response.
  private settleUnsolicited(reply: BlockReply): void {
    // A malformed terminator leaves no response; 'protocol-error' said so.
    if (reply instanceof TmuxProtocolError) {
      this.startupReplied(undefined);
      return;
    }
    const failed = reply instanceof TmuxCommandError;
    this.startupReplied(failed ? reply.message : undefined);
    this.announce({
      type: "unsolicited-response",
      response: failed ? reply.response : reply,
    });
  }

  // [LAW:no-silent-failure] Every line the parser could not read is observable
  // as 'protocol-error'; its kind decides what else it settles (see
  // ProtocolErrorMessage). The parser already recovered its own state before
  // calling this, so this method settles correlation state only.
  private handleProtocolError(error: ProtocolErrorMessage): void {
    // [LAW:no-ambient-temporal-coupling] 'closed' is terminal (see
    // handleMessage's identical guard) — settlePendingOnClose already ran, so
    // there is nothing left to settle here for a message arriving this late.
    if (this.currentConnectionState.status === "closed") return;
    switch (error.kind) {
      case "terminator":
        // A block that closed on a line the parser could not read.
        this.closeBlock(error);
        return;
      case "begin": {
        // No later reply can be matched to its command, so none is handed
        // to a caller: the connection ends, and the report is announced
        // first, as its cause. Its reason is this line's, quoted so a
        // trailing \r stays visible — no startup failure explains it better.
        // The transport closes after the end is committed, so its close
        // signal, even a synchronous one, changes nothing.
        this.announce(error);
        this.endConnection(
          `malformed %begin: ${JSON.stringify(error.line)}`,
          "transport-error",
        );
        this.transport.close();
        return;
      }
      case "line":
        this.announce(error);
        return;
    }
  }
}
