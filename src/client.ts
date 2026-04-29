// src/client.ts
// TmuxClient — high-level interface to the tmux control mode protocol.
// Wraps TmuxTransport + TmuxParser + TypedEmitter into a single API surface.

// [LAW:one-source-of-truth] Command correlation state lives exclusively here.
// [LAW:single-enforcer] FIFO queue is the sole mechanism for matching responses to commands.

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
import type { TmuxEventMap } from "./emitter.js";
import type { TmuxTransport } from "./transport/types.js";
import { TmuxCommandError } from "./errors.js";
import { buildScopedFormat, parseRows, type Scope } from "./subscriptions.js";

// ---------------------------------------------------------------------------
// Supporting types
// ---------------------------------------------------------------------------

// [LAW:one-source-of-truth] SplitOptions shape lives in encoder.ts; re-exported here
// to keep TmuxClient's public API surface unchanged for consumers.
export type { SplitOptions } from "./protocol/encoder.js";

/**
 * Receipt for a typed format subscription created via `subscribeSessions`,
 * `subscribeWindows`, `subscribePanes`, or `subscribe(opts, handler)`.
 *
 * Calling `dispose()` synchronously removes the handler from the internal
 * router (so later `%subscription-changed` events for this name will not
 * invoke it) and fire-and-forget issues `refresh-client -B <name>` to tmux.
 *
 * `dispose()` is idempotent — calling it twice is safe.
 *
 * The handle remains valid across transport reconnects: when the client
 * re-issues subscriptions against a fresh tmux server (under fresh names),
 * the same handle still disposes the right subscription.
 */
export interface SubscriptionHandle {
  dispose(): void;
}

/**
 * Payload for the `subscription-error` client event. Surfaces failures from
 * the per-subscription resubscribe path that runs after a transport
 * reconnect.
 */
export interface SubscriptionErrorEvent {
  /** Lifecycle phase the error originated in. */
  readonly phase: "resubscribe";
  /** The freshly-allocated tmux subscription name we tried to (re)issue. */
  readonly name: string;
  /** Original failure cause from the underlying `sendRaw` rejection. */
  readonly cause: unknown;
}

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

// [LAW:one-source-of-truth] Per-subscription state lives in ONE record per
// live subscription. `name` is mutable because reissue (after a transport
// reconnect) allocates a fresh name against the new tmux server while the
// consumer-held `SubscriptionHandle` continues to point at the same entry.
interface SubscriptionEntry {
  readonly what: string;
  readonly format: string;
  readonly handler: (value: string) => void;
  name: string;
  disposed: boolean;
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

  // [LAW:single-enforcer] Subscription router: ONE map, ONE listener,
  // installed lazily on first typed subscribe. Auto-allocated names route
  // %subscription-changed events to the right entry without consumers
  // ever seeing the name. The entries Set is the canonical "live
  // subscriptions" list — reissueAll iterates it after a transport reconnect.
  // [LAW:one-source-of-truth] subRoutes is derived from entries (each
  // entry's current `name` keys into it); the two are kept in lockstep at
  // every mutation site.
  private readonly subRoutes = new Map<string, SubscriptionEntry>();
  private readonly subEntries = new Set<SubscriptionEntry>();
  private subCounter = 0;
  private subListenerInstalled = false;
  private transportReconnectInstalled = false;

  // [LAW:single-enforcer] Client-lifecycle event listeners (subscription
  // reset / per-subscription resubscribe error) live in their own sets,
  // separate from the tmux protocol-level emitter. The protocol emitter
  // dispatches `TmuxMessage` values; these events are client-internal and
  // would not fit that union without polluting it.
  private readonly subscriptionsResetHandlers = new Set<() => void>();
  private readonly subscriptionErrorHandlers = new Set<
    (ev: SubscriptionErrorEvent) => void
  >();

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

  on<K extends keyof TmuxEventMap>(
    event: K,
    handler: (ev: TmuxEventMap[K]) => void,
  ): void;
  on(event: "*", handler: (ev: TmuxMessage) => void): void;
  on(event: "subscriptions-reset", handler: () => void): void;
  on(
    event: "subscription-error",
    handler: (ev: SubscriptionErrorEvent) => void,
  ): void;
  on(event: string, handler: (ev: never) => void): void {
    if (event === "subscriptions-reset") {
      this.subscriptionsResetHandlers.add(handler as () => void);
      return;
    }
    if (event === "subscription-error") {
      this.subscriptionErrorHandlers.add(
        handler as (ev: SubscriptionErrorEvent) => void,
      );
      return;
    }
    this.emitter.on(event as "*", handler as (ev: TmuxMessage) => void);
  }

  off<K extends keyof TmuxEventMap>(
    event: K,
    handler: (ev: TmuxEventMap[K]) => void,
  ): void;
  off(event: "*", handler: (ev: TmuxMessage) => void): void;
  off(event: "subscriptions-reset", handler: () => void): void;
  off(
    event: "subscription-error",
    handler: (ev: SubscriptionErrorEvent) => void,
  ): void;
  off(event: string, handler: (ev: never) => void): void {
    if (event === "subscriptions-reset") {
      this.subscriptionsResetHandlers.delete(handler as () => void);
      return;
    }
    if (event === "subscription-error") {
      this.subscriptionErrorHandlers.delete(
        handler as (ev: SubscriptionErrorEvent) => void,
      );
      return;
    }
    this.emitter.off(event as "*", handler as (ev: TmuxMessage) => void);
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
  // Subscriptions (SPEC §14) — typed format subscriptions
  //
  // The library installs ONE internal `subscription-changed` listener (lazy,
  // on first call) and routes events to per-subscription handlers via an
  // auto-allocated name. Consumers never see the name — they get a
  // SubscriptionHandle whose `dispose()` removes the handler synchronously
  // and unsubscribes from tmux.
  //
  // Field/row separators are RS (\x1e) and US (\x1f) — C0 control bytes that
  // cannot appear in any tmux name, so name characters can never collide
  // with delimiters by construction.
  // ---------------------------------------------------------------------------

  /**
   * Subscribe to a per-session row stream. tmux iterates `#{S:...}` and emits
   * one row per session containing the requested fields, in order.
   *
   * `fields` is type-narrowed by the literal field-name list — `row.session_id`
   * is type-checked against the array you pass in.
   *
   * Resolves once tmux acknowledges the subscription (`%end`). Rejects with
   * `TmuxCommandError` if tmux rejects the format string.
   */
  subscribeSessions<F extends string>(
    fields: readonly F[],
    handler: (rows: Record<F, string>[]) => void,
  ): Promise<SubscriptionHandle> {
    return this.subscribeScoped("S", fields, handler);
  }

  /**
   * Subscribe to a per-window row stream. tmux iterates `#{S:#{W:...}}` and
   * emits one row per (session × window). Each row should include
   * `window_id` (or similar) so callers can re-correlate without the iteration
   * scope itself being part of the row.
   */
  subscribeWindows<F extends string>(
    fields: readonly F[],
    handler: (rows: Record<F, string>[]) => void,
  ): Promise<SubscriptionHandle> {
    return this.subscribeScoped("S:W", fields, handler);
  }

  /**
   * Subscribe to a per-pane row stream. tmux iterates `#{S:#{W:#{P:...}}}` and
   * emits one row per (session × window × pane). Rows should include
   * `window_id` so panes can be rebuilt under their owning window.
   */
  subscribePanes<F extends string>(
    fields: readonly F[],
    handler: (rows: Record<F, string>[]) => void,
  ): Promise<SubscriptionHandle> {
    return this.subscribeScoped("S:W:P", fields, handler);
  }

  /**
   * Low-level escape hatch for subscriptions outside the S/W/P iteration
   * scopes (e.g. `#{client_session}`). Auto-allocates a name; caller chooses
   * the format string and is responsible for separator safety.
   *
   * Prefer `subscribeSessions` / `subscribeWindows` / `subscribePanes` for
   * the standard topology shapes — they pick safe RS/US separators for you.
   */
  subscribe(
    opts: { what: string; format: string },
    handler: (value: string) => void,
  ): Promise<SubscriptionHandle> {
    return this.installRoutedSubscription(opts.what, opts.format, handler);
  }

  // [LAW:single-enforcer] Every typed subscribe path funnels through here:
  // build the scoped format, then route values through `parseRows` so the
  // handler receives typed records — no caller sees the wire string.
  private subscribeScoped<F extends string>(
    scope: Scope,
    fields: readonly F[],
    handler: (rows: Record<F, string>[]) => void,
  ): Promise<SubscriptionHandle> {
    const format = buildScopedFormat(scope, fields);
    return this.installRoutedSubscription("", format, (value) =>
      handler(parseRows(value, fields)),
    );
  }

  // [LAW:single-enforcer] All routed subscriptions allocate their name,
  // create their entry, and register the entry here. Failure cleans up so
  // a rejected subscribe never leaves a zombie route or entry behind.
  private async installRoutedSubscription(
    what: string,
    format: string,
    handler: (value: string) => void,
  ): Promise<SubscriptionHandle> {
    this.installSubscriptionListener();
    this.installTransportReconnectHook();
    const entry: SubscriptionEntry = {
      what,
      format,
      handler,
      name: `tmux-cm-sub-${++this.subCounter}`,
      disposed: false,
    };
    this.subEntries.add(entry);
    this.subRoutes.set(entry.name, entry);
    try {
      await this.sendRaw(refreshClientSubscribe(entry.name, what, format));
    } catch (err) {
      // [LAW:one-source-of-truth] On tmux rejection (bad format, etc.) the
      // route AND entry are removed so the canonical "live subscriptions"
      // set mirrors only what tmux has actually accepted.
      this.subRoutes.delete(entry.name);
      this.subEntries.delete(entry);
      entry.disposed = true;
      throw err;
    }
    return {
      dispose: () => {
        if (entry.disposed) return;
        entry.disposed = true;
        // [LAW:dataflow-not-control-flow] Sync handler removal first so any
        // %subscription-changed event already in flight is silently dropped
        // by the router; the unsubscribe wire command is fire-and-forget.
        // [LAW:one-source-of-truth] Both the route map and the entries set
        // are updated together — they are derived views over the same
        // canonical "live subscriptions" state.
        this.subRoutes.delete(entry.name);
        this.subEntries.delete(entry);
        // [LAW:dataflow-not-control-flow] tmux's response is irrelevant on
        // dispose — the route is already gone client-side. Swallow any
        // rejection so a torn-down transport doesn't surface a UnhandledRejection.
        void this.sendRaw(refreshClientUnsubscribe(entry.name)).catch(
          () => undefined,
        );
      },
    };
  }

  // [LAW:single-enforcer] Exactly one internal `subscription-changed`
  // listener exists per TmuxClient. Installed lazily so clients that never
  // call subscribe* don't pay for the listener.
  private installSubscriptionListener(): void {
    if (this.subListenerInstalled) return;
    this.subListenerInstalled = true;
    this.emitter.on("subscription-changed", (ev) => {
      const entry = this.subRoutes.get(ev.name);
      // [LAW:no-defensive-null-guards] entry can legitimately be missing
      // (event arrived after dispose, or for an unknown name) — that's a
      // routing decision encoded as data, not a bug.
      entry?.handler(ev.value);
    });
  }

  // [LAW:single-enforcer] Exactly one transport.onReconnect listener exists
  // per TmuxClient. Installed lazily on first subscribe so clients that
  // never subscribe pay nothing, and so transports that don't implement
  // onReconnect (e.g. spawnTmux) are not touched at all.
  private installTransportReconnectHook(): void {
    if (this.transportReconnectInstalled) return;
    if (this.transport.onReconnect === undefined) return;
    this.transportReconnectInstalled = true;
    this.transport.onReconnect(() => {
      // Fire-and-forget — reissueAll handles its own error reporting via
      // the `subscription-error` client event. Awaiting here would block
      // the transport's reconnect path on tmux response RTTs.
      void this.reissueAll();
    });
  }

  /**
   * Re-issue every live subscription against the current tmux server,
   * allocating fresh names. Called automatically when `transport.onReconnect`
   * fires; exposed so consumers building bespoke transports can also drive
   * it manually.
   *
   * Emits `subscriptions-reset` synchronously BEFORE any wire traffic, so
   * downstream projections (e.g. `TmuxModel`) can clear cached state and
   * show a "reconnecting" affordance until the first fresh delivery lands.
   *
   * Per-subscription failures emit `subscription-error` with `phase: 'resubscribe'`
   * and do NOT throw — one bad format does not kill the rest of the batch
   * or the client. The failed entry is dropped from the live set so a
   * second reconnect does not retry it indefinitely.
   *
   * Idempotent in the sense that calling it with no live subscriptions is
   * a no-op; safe to invoke multiple times.
   */
  async reissueAll(): Promise<void> {
    // [LAW:dataflow-not-control-flow] Notify consumers FIRST so they can
    // clear stale cached state synchronously, before any new tmux traffic
    // could deliver fresh data on top of the old.
    for (const handler of this.subscriptionsResetHandlers) handler();

    // Snapshot the entries set; reissue mutates `entry.name` and the
    // route map underneath us. Disposed entries are filtered at iteration
    // time because dispose can race with the loop.
    const snapshot = Array.from(this.subEntries);
    for (const entry of snapshot) {
      if (entry.disposed) continue;
      // [LAW:one-source-of-truth] Drop the OLD name's route mapping
      // before installing the new one. The entries set retains the
      // entry; we only swap the route key.
      this.subRoutes.delete(entry.name);
      const newName = `tmux-cm-sub-${++this.subCounter}`;
      entry.name = newName;
      this.subRoutes.set(newName, entry);
      try {
        await this.sendRaw(
          refreshClientSubscribe(newName, entry.what, entry.format),
        );
      } catch (cause) {
        // tmux rejected the resubscribe — drop both views to keep them
        // mirroring tmux state, then surface the failure. The entry's
        // SubscriptionHandle still works (dispose is idempotent on a
        // disposed entry).
        this.subRoutes.delete(newName);
        this.subEntries.delete(entry);
        entry.disposed = true;
        for (const h of this.subscriptionErrorHandlers) {
          h({ phase: "resubscribe", name: newName, cause });
        }
      }
    }
  }

  /**
   * Low-level subscribe with caller-supplied name. Used by connector layers
   * that route `%subscription-changed` events across IPC by name and need
   * the name to be a stable identifier on both sides.
   *
   * @internal End-users should prefer the typed helpers (`subscribeSessions`,
   *   `subscribeWindows`, `subscribePanes`) or the auto-allocating escape
   *   hatch (`subscribe(opts, handler)`).
   */
  subscribeRaw(
    name: string,
    what: string,
    format: string,
  ): Promise<CommandResponse> {
    return this.sendRaw(refreshClientSubscribe(name, what, format));
  }

  /**
   * Low-level unsubscribe by caller-supplied name. Pairs with
   * `subscribeRaw`.
   *
   * @internal
   */
  unsubscribeRaw(name: string): Promise<CommandResponse> {
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
