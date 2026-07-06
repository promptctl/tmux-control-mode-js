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
import { TmuxCommandError, TransportSendError } from "./errors.js";

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

// [LAW:types-are-the-program] The reject channel carries exactly two shapes:
// tmux's %error receipt, or the transport's refusal to send at all.
interface PendingEntry {
  readonly resolve: (response: CommandResponse) => void;
  readonly reject: (err: TmuxCommandError | TransportSendError) => void;
}

interface InflightEntry {
  readonly commandNumber: number;
  readonly timestamp: number;
  readonly output: string[];
  readonly resolve: (response: CommandResponse) => void;
  readonly reject: (err: TmuxCommandError) => void;
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
      this.emitter.emit({ type: "exit", reason });
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
      let sent: SendResult;
      try {
        sent = this.transport.send(command + "\n");
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
      // [LAW:no-silent-failure] A refused send settles the promise now — the
      // command never reached tmux, so no %begin will ever claim this entry.
      if (!sent.ok) {
        this.dropPending(entry);
        reject(new TransportSendError(sent.reason));
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
  private dropPending(entry: PendingEntry): void {
    const idx = this.pending.indexOf(entry);
    if (idx !== -1) this.pending.splice(idx, 1);
  }

  private setConnectionState(next: ConnectionState): void {
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
