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
import { emptyKeysResponse, isPaneOutput } from "./protocol/types.js";
import { TypedEmitter } from "./emitter.js";
import type { EmitterMessage, TmuxEventMap } from "./emitter.js";
import type { PaneByteSink } from "./pane-sink.js";
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

  // [LAW:single-enforcer] Fan-out for pane bytes lives here, not in consumer
  //   code. Without this, every multi-consumer codebase rebuilds its own
  //   `MulticastSink` wrapper and the sink contract drifts caller-to-caller.
  // [LAW:one-source-of-truth] Map<paneId, Map<token, sink>> is the sole
  //   registry; `attachPaneSink` is the sole writer; the returned disposer
  //   is the sole deleter. Per-attachment tokens (a fresh symbol per call)
  //   keep each attachment independent — attaching the same sink twice
  //   yields two distinct attachments with two independent disposers, so
  //   `end?()` fires per-attachment, not per-sink-instance.
  // [LAW:types-are-the-program] The token-keyed Map makes the
  //   per-attachment lifecycle structural: there is no "is this sink already
  //   attached" check anywhere, because there can't be — every attachment
  //   has its own key by construction.
  private readonly paneSinks = new Map<number, Map<symbol, PaneByteSink>>();

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
  // Pane-byte subscriptions — the canonical surface
  //
  // [LAW:one-source-of-truth] `attachPaneSink` is the canonical pane-byte
  //   subscription. The `client.on('output', …)` and `client.on('extended-
  //   output', …)` event emitters become the deprecated underlying mechanism
  //   (see sibling deprecate ticket); they remain functional through one
  //   minor for external consumers we don't own.
  // [LAW:dataflow-not-control-flow] Variability lives in *which sink is
  //   attached* (a value of `PaneByteSink` type), never in *how a caller
  //   decodes bytes* (control flow scattered across every consumer).
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
   * bytes-only. If a consumer needs the age, surface it via a separate
   * variant once a real consumer requires it; speculative variants belong
   * to no ticket.
   *
   * @see PaneByteSink for the contract sinks must satisfy.
   */
  attachPaneSink(paneId: number, sink: PaneByteSink): () => void {
    const token = Symbol("PaneByteSink");
    let attachments = this.paneSinks.get(paneId);
    if (attachments === undefined) {
      attachments = new Map();
      this.paneSinks.set(paneId, attachments);
    }
    attachments.set(token, sink);

    // [LAW:dataflow-not-control-flow] Idempotency is structural — `delete`
    //   returns `true` only on the first successful removal of the token,
    //   so the boolean return value is the value that decides whether
    //   `end?()` fires. No closure-scoped `disposed` flag is needed.
    return () => {
      const set = this.paneSinks.get(paneId);
      if (set === undefined) return;
      const removed = set.delete(token);
      if (!removed) return;
      if (set.size === 0) {
        this.paneSinks.delete(paneId);
      }
      sink.end?.();
    };
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

    // [LAW:dataflow-not-control-flow] Emit unconditionally — all messages flow
    // through the emitter regardless of type.
    this.emitter.emit(msg);

    // [LAW:dataflow-not-control-flow] Sink dispatch also runs for every
    //   message; the discriminator check is type narrowing (only some message
    //   variants carry `paneId`+`data`), not a control-flow branch. The
    //   per-pane loop body is identical regardless of how many sinks are
    //   attached — a missing or empty registry yields zero iterations.
    this.dispatchToPaneSinks(msg);
  }

  // [LAW:single-enforcer] Sole dispatcher for pane-byte fan-out. Lives next
  // to handleMessage so both correlation transitions and sink dispatch share
  // one synchronous frame — no consumer can observe `%end` before its sinks
  // have seen the preceding `%output`.
  private dispatchToPaneSinks(msg: TmuxMessage): void {
    if (!isPaneOutput(msg)) return;
    const attachments = this.paneSinks.get(msg.paneId);
    if (attachments === undefined) return;
    // Snapshot before iterating. Per-chunk dispatch membership is fixed to
    // "what was attached when this chunk arrived" — a sink's `write` that
    // calls `attachPaneSink` or its own disposer must not change who sees
    // this chunk. Without the snapshot, JS Map iteration would expose
    // mid-write registry mutations into the current loop, breaking the
    // contract.
    for (const sink of Array.from(attachments.values())) sink.write(msg.data);
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
//
// Both bridge classes (`WebSocketTmuxClient`, `TmuxClientProxy`) declare
// `implements TmuxClientLike` so the overload set on `on`/`off` is checked at
// compile time even if a future `Pick` change erased an overload.
// ---------------------------------------------------------------------------

export type TmuxClientLike = Pick<
  TmuxClient,
  "connectionState" | "on" | "off" | "execute" | "subscribeRaw" | "unsubscribe"
>;
