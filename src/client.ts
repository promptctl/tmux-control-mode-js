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
} from "./connection-state.js";
import { TmuxParser } from "./protocol/parser.js";
import { detachClient } from "./protocol/encoder.js";
import type { CommandResponse, TmuxMessage } from "./protocol/types.js";
import { TypedEmitter } from "./emitter.js";
import type { EmitterMessage, TmuxEventMap } from "./emitter.js";
import {
  type AttachOptions,
  type BytesSink,
  type ChunkPayload,
} from "./pane-output.js";
import { TopologyRouter } from "./topology-router.js";
import type { TopologyRouterOptions } from "./topology-router.js";
import { isPaneOutput } from "./protocol/types.js";
import type { TmuxTransport, SendResult } from "./transport/types.js";
import {
  TmuxCommandError,
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

// [LAW:types-are-the-program] The reject channel carries exactly three shapes:
// tmux's %error receipt, the transport's refusal to send at all, or the
// transport dying before tmux ever replied.
interface PendingEntry {
  readonly resolve: (response: CommandResponse) => void;
  readonly reject: (
    err: TmuxCommandError | TransportSendError | TransportClosedError,
  ) => void;
}

// [LAW:types-are-the-program] Narrower than PendingEntry.reject on purpose:
// a transport refusal (TransportSendError) is caught at execute()'s send()
// call, before an entry ever becomes inflight (see handleMessage's "begin"
// branch), so the true theorem for what reaches an inflight entry is exactly
// TmuxCommandError (a %error reply) or TransportClosedError (the transport
// closed while this entry was still awaiting %end/%error).
interface InflightEntry {
  readonly commandNumber: number;
  readonly timestamp: number;
  readonly output: string[];
  readonly resolve: (response: CommandResponse) => void;
  readonly reject: (err: TmuxCommandError | TransportClosedError) => void;
}

// ---------------------------------------------------------------------------
// TmuxClient
// ---------------------------------------------------------------------------

export class TmuxClient implements TmuxConnection {
  private readonly transport: TmuxTransport;
  private readonly parser: TmuxParser;
  private readonly emitter: TypedEmitter;

  // [LAW:single-enforcer] FIFO queue and inflight slot are the sole correlation state.
  private readonly pending: PendingEntry[] = [];
  private inflight: InflightEntry | null = null;

  // [LAW:one-source-of-truth] connectionState is the single lifecycle field.
  private currentConnectionState: ConnectionState = { status: "connecting" };
  private userClosed = false;

  // [LAW:single-enforcer] Set when a parsed %exit has already told consumers
  // (via the standard notification path in handleMessage) that this
  // connection is ending. Guards the transport's onClose handler below from
  // emitting a second, synthetic 'exit' for the same disconnection — %exit
  // itself must still flow through the ordinary notification channel (SPEC
  // §23 requires it observable on its own, independent of transport close).
  private exitAlreadyEmitted = false;

  // [LAW:one-source-of-truth] All byte routing, topology, and bootstrap logic
  //   lives in TopologyRouter. TmuxClient injects execute() as the command runner.
  private readonly router: TopologyRouter;

  constructor(transport: TmuxTransport, options?: TmuxClientOptions) {
    this.transport = transport;
    this.router = new TopologyRouter(options);
    this.emitter = new TypedEmitter();
    this.parser = new TmuxParser((msg) => this.handleMessage(msg));

    this.parser.onOutputLine = (_commandNumber, line) => {
      this.inflight?.output.push(line);
    };

    transport.onData((chunk) => {
      this.setConnectionState({ status: "ready" });
      this.parser.feed(chunk);
    });
    transport.onClose((reason) => {
      this.router.onTransportClose();
      this.settlePendingOnClose(reason);
      // [LAW:single-enforcer] A synthetic 'exit' is only needed when tmux
      // never got to send its own %exit (e.g. a killed server) — transport
      // close is the one path guaranteed to fire on every disconnection, so
      // it is the right place to guarantee 'exit' fires at least once, but
      // not the right place to fire it unconditionally: a graceful shutdown
      // already announced 'exit' via the ordinary notification path above.
      if (!this.exitAlreadyEmitted) {
        this.emitter.emit({ type: "exit", reason });
      }
      this.setConnectionState({
        status: "closed",
        reason: this.userClosed
          ? "disposed"
          : reason === undefined
            ? "exit"
            : "transport-error",
      });
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

  // [LAW:no-silent-failure] The transport is gone — no %begin/%end/%error will
  // ever arrive for these commands. Reject them now instead of leaving their
  // promises unsettled forever; clearing both collections first means a
  // message that somehow arrives after close (see the setConnectionState
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

  private setConnectionState(next: ConnectionState): void {
    // [LAW:types-are-the-program] 'closed' is documented (connection-state.ts)
    // as terminal for TmuxClient — no automatic transition leaves it. Enforced
    // once, here, rather than at every caller that could otherwise resurrect a
    // dead connection (e.g. a data chunk delivered after the transport already
    // reported close).
    if (this.currentConnectionState.status === "closed") return;
    if (sameConnectionState(this.currentConnectionState, next)) return;
    this.currentConnectionState = next;
    this.emitter.emit({ type: "connection-state", state: next });
    if (next.status === "ready") {
      this.router.onTransportReady((cmd) => this.execute(cmd));
    }
  }

  // ---------------------------------------------------------------------------
  // Internal message handler
  // ---------------------------------------------------------------------------

  // [LAW:single-enforcer] All FIFO correlation transitions happen here only.
  private handleMessage(msg: TmuxMessage): void {
    if (msg.type === "begin") {
      const entry = this.pending.shift();
      if (entry !== undefined) {
        this.inflight = {
          commandNumber: msg.commandNumber,
          timestamp: msg.timestamp,
          output: [],
          resolve: entry.resolve,
          reject: entry.reject,
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
      // [LAW:single-enforcer] Falls through to the ordinary notification path
      // below like every other variant (SPEC §23 requires %exit observable on
      // its own) — this only records that it happened, so the transport's
      // onClose handler knows not to synthesize a second 'exit'.
      this.exitAlreadyEmitted = true;
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
}
