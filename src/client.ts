// src/client.ts
// TmuxClient — high-level interface to the tmux control mode protocol.
// Wraps TmuxTransport + TmuxParser + TypedEmitter into a single API surface.

// [LAW:one-source-of-truth] Command correlation state lives exclusively here.
// [LAW:single-enforcer] FIFO queue is the sole mechanism for matching responses to commands.

import { TmuxParser } from "./protocol/parser.js";
import {
  buildCommand,
  refreshClientSubscribe,
  refreshClientUnsubscribe,
  tmuxEscape,
} from "./protocol/encoder.js";
import type { CommandResponse, PaneAction, TmuxMessage } from "./protocol/types.js";
import { TypedEmitter } from "./emitter.js";
import type { TmuxEventMap } from "./emitter.js";
import type { TmuxTransport } from "./transport/types.js";

// ---------------------------------------------------------------------------
// Supporting types
// ---------------------------------------------------------------------------

export interface SplitOptions {
  readonly vertical?: boolean;
  readonly target?: string;
}

// ---------------------------------------------------------------------------
// Internal correlation state
// ---------------------------------------------------------------------------

interface PendingEntry {
  readonly resolve: (response: CommandResponse) => void;
  readonly reject: (response: CommandResponse) => void;
}

interface InflightEntry {
  readonly commandNumber: number;
  readonly timestamp: number;
  readonly output: string[];
  readonly resolve: (response: CommandResponse) => void;
  readonly reject: (response: CommandResponse) => void;
}

// ---------------------------------------------------------------------------
// TmuxClient
// ---------------------------------------------------------------------------

export class TmuxClient {
  private readonly transport: TmuxTransport;
  private readonly parser: TmuxParser;
  private readonly emitter: TypedEmitter;

  // [LAW:single-enforcer] FIFO queue and inflight slot are the sole correlation state.
  private readonly pending: PendingEntry[] = [];
  private inflight: InflightEntry | null = null;

  constructor(transport: TmuxTransport) {
    this.transport = transport;
    this.emitter = new TypedEmitter();
    this.parser = new TmuxParser((msg) => this.handleMessage(msg));

    // [LAW:dataflow-not-control-flow] onOutputLine always pushes to inflight.output;
    // inflight being null means no-op via optional chaining — data decides what happens.
    this.parser.onOutputLine = (_commandNumber, line) => {
      this.inflight?.output.push(line);
    };

    transport.onData((chunk) => this.parser.feed(chunk));
    transport.onClose((reason) => {
      this.emitter.emit({ type: "exit", reason });
    });
  }

  // ---------------------------------------------------------------------------
  // Event delegation — preserve overloads for type safety
  // ---------------------------------------------------------------------------

  on<K extends keyof TmuxEventMap>(event: K, handler: (ev: TmuxEventMap[K]) => void): void;
  on(event: "*", handler: (ev: TmuxMessage) => void): void;
  on(event: string, handler: (ev: never) => void): void {
    this.emitter.on(event as "*", handler as (ev: TmuxMessage) => void);
  }

  off<K extends keyof TmuxEventMap>(event: K, handler: (ev: TmuxEventMap[K]) => void): void;
  off(event: "*", handler: (ev: TmuxMessage) => void): void;
  off(event: string, handler: (ev: never) => void): void {
    this.emitter.off(event as "*", handler as (ev: TmuxMessage) => void);
  }

  // ---------------------------------------------------------------------------
  // Command execution
  // ---------------------------------------------------------------------------

  execute(command: string): Promise<CommandResponse> {
    return new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject });
      this.transport.send(buildCommand(command));
    });
  }

  // ---------------------------------------------------------------------------
  // Convenience methods
  // ---------------------------------------------------------------------------

  listWindows(): Promise<CommandResponse> {
    return this.execute("list-windows");
  }

  listPanes(): Promise<CommandResponse> {
    return this.execute("list-panes");
  }

  sendKeys(target: string, keys: string): Promise<CommandResponse> {
    return this.execute(`send-keys -t ${tmuxEscape(target)} -l ${tmuxEscape(keys)}`);
  }

  splitWindow(options: SplitOptions = {}): Promise<CommandResponse> {
    // [LAW:dataflow-not-control-flow] Build flag and target strings unconditionally;
    // variability lives in the values, not in whether the pieces are assembled.
    const dirFlag = options.vertical === true ? "-v" : "-h";
    const targetPart = options.target !== undefined ? ` -t ${tmuxEscape(options.target)}` : "";
    return this.execute(`split-window ${dirFlag}${targetPart}`);
  }

  // ---------------------------------------------------------------------------
  // Control-mode commands
  // ---------------------------------------------------------------------------

  setSize(width: number, height: number): Promise<CommandResponse> {
    return this.execute(`refresh-client -C ${width}x${height}`);
  }

  setPaneAction(paneId: number, action: PaneAction): Promise<CommandResponse> {
    // [LAW:one-source-of-truth] Format mirrors encoder.ts refreshClientPaneAction body.
    return this.execute(`refresh-client -A %${paneId}:${action}`);
  }

  // ---------------------------------------------------------------------------
  // Fire-and-forget subscriptions
  // ---------------------------------------------------------------------------

  subscribe(name: string, what: string, format: string): void {
    this.transport.send(refreshClientSubscribe(name, what, format));
  }

  unsubscribe(name: string): void {
    this.transport.send(refreshClientUnsubscribe(name));
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  close(): void {
    this.transport.close();
  }

  // ---------------------------------------------------------------------------
  // Internal message handler
  // ---------------------------------------------------------------------------

  // [LAW:single-enforcer] All FIFO correlation transitions happen here only.
  private handleMessage(msg: TmuxMessage): void {
    if (msg.type === "begin") {
      const entry = this.pending.shift();
      // [LAW:no-defensive-null-guards] If pending is empty tmux sent an unexpected
      // begin — nothing to correlate. The guard here is trust-boundary input validation.
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
      entry?.reject({
        commandNumber: entry.commandNumber,
        timestamp: entry.timestamp,
        output: entry.output,
        success: false,
      });
    }

    // [LAW:dataflow-not-control-flow] Emit unconditionally — all messages flow
    // through the emitter regardless of type.
    this.emitter.emit(msg);
  }
}
