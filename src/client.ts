// src/client.ts
// TmuxClient — local tmux connection. One class, all three transports.
//
// [LAW:types-are-the-program] TmuxConnection is the 5-method slim interface.
//   TmuxClient implements it. All tmux commands are free functions over execute
//   in src/commands/.
// [LAW:one-source-of-truth] Command correlation state lives exclusively here.
// [LAW:single-enforcer] FIFO queue is the sole mechanism for matching responses.

import {
  sameConnectionState,
  type ConnectionState,
  type ConnectionStateMessage,
} from "./connection-state.js";
import { TmuxParser } from "./protocol/parser.js";
import { detachClient } from "./protocol/encoder.js";
import type {
  CommandResponse,
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
import { CONTROL_FLAGS, isPaneOutput } from "./protocol/types.js";
import type { TmuxTransport, SendResult } from "./transport/types.js";
import { closedSendReason } from "./transport/close-gate.js";
import {
  TmuxCommandError,
  TmuxProtocolError,
  invalidCommand,
  TransportClosedError,
  TransportSendError,
} from "./errors.js";

// Re-export for consumers that need it
export type { SplitOptions } from "./protocol/encoder.js";

// [LAW:one-source-of-truth] The router owns the option's meaning and default;
//   the client's public option type is that same shape, not a second copy.
export type TmuxClientOptions = TopologyRouterOptions;

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

// ---------------------------------------------------------------------------
// Internal correlation state
// ---------------------------------------------------------------------------

// [LAW:types-are-the-program] The reject channel carries exactly four shapes:
// tmux's %error receipt, a malformed %end/%error guard terminator, the
// transport's refusal to send at all, or the transport dying before tmux ever
// replied.
interface PendingEntry {
  readonly resolve: (response: CommandResponse) => void;
  readonly reject: (
    err:
      | TmuxCommandError
      | TmuxProtocolError
      | TransportSendError
      | TransportClosedError,
  ) => void;
}

// [LAW:types-are-the-program] Narrower than PendingEntry.reject on purpose:
// a transport refusal (TransportSendError) is caught at execute()'s send()
// call, before an entry ever becomes inflight (see handleMessage's "begin"
// branch), so the true theorem for what reaches an inflight entry is exactly
// TmuxCommandError (a %error reply), TmuxProtocolError (a malformed
// terminator), or TransportClosedError (the transport closed while this entry
// was still awaiting %end/%error).
interface InflightEntry {
  readonly commandNumber: number;
  readonly timestamp: number;
  readonly output: string[];
  readonly resolve: (response: CommandResponse) => void;
  readonly reject: (
    err: TmuxCommandError | TmuxProtocolError | TransportClosedError,
  ) => void;
}

// Who a response block settles: a caller's `PendingEntry`, or the client's
// own receiver of the replies no caller wrote the command for.
type BlockOwner = Pick<InflightEntry, "resolve" | "reject">;

// ---------------------------------------------------------------------------
// TmuxClient
// ---------------------------------------------------------------------------

export class TmuxClient implements TmuxConnection {
  private readonly transport: TmuxTransport;
  private readonly parser: TmuxParser;
  private readonly emitter: TypedEmitter;

  // [LAW:single-enforcer] FIFO queue and inflight slot are the sole correlation state.
  // The FIFO holds one entry per execute() no %begin has claimed yet.
  private readonly pending: PendingEntry[] = [];
  private inflight: InflightEntry | null = null;

  // [LAW:one-type-per-behavior] The owner of every block tmux marks as not
  // answering a command this client wrote: the command line tmux was started
  // with, a hook, a background command. Each becomes one
  // `unsolicited-response`; whether it failed and what it said are in the
  // response.
  private readonly unsolicited: BlockOwner = {
    resolve: (response) => {
      this.startupReplied(undefined);
      this.emitter.emit({ type: "unsolicited-response", response });
    },
    reject: (err) => {
      // The transport closed before the block did: 'closed' follows.
      if (err instanceof TransportClosedError) return;
      // A malformed terminator leaves no response; 'protocol-error' said so.
      if (err instanceof TmuxProtocolError) {
        this.startupReplied(undefined);
        return;
      }
      this.startupReplied(err.message);
      this.emitter.emit({
        type: "unsolicited-response",
        response: err.response,
      });
    },
  };

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

  constructor(transport: TmuxTransport, options?: TmuxClientOptions) {
    this.transport = transport;
    this.emitter = new TypedEmitter();
    this.crossSessionLayoutRelay = new CrossSessionLayoutRelay(this, (msg) =>
      this.emitter.emit(msg),
    );
    // [LAW:effects-at-boundaries] The router describes a bootstrap failure; this
    //   adapter owns the emitter and performs the emission.
    this.router = new TopologyRouter(
      (error) => this.emitter.emit({ type: "topology-error", error }),
      options,
    );
    this.parser = new TmuxParser(
      (msg) => this.handleMessage(msg),
      (error) => this.handleProtocolError(error),
    );

    this.parser.onOutputLine = (_commandNumber, line) => {
      this.inflight?.output.push(line);
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
      const announced = this.endConnection(
        this.startupFailure ?? reason,
        this.userClosed
          ? "disposed"
          : reason === undefined
            ? "exit"
            : "transport-error",
      );
      for (const msg of announced) this.emitter.emit(msg);
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
      // [LAW:no-silent-failure] 'closed' is terminal (see transition)
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
        reject(
          new TransportSendError(closedSendReason(this.announcedExit?.reason)),
        );
        return;
      }
      // Enqueue BEFORE send: a synchronous transport (the mock's trampoline)
      // may deliver %begin within send() and must find this entry in the FIFO.
      const entry: PendingEntry = { resolve, reject };
      this.pending.push(entry);
      try {
        const sent = this.transport.send(command + "\n");
        // [LAW:no-silent-failure] A refused send settles the promise now —
        // the command never reached tmux, so no %begin will ever claim this
        // entry. The `.ok` access stays inside this try: a contract-
        // violating transport that returns a non-SendResult value throws
        // here too, falling into the same rollback path below rather than
        // leaking this entry via an uncaught TypeError.
        if (!sent.ok) {
          this.dropPending(entry);
          reject(new TransportSendError(sent.reason));
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
    this.userClosed = true;
    this.transport.close();
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
  // (handleProtocolError).
  // [LAW:effects-at-boundaries] It commits the end and returns what the
  // caller announces after its own cause: 'exit' when tmux never sent its own
  // %exit (a killed server), then 'closed'.
  // [LAW:no-ambient-temporal-coupling] Everything is committed before any
  // listener hears of it — 'closed' set, the exit recorded, every pending
  // command rejected — so a command a listener issues meets execute's
  // 'closed' refusal and never reaches tmux, and the transport's own close,
  // arriving later, changes nothing.
  private endConnection(
    reason: string | undefined,
    closedReason: Extract<ConnectionState, { status: "closed" }>["reason"],
  ): readonly EmitterMessage[] {
    const closed = this.transition({ status: "closed", reason: closedReason });
    // Already closed: this end was committed and announced before.
    if (closed.length === 0) return [];
    const { exit, unannounced } = this.recordExit(reason);
    this.router.onTransportClose();
    this.settlePendingOnClose(exit.reason);
    return [...unannounced, ...closed];
  }

  // [LAW:no-silent-failure] The transport is gone — no %begin/%end/%error will
  // ever arrive for these commands. Reject them now instead of leaving their
  // promises unsettled forever; clearing both collections first means a
  // message that somehow arrives after close (see the transition
  // terminal-state guard below) cannot double-settle an already-rejected entry.
  private settlePendingOnClose(reason: string | undefined): void {
    const inflight = this.inflight;
    this.inflight = null;
    const queued = this.pending.splice(0, this.pending.length);

    inflight?.reject(new TransportClosedError(reason));
    for (const entry of queued) {
      entry.reject(new TransportClosedError(reason));
    }
  }

  // [LAW:single-enforcer] The one place this connection's 'exit' is recorded.
  // `unannounced` is what the caller still has to emit: nothing for a second
  // exit (the transport's close after a %exit, or a second %exit from a
  // misbehaving transport), which changes nothing.
  private recordExit(reason: string | undefined): {
    readonly exit: ExitMessage;
    readonly unannounced: readonly ExitMessage[];
  } {
    if (this.announcedExit !== undefined) {
      return { exit: this.announcedExit, unannounced: [] };
    }
    this.announcedExit = { type: "exit", reason };
    return { exit: this.announcedExit, unannounced: [this.announcedExit] };
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
    for (const msg of this.transition({ status: "ready" })) {
      this.emitter.emit(msg);
    }
    this.router.onTransportReady((cmd) => this.execute(cmd));
  }

  // [LAW:single-enforcer] The one writer of connectionState. It returns the
  // 'connection-state' its caller announces: none when nothing changed.
  // [LAW:types-are-the-program] 'closed' is documented (connection-state.ts)
  // as terminal for TmuxClient — no automatic transition leaves it. Enforced
  // once, here, rather than at every caller that could otherwise resurrect a
  // dead connection (e.g. a data chunk delivered after the transport already
  // reported close).
  private transition(next: ConnectionState): readonly ConnectionStateMessage[] {
    if (this.currentConnectionState.status === "closed") return [];
    if (sameConnectionState(this.currentConnectionState, next)) return [];
    this.currentConnectionState = next;
    return [{ type: "connection-state", state: next }];
  }

  // ---------------------------------------------------------------------------
  // Internal message handler
  // ---------------------------------------------------------------------------

  // [LAW:single-enforcer] All FIFO correlation transitions happen here only.
  private handleMessage(msg: TmuxMessage): void {
    // [LAW:no-ambient-temporal-coupling] 'closed' is terminal (see
    // transition): once announced, nothing more should reach
    // consumers. Without this, a chunk delivered after the transport already
    // closed — a real race under delayed/chaotic delivery — could still
    // dispatch here: pending/inflight are already cleared and settled.
    if (this.currentConnectionState.status === "closed") return;
    if (msg.type === "begin") {
      // [LAW:dataflow-not-control-flow] tmux says on the guard whether the
      // block answers a command this client wrote, and that picks its owner;
      // everything after treats every block alike. A reply to a command no
      // caller wrote never takes a caller's entry.
      const owner: BlockOwner | undefined =
        msg.flags === CONTROL_FLAGS ? this.pending.shift() : this.unsolicited;
      if (owner !== undefined) {
        this.inflight = {
          commandNumber: msg.commandNumber,
          timestamp: msg.timestamp,
          output: [],
          resolve: owner.resolve,
          reject: owner.reject,
        };
      }
    } else if (msg.type === "end") {
      const entry = this.inflight;
      this.inflight = null;
      entry?.resolve({
        commandNumber: entry.commandNumber,
        timestamp: entry.timestamp,
        output: entry.output,
        success: true,
      });
    } else if (msg.type === "error") {
      const entry = this.inflight;
      this.inflight = null;
      entry?.reject(
        new TmuxCommandError({
          commandNumber: entry.commandNumber,
          timestamp: entry.timestamp,
          output: entry.output,
          success: false,
        }),
      );
    } else if (msg.type === "exit") {
      // %exit is announced when tmux says it (SPEC §23 requires it observable
      // on its own), not when the transport later closes. A failed startup
      // command explains the end better than tmux's bare %exit; the same
      // holds for the transport's close (constructor).
      const { unannounced } = this.recordExit(
        this.startupFailure ?? msg.reason,
      );
      for (const exit of unannounced) this.emitter.emit(exit);
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
    this.emitter.emit(msg);
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
      case "terminator": {
        // Mirrors handleMessage's "error" branch, with TmuxProtocolError
        // instead of TmuxCommandError.
        const entry = this.inflight;
        this.inflight = null;
        entry?.reject(
          new TmuxProtocolError(error.commandNumber, error.line, entry.output),
        );
        this.emitter.emit(error);
        return;
      }
      case "begin": {
        // No later reply can be matched to its command, so none is handed
        // to a caller: the connection ends, and the report is announced
        // first, as its cause. Its reason is this line's, quoted so a
        // trailing \r stays visible — no startup failure explains it better.
        // The transport closes after the end is committed (so its close
        // signal, even a synchronous one, changes nothing) and before any
        // listener runs (so a throwing listener cannot leave it open).
        const announced = [
          error,
          ...this.endConnection(
            `malformed %begin: ${JSON.stringify(error.line)}`,
            "transport-error",
          ),
        ];
        this.transport.close();
        for (const msg of announced) this.emitter.emit(msg);
        return;
      }
      case "line":
        this.emitter.emit(error);
        return;
    }
  }
}
