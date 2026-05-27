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
  SinkRegistry,
  PaneTopologyManager,
  serverScope,
  parsePaneListLine,
  TopologyEpochTracker,
  type AttachOptions,
  type BytesSink,
} from "./pane-output.js";
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

  // [LAW:single-enforcer] Fan-out for pane bytes lives in `SinkRegistry`
  //   (see src/pane-output.ts). The same registry implementation is owned by
  //   every TmuxClientLike (WebSocketTmuxClient, TmuxClientProxy,
  //   BridgePaneStreamClient, FakeTmuxClient), so all implementations enforce
  //   the same per-attachment lifecycle and pre-dispatch snapshot discipline.
  // [LAW:one-source-of-truth] `attachBytesSink` delegates to `sinks.attach`;
  //   `handleMessage` delegates pane-byte dispatch to `sinks.dispatch` with
  //   `topology.get(paneId)`. No second attachment state or topology table.
  private readonly sinks = new SinkRegistry();
  private readonly topology = new PaneTopologyManager();
  private readonly topologyEpoch = new TopologyEpochTracker();

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
    // [LAW:dataflow-not-control-flow] Bootstrap fires on ready transition only
    // when topology-dependent (session/window) sinks are attached. No such
    // sinks = no bootstrap = no extra command. When the first session/window
    // sink is attached after ready, attachBytesSink triggers bootstrap there.
    if (next.status === "ready" && this.sinks.hasTopologyDependentSinks()) {
      void this.bootstrapTopology();
    }
  }

  // Bootstrap the topology table from a full server-wide pane listing.
  // Fire-and-forget; called on every "ready" transition. Failure is
  // non-fatal: topology remains empty until the next event or bootstrap.
  private async bootstrapTopology(): Promise<void> {
    const gen = this.topologyEpoch.startBootstrap();
    try {
      const r = await this.execute(
        "list-panes -a -F '#{pane_id} #{window_id} #{session_id}'",
      );
      // [LAW:dataflow-not-control-flow] gen is the epoch value that proves this
      // result is still authoritative. A window-close notification in the same
      // I/O frame may have fired synchronously before this microtask — if so,
      // the epoch advanced and this stale snapshot must not clobber the correct
      // synchronous update.
      if (!this.topologyEpoch.isBootstrapCurrent(gen)) return;
      const entries = r.output.flatMap((line) => {
        const parsed = parsePaneListLine(line);
        return parsed !== null ? [parsed] : [];
      });
      this.topology.seed(entries);
    } catch {
      // Non-fatal: topology races are handled at dispatch time.
    }
  }

  // Refresh topology for one window (triggered by layout-change / window-add).
  // On error, removes the window's panes (they may have closed).
  private async refreshWindowTopology(windowId: number): Promise<void> {
    const gen = this.topologyEpoch.startWindowRefresh(windowId);
    try {
      const r = await this.execute(
        `list-panes -t @${windowId} -F '#{pane_id} #{window_id} #{session_id}'`,
      );
      if (!this.topologyEpoch.isWindowRefreshCurrent(windowId, gen)) return;
      const entries = r.output.flatMap((line) => {
        const parsed = parsePaneListLine(line);
        return parsed !== null
          ? [{ paneId: parsed.paneId, sessionId: parsed.sessionId }]
          : [];
      });
      this.topology.updateWindow(windowId, entries);
    } catch {
      this.topology.removeWindow(windowId);
    }
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
  // [LAW:one-source-of-truth] `attachBytesSink` is the only way to receive
  //   pane bytes. The emitter's type surface excludes `PaneOutputMessage` so
  //   byte messages cannot flow through `on(...)`.
  // [LAW:dataflow-not-control-flow] Variability lives in the `BytesSink`
  //   value and the `PaneScope` value, never in how a caller decodes bytes
  //   or which method they call.
  // ---------------------------------------------------------------------------

  /**
   * Attach a `BytesSink` to receive pane chunks matching the given scope.
   *
   * `options.scope` defaults to `serverScope` (all panes on the server,
   * including future sessions). Use `paneScope(id)`, `windowScope(id)`, or
   * `sessionScope(id)` to narrow the subscription.
   *
   * Returns an idempotent disposer. `sink.end?.()` is called exactly once
   * when the disposer fires. Multiple sinks may be attached concurrently;
   * each is independent.
   *
   * @see BytesSink for the contract sinks must satisfy.
   * @see PaneScope for the scope options.
   */
  attachBytesSink(sink: BytesSink, options?: AttachOptions): () => void {
    const scope = options?.scope ?? serverScope;
    const dispose = this.sinks.attach(sink, scope);
    // [LAW:dataflow-not-control-flow] Lazy bootstrap: if the first
    // topology-dependent sink is attached while client is already ready,
    // bootstrap now so the new sink can route by session/window.
    if (
      (scope.kind === "session" || scope.kind === "window") &&
      this.currentConnectionState.status === "ready"
    ) {
      void this.bootstrapTopology();
    }
    return dispose;
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
    //   registry. `EmitterMessage` excludes `PaneOutputMessage` so passing a
    //   byte message to `emit` is a compile error. The two channels — sinks
    //   for bytes, emitter for state events — are disjoint by message type.
    // [LAW:dataflow-not-control-flow] `sinks.dispatch` takes the topology
    //   lookup result as a value; the dispatch path is the same shape on every
    //   chunk regardless of which buckets match.
    if (isPaneOutput(msg)) {
      this.sinks.dispatch(msg, this.topology.get(msg.paneId));
      return;
    }

    // [LAW:one-source-of-truth] Topology events update the single topology
    //   table. layout-change / window-add trigger async re-queries; window-close
    //   / unlinked-window-close remove entries synchronously; sessions-changed
    //   triggers a full bootstrap re-run.
    if (msg.type === "layout-change") {
      if (this.sinks.hasTopologyDependentSinks()) {
        void this.refreshWindowTopology(msg.windowId);
      }
    } else if (
      msg.type === "window-add" ||
      msg.type === "unlinked-window-add"
    ) {
      // [LAW:one-source-of-truth] A newly created window's pane is not yet in
      //   the topology table. Seed it now so the first bytes from the new pane
      //   route correctly to session/window-scoped sinks.
      if (this.sinks.hasTopologyDependentSinks()) {
        void this.refreshWindowTopology(msg.windowId);
      }
    } else if (
      msg.type === "window-close" ||
      msg.type === "unlinked-window-close"
    ) {
      this.topology.removeWindow(msg.windowId);
      // [LAW:dataflow-not-control-flow] This synchronous removal invalidates any
      // in-flight bootstrap or window-refresh that would re-add the closed panes.
      this.topologyEpoch.invalidateWindow(msg.windowId);
    } else if (msg.type === "sessions-changed") {
      if (this.sinks.hasTopologyDependentSinks()) {
        void this.bootstrapTopology();
      }
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
//   they are a paired capability. `attachBytesSink` is mandatory — every
//   TmuxClientLike must offer it; consumers that subscribe to pane bytes
//   depend on it as the canonical surface.
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
  | "attachBytesSink"
>;
