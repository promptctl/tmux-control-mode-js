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
import { emptyKeysResponse } from "./protocol/types.js";
import { TypedEmitter } from "./emitter.js";
import type { EmitterMessage, TmuxEventMap } from "./emitter.js";
import {
  PaneSinkRegistry,
  type PaneByteSink,
  type PaneByteMultiplexer,
} from "./pane-sink.js";
import { isPaneOutput } from "./protocol/types.js";
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

  // [LAW:single-enforcer] Fan-out for pane bytes lives in `PaneSinkRegistry`
  //   (see src/pane-sink.ts). The same registry implementation is owned by
  //   every emitter-backed bridge (TmuxClientProxy, WebSocketTmuxClient,
  //   BridgePaneStreamClient, FakeTmuxClient), so all `TmuxClientLike`
  //   implementations enforce the same per-attachment lifecycle, pre-emit
  //   snapshot, and throw-isolation from event-emitter listeners.
  // [LAW:one-source-of-truth] `attachPaneSink` delegates to
  //   `paneSinks.attach`; `handleMessage` delegates pane-byte dispatch to
  //   `paneSinks.dispatch`. No second per-pane attachment state exists.
  private readonly paneSinks = new PaneSinkRegistry();

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
  // Event delegation
  //
  // `TmuxEventMap` does not contain `'output'` or `'extended-output'` —
  // those messages flow through the sink registry, never the emitter. An
  // attempt to write `client.on('output', cb)` is a TS error (the key is
  // not in the map). The wildcard `'*'` overload's argument type is
  // `EmitterMessage`, which excludes `PaneOutputMessage`, so narrowing on
  // `msg.type === 'output'` produces `never` and the byte branch is
  // structurally unreachable. There is no overload that exposes bytes
  // through the emitter; the misdecode footgun is gone at the type level.
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
  // Pane-byte subscriptions — the sole channel
  //
  // [LAW:one-source-of-truth] `attachPaneSink` (per-pane) and
  //   `attachAllPanesSink` (forwarder/multiplexer) are the only way to
  //   receive pane bytes. The emitter's type surface excludes
  //   `PaneOutputMessage` so byte messages cannot flow through `on(...)`.
  // [LAW:dataflow-not-control-flow] Variability lives in *which sink is
  //   attached* (a value of `PaneByteSink` or `PaneByteMultiplexer` type),
  //   never in *how a caller decodes bytes* (control flow scattered across
  //   every consumer).
  // ---------------------------------------------------------------------------

  /**
   * Attach a sink to receive post-octal-decode bytes for one pane.
   *
   * Multiple sinks may be attached to the same pane; they receive every
   * chunk in attachment order. Returns a disposer that detaches *this
   * specific* sink (other sinks for the same pane keep receiving bytes)
   * and invokes `sink.end?.()` exactly once. The disposer is idempotent —
   * a second call is a no-op.
   *
   * Both `%output` and `%extended-output` route through this path. The
   * `extended-output` `age` field is dropped — the sink contract is
   * bytes-only. If a caller needs the age (forwarder bridges typically
   * do), use `attachAllPanesSink` with a `PaneByteMultiplexer` instead.
   *
   * @see PaneByteSink for the contract sinks must satisfy.
   */
  attachPaneSink(paneId: number, sink: PaneByteSink): () => void {
    return this.paneSinks.attach(paneId, sink);
  }

  /**
   * Attach a multiplexer to receive every pane-byte chunk for every pane
   * on this client. The multiplexer's `write(msg)` receives the full
   * `PaneOutputMessage` (including `paneId`, `type` discriminator, and the
   * `age` field on extended-output), which is what forwarders — WebSocket
   * bridges, Electron main forwarders, byte archives — need to faithfully
   * reconstruct the message downstream.
   *
   * Per-pane consumers should use `attachPaneSink` instead. Reach for
   * `attachAllPanesSink` only when you genuinely need every pane.
   *
   * @see PaneByteMultiplexer for the contract.
   */
  attachAllPanesSink(mux: PaneByteMultiplexer): () => void {
    return this.paneSinks.attachAllPanes(mux);
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
    // The encoder owns the empty-input precondition (returns null = no command
    // to send); an empty send is a no-op resolving without a round-trip.
    const cmd = encodeSendKeys(target, keys);
    return cmd === null
      ? Promise.resolve(emptyKeysResponse())
      : this.sendRaw(cmd);
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

  subscribeRaw(
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

    // [LAW:single-enforcer] Pane bytes flow exclusively through the sink
    //   registry. The emitter's type surface excludes `PaneOutputMessage`
    //   (`EmitterMessage` is defined as `EmitterTmuxMessage | …` where
    //   `EmitterTmuxMessage = Exclude<TmuxMessage, PaneOutputMessage>`),
    //   so attempting to pass a byte message to `emit` is a compile error.
    //   The two channels — sinks for bytes, emitter for state — are
    //   disjoint by message type, and `isPaneOutput`'s narrowing is what
    //   makes the disjointness check explicit at this site.
    // [LAW:dataflow-not-control-flow] `paneSinks.dispatch` internally
    //   snapshots the per-chunk attachment set before iterating, so
    //   mutations to `paneSinks` (a sink's `write` calling attach/dispose)
    //   cannot back-fill or skip the current chunk.
    if (isPaneOutput(msg)) {
      this.paneSinks.dispatch(msg);
      return;
    }

    this.emitter.emit(msg);
  }
}

// ---------------------------------------------------------------------------
// TmuxClientLike — transport-agnostic projection of the TmuxClient surface.
//
// The slice every PaneStream-style consumer needs from a TmuxClient-shaped
// object: connection state, event subscription, command execution, and the
// subscribe/unsubscribe pair for tmux format subscriptions.
//
// [LAW:one-source-of-truth] Derived via `Pick<TmuxClient, …>` so adding or
//   renaming a member here propagates from `TmuxClient` automatically and
//   surfaces as a compile error at every consumer's call site — no hand-typed
//   mirror, no drift.
// [LAW:types-are-the-program] subscribe/unsubscribe are mandatory because
//   they are a paired capability: a consumer that subscribes must be able to
//   unsubscribe at dispose. Optionality on either method would force a runtime
//   probe at every callsite; making them mandatory eliminates the probe.
//   `attachPaneSink` is mandatory for the same reason — pane-byte consumption
//   is the canonical surface, so every TmuxClient-shaped object must offer it
//   and every consumer (PaneStream is the in-repo one) routes through it.
//
// Both bridge classes (`WebSocketTmuxClient`, `TmuxClientProxy`) declare
// `implements TmuxClientLike` so the overload set on `on`/`off` is checked at
// compile time even if a future `Pick` change erased an overload.
// ---------------------------------------------------------------------------

export type TmuxClientLike = Pick<
  TmuxClient,
  | "connectionState"
  | "on"
  | "off"
  | "execute"
  | "subscribeRaw"
  | "unsubscribe"
  | "attachPaneSink"
  | "attachAllPanesSink"
>;
