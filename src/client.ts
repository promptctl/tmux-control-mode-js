// src/client.ts
// TmuxClient — high-level interface to the tmux control mode protocol.
// Wraps TmuxTransport + TmuxParser + TypedEmitter into a single API surface.

// [LAW:one-source-of-truth] Command correlation state lives exclusively here.
// [LAW:single-enforcer] FIFO queue is the sole mechanism for matching responses to commands.

import {
  sameConnectionState,
  type ConnectionState,
} from "./connection-state.js";
import { TmuxParser } from "./protocol/parser.js";
import {
  buildCommand,
  refreshClientSize,
  refreshClientPaneAction,
  refreshClientSubscribe,
  refreshClientUnsubscribe,
  refreshClientSetFlags,
  refreshClientClearFlags,
  refreshClientReport,
  refreshClientQueryClipboard,
  detachClient,
  sendKeys as encodeSendKeys,
  splitWindow as encodeSplitWindow,
} from "./protocol/encoder.js";
import type { SplitOptions } from "./protocol/encoder.js";
import type {
  CommandResponse,
  PaneAction,
  TmuxMessage,
} from "./protocol/types.js";
import { TypedEmitter } from "./emitter.js";
import type { EmitterMessage, TmuxEventMap } from "./emitter.js";
import type { TmuxTransport } from "./transport/types.js";
import { TmuxCommandError } from "./errors.js";

// ---------------------------------------------------------------------------
// Supporting types
// ---------------------------------------------------------------------------

// [LAW:one-source-of-truth] SplitOptions shape lives in encoder.ts; re-exported here
// to keep TmuxClient's public API surface unchanged for consumers.
export type { SplitOptions } from "./protocol/encoder.js";

// ---------------------------------------------------------------------------
// Internal correlation state
// ---------------------------------------------------------------------------

interface PendingEntry {
  readonly resolve: (response: CommandResponse) => void;
  readonly reject: (err: TmuxCommandError) => void;
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

export class TmuxClient {
  private readonly transport: TmuxTransport;
  private readonly parser: TmuxParser;
  private readonly emitter: TypedEmitter;

  // [LAW:single-enforcer] FIFO queue and inflight slot are the sole correlation state.
  private readonly pending: PendingEntry[] = [];
  private inflight: InflightEntry | null = null;

  // [LAW:one-source-of-truth] connectionState is the single lifecycle field.
  // The transitions live in setConnectionState; nothing outside that method
  // mutates this field.
  private currentConnectionState: ConnectionState = { status: "connecting" };
  private userClosed = false;

  constructor(transport: TmuxTransport) {
    this.transport = transport;
    this.emitter = new TypedEmitter();
    this.parser = new TmuxParser((msg) => this.handleMessage(msg));

    // [LAW:dataflow-not-control-flow] onOutputLine always pushes to inflight.output;
    // inflight being null means no-op via optional chaining — data decides what happens.
    this.parser.onOutputLine = (_commandNumber, line) => {
      this.inflight?.output.push(line);
    };

    transport.onData((chunk) => {
      // First chunk from tmux is the cheapest "tmux is talking" signal.
      // [LAW:single-enforcer] Lifecycle transitions go through setConnectionState
      // only — the equality check inside makes this idempotent on every chunk.
      this.setConnectionState({ status: "ready" });
      this.parser.feed(chunk);
    });
    transport.onClose((reason) => {
      // The protocol-level `exit` event preserves backward compat; the
      // synthetic `connection-state: closed` is the lifecycle channel.
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
  // Connection lifecycle
  // ---------------------------------------------------------------------------

  get connectionState(): ConnectionState {
    return this.currentConnectionState;
  }

  // [LAW:single-enforcer] Sole writer for currentConnectionState. Idempotent:
  // a transition to the same status is a no-op (state objects are compared by
  // status string and, for closed/reconnecting, by their discriminating field).
  // Spawn-style TmuxClient never emits 'reconnected' — it has no second `ready`.
  private setConnectionState(next: ConnectionState): void {
    if (sameConnectionState(this.currentConnectionState, next)) return;
    this.currentConnectionState = next;
    this.emitter.emit({ type: "connection-state", state: next });
  }

  // ---------------------------------------------------------------------------
  // Event delegation — preserve overloads for type safety
  // ---------------------------------------------------------------------------

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

  // ---------------------------------------------------------------------------
  // Command execution
  // ---------------------------------------------------------------------------

  execute(command: string): Promise<CommandResponse> {
    return this.sendRaw(buildCommand(command));
  }

  // [LAW:single-enforcer] Pending queue is the single correlation path for both
  // execute() and sendRaw(). Encoder-produced wire strings (with LF) come in here;
  // raw user commands flow through execute() which wraps them in buildCommand first.
  private sendRaw(wire: string): Promise<CommandResponse> {
    return new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject });
      this.transport.send(wire);
    });
  }

  // ---------------------------------------------------------------------------
  // Convenience methods — every wire string comes from src/protocol/encoder.ts
  // [LAW:one-source-of-truth] Zero command-string formatting in this file.
  // ---------------------------------------------------------------------------

  listWindows(): Promise<CommandResponse> {
    return this.execute("list-windows");
  }

  listPanes(): Promise<CommandResponse> {
    return this.execute("list-panes");
  }

  sendKeys(target: string, keys: string): Promise<CommandResponse> {
    return this.sendRaw(encodeSendKeys(target, keys));
  }

  splitWindow(options: SplitOptions = {}): Promise<CommandResponse> {
    return this.sendRaw(encodeSplitWindow(options));
  }

  // ---------------------------------------------------------------------------
  // Control-mode commands
  // ---------------------------------------------------------------------------

  setSize(width: number, height: number): Promise<CommandResponse> {
    return this.sendRaw(refreshClientSize(width, height));
  }

  setPaneAction(paneId: number, action: PaneAction): Promise<CommandResponse> {
    return this.sendRaw(refreshClientPaneAction(paneId, action));
  }

  // ---------------------------------------------------------------------------
  // Subscriptions (SPEC §14)
  //
  // These now go through the correlation queue like every other command.
  // Each call resolves with the %end confirmation from tmux. Use the typed
  // event subscribers (client.on("subscription-changed", ...)) to receive
  // value updates over time — those are notifications and arrive
  // independently of the subscribe/unsubscribe acknowledgement.
  // ---------------------------------------------------------------------------

  subscribe(
    name: string,
    what: string,
    format: string,
  ): Promise<CommandResponse> {
    return this.sendRaw(refreshClientSubscribe(name, what, format));
  }

  unsubscribe(name: string): Promise<CommandResponse> {
    return this.sendRaw(refreshClientUnsubscribe(name));
  }

  // ---------------------------------------------------------------------------
  // Client flags (SPEC §9)
  // ---------------------------------------------------------------------------

  /**
   * Set client flags. Each entry is a flag name as documented in SPEC §9
   * (e.g., `"pause-after"`, `"pause-after=2"`, `"no-output"`, `"read-only"`).
   * Prefix with `!` to disable, or use `clearFlags()` for that case.
   */
  setFlags(flags: readonly string[]): Promise<CommandResponse> {
    return this.sendRaw(refreshClientSetFlags(flags));
  }

  /**
   * Clear client flags. Convenience for `setFlags(flags.map(f => "!" + f))`.
   */
  clearFlags(flags: readonly string[]): Promise<CommandResponse> {
    return this.sendRaw(refreshClientClearFlags(flags));
  }

  // ---------------------------------------------------------------------------
  // Reports (SPEC §15)
  // ---------------------------------------------------------------------------

  /**
   * Provide a terminal report (typically OSC 10/11 color responses) to tmux
   * on behalf of a pane. The `report` string is the raw escape-sequence
   * payload (e.g., `"\u001b]10;rgb:1818/1818/1818\u001b\\"`).
   */
  requestReport(paneId: number, report: string): Promise<CommandResponse> {
    return this.sendRaw(refreshClientReport(paneId, report));
  }

  // ---------------------------------------------------------------------------
  // Clipboard query (SPEC §19)
  // ---------------------------------------------------------------------------

  /**
   * Ask tmux to query the terminal's clipboard via OSC 52. Resolves with the
   * `%end` acknowledgement; clipboard contents arrive separately through the
   * terminal's response channel and are not delivered through this Promise.
   */
  queryClipboard(): Promise<CommandResponse> {
    return this.sendRaw(refreshClientQueryClipboard());
  }

  // ---------------------------------------------------------------------------
  // Detach (SPEC §4.1)
  // ---------------------------------------------------------------------------

  /**
   * Politely detach the client by sending a single LF on stdin (the SPEC §4.1
   * detach trigger). tmux responds by sending `%exit` and disconnecting.
   *
   * Distinct from `close()`: `detach()` asks tmux to disconnect cleanly,
   * while `close()` kills the underlying transport. Prefer `detach()` for
   * graceful shutdown; use `close()` if you need to terminate immediately.
   *
   * Fire-and-forget: tmux does not produce a `%begin`/`%end` pair for the
   * empty-line detach signal, so this method does not return a Promise.
   */
  detach(): void {
    this.transport.send(detachClient());
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  close(): void {
    // Flag intent BEFORE tearing down the transport — the onClose handler
    // reads this to disambiguate `disposed` from `exit`/`transport-error`.
    this.userClosed = true;
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
      entry?.reject(
        new TmuxCommandError({
          commandNumber: entry.commandNumber,
          timestamp: entry.timestamp,
          output: entry.output,
          success: false,
        }),
      );
    }

    // [LAW:dataflow-not-control-flow] Emit unconditionally — all messages flow
    // through the emitter regardless of type.
    this.emitter.emit(msg);
  }
}
