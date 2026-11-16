// src/window-terminal/engine/pane-stream.ts
//
// `PaneStream` — environment-agnostic pane data carrier. Owns the
// idle→seeding→live↔detached→disposed state machine for a single tmux pane,
// dispatches live byte chunks to an attached `TerminalSink`, and maintains a
// detached-mode activity counter (lastByteAt + bytesSinceLastAttach) coalesced
// to a single timer per stream.
//
// No DOM. No xterm. No React. Sinks come in over the seam declared in
// ./terminal-sink.ts; the renderer is the consumer's choice (BufferingSink for
// tests/buffering, XtermSink for the browser).
//
// [LAW:dataflow-not-control-flow] One BytesSink is attached ONCE in the
//   constructor (O2) and runs on every byte chunk for this stream's pane.
//   The same operations execute every byte; the value of `state` decides what
//   happens. `attachBytesSink` with paneScope filters by paneId, so no
//   per-callsite paneId guard exists either — the type carries the filter.
//   No subscribe/unsubscribe churn at TerminalSink attach time.
// [LAW:locality-or-seam] PaneStream's only seam to the byte producer is the
//   `BytesSink` contract via `attachBytesSink`, not the deprecated event surface.
//   This narrows what consumers can do (and what bridges must implement).
// [LAW:single-enforcer] One activity-flush timer per stream. The byte path
//   only sets a flag and calls setTimeout(boundFlush) when no flush is
//   pending — there is exactly one path that emits 'activity-changed'.
// [LAW:one-source-of-truth] State transitions live in `setState` only.
//   External views (`get state()`) read from `currentState` directly.

import type { Grid, TerminalSink } from "./terminal-sink.js";
import { buildSeed, parseGrid, type Seed } from "./seed-builder.js";
import { uniqueToken } from "./token.js";
import { rethrowUnlessUnsubscribed } from "./teardown.js";
// [LAW:one-way-deps] The window-terminal engine runs in the browser; it imports
// the pure pane-output core from `browser.ts`, never the root entry `index.ts`
// (which pulls the Node-only transport and breaks browser bundlers).
import type {
  BytesSink,
  ClientSizeSurface,
  Outcome,
  SubscriptionSurface,
  TmuxConnection,
  TmuxEventMap,
} from "../../browser.js";
import { paneScope, isConnectionGone, sendKeyBytes } from "../../browser.js";
import type { CommandResponse } from "../../protocol/index.js";

/**
 * What a window terminal runs over: a connection whose format subscriptions
 * are its own methods, so a bridge can end them when the page goes away.
 * `TmuxClient`, `WebSocketTmuxClient` and the Electron renderer client are all
 * one.
 *
 * [LAW:no-ambient-temporal-coupling] A seed also relies on an order the types
 * cannot state, which every one of them keeps: events and pane bytes arrive in
 * the order tmux wrote them, and a command's reply resolves after its `begin`
 * event. A reply that outruns its `begin` fails the seed (`lastError`).
 */
export type TerminalConnection = TmuxConnection &
  SubscriptionSurface &
  ClientSizeSurface;
import {
  getScheduler,
  type ReseedPriority,
  type ReseedTarget,
} from "./reseed-scheduler.js";

// `setTimeout`/`clearTimeout`/`Date` exist in every host (browser, Node, Bun,
// Deno). Declare the minimal shapes here so the env-agnostic core
// (tsconfig.core.json — no DOM, no @types/node) still compiles.
declare const setTimeout: (handler: () => void, ms?: number) => unknown;
declare const clearTimeout: (id: unknown) => void;
declare const Date: { now(): number };

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type PaneStreamState =
  | "idle"
  | "seeding"
  | "live"
  | "detached"
  | "disposed";

export interface PaneActivity {
  readonly lastByteAt: number;
  readonly bytesSinceLastAttach: number;
}

/**
 * Which effect seam failed. `PaneStream` performs exactly two tmux effects
 * whose failure would otherwise go unseen:
 *
 * - `"subscribe"` — the per-pane size subscription (`refresh-client -B`) issued
 *   at construction. Without it tmux never reports this pane's geometry, so
 *   the sink keeps the size of the first seed while the pane moves on.
 * - `"seed"` — the `capture-pane` + `display-message` snapshot at attach. A
 *   failed seed leaves the consumer unable to tell "seed failed" from "the pane
 *   is genuinely blank."
 */
export type PaneStreamErrorPhase = "subscribe" | "seed";

/**
 * An effect at one of `PaneStream`'s tmux seams failed in a way that alters
 * what the consumer sees (a blank pane). Delivered on the `'error'` event and
 * retained on {@link PaneStream.lastError} so a consumer that subscribes after
 * a construction-time subscribe failure can still read it.
 *
 * Connection-gone failures ({@link isConnectionGone}) are NOT reported here:
 * the whole connection is tearing down and `reconnected` re-drives the seed /
 * subscription, so a pane-level signal for that would be noise. Only failures
 * where tmux was alive and the outcome matters reach this type.
 *
 * [LAW:no-silent-failure] Having a signal is not optional; what the consumer
 *   DOES with it (retry, fallback size, error UI) is the consumer's business.
 */
export interface PaneStreamError {
  readonly phase: PaneStreamErrorPhase;
  readonly paneId: number;
  /** The original rejection, for consumers that want to inspect the class. */
  readonly cause: unknown;
}

// Per the design doc (O6), visibility is owned by the *sink* — the sink
// knows its own DOM container's IntersectionObserver / document.visibilityState
// state. PaneStream delegates to `sink.isVisible()` when computing reseed
// priority. There is no stream-side `Visibility` type or setter.

export interface PaneStreamOptions {
  readonly client: TerminalConnection;
  readonly paneId: number;
  /**
   * Lines of scrollback to include in the seed (`capture-pane -S -<N>`).
   * Default 2000 — matches tmux's default `history-limit`, so a freshly
   * attached pane can scroll back through its existing history (a pane with
   * no seeded scrollback has nothing to scroll into). Set 0 for a
   * visible-screen-only seed when minimum attach latency matters more than
   * history; higher values capture deeper history at more attach cost.
   */
  readonly historyLines?: number;
  /**
   * Coalescing window for `'activity-changed'` events. Default 100ms (O7).
   * The activity counters update synchronously on every byte; the *event*
   * fires at most once per window.
   */
  readonly activityThrottleMs?: number;
}

// [LAW:one-source-of-truth] Each event's payload is named here and nowhere
//   else; the event names, listener types, and listener registry all derive
//   from this map.
// `reconnected` listeners take no payload. We model them with `[]` instead
// of `void` so the listener type stays a plain function with zero params,
// dodging `@typescript-eslint/no-invalid-void-type` while keeping the
// per-event payload type checked.
interface PaneStreamEvents {
  "state-changed": [PaneStreamState];
  "activity-changed": [PaneActivity];
  reconnected: [];
  error: [PaneStreamError];
}

type EventName = keyof PaneStreamEvents;

type Listener<E extends EventName> = (...args: PaneStreamEvents[E]) => void;

// [LAW:types-are-the-program] The event name is the key, so a listener can
//   only ever be stored under its own event — indexing with a generic `E`
//   yields `Set<Listener<E>>` with no cast to vouch for the pairing.
type ListenerRegistry = { [E in EventName]: Set<Listener<E>> };

type Unsubscribe = () => void;

/**
 * The capture-pane RPC phase for one stream — "is a capture in flight, and is
 * a fresh one owed?" as a single value.
 *
 * - `idle` — no capture-pane RPC outstanding.
 * - `capturing` — a capture is in flight, with the pane's bytes since it was
 *   issued and where each reply's `%begin` fell among them. `stale` records
 *   whether the pane changed under it (reconnect, `%pause`, a recapture); when
 *   set, `seed()` drops the result on resolution (and re-issues if anyone is
 *   still attached).
 *
 * [LAW:types-are-the-program] Everything a capture needs lives on its
 *   `capturing` value and dies with it: no staleness, buffer or `%begin` mark
 *   exists without a capture in flight, and a new capture starts with none.
 *   [LAW:single-enforcer] `markSeedStale` is the single owner of the `stale`
 *   write.
 *
 * Distinct, orthogonal axes deliberately kept separate: `lastSeed` (the cached
 * picture a re-attach replays) and `ReseedScheduler.currentRun` (the
 * cross-stream sweep guard, one per client). Neither is a capture *phase*.
 */
type SeedCycle = { readonly phase: "idle" } | Capturing;

interface Capturing {
  readonly phase: "capturing";
  stale: boolean;
  // Every chunk of the pane's bytes since the capture was issued, while a sink
  // waits for it (a byte while detached marks the capture stale instead). The
  // ones after the capture's `%begin` are the seed's `trailing`.
  readonly buffer: Uint8Array[];
  // Each reply `%begin` seen while the capture flies, by tmux's command
  // number, and how many chunks the buffer held when it came. tmux parses a
  // pane's bytes into its grid as it writes them to the control client and
  // runs a whole command line between two of those writes, so the capture
  // holds every byte before its line's `%begin` and none after.
  readonly begins: Map<number, number>;
}

/** A capture's reply, split, with where its `%begin` fell in the buffer. */
interface CaptureReply {
  readonly output: readonly string[];
  readonly stateLine: string;
  readonly begunAt: number;
}

// ---------------------------------------------------------------------------
// PaneStream
// ---------------------------------------------------------------------------

export class PaneStream implements ReseedTarget {
  readonly paneId: number;

  private readonly client: TerminalConnection;
  private readonly historyLines: number;
  private readonly activityThrottleMs: number;
  private readonly subscriptionName: string;

  private currentState: PaneStreamState = "idle";
  private sink: TerminalSink | null = null;
  // The pane's picture as of a capture nothing has followed — kept so a
  // re-attach can hand the new sink that picture WITHOUT a fresh capture-pane
  // round-trip (re-mount churn on an idle pane → exactly one capture). Set
  // inside seed(); cleared by every byte and by anything else that moves the
  // pane (reconnect, `%pause`, a recapture).
  private lastSeed: Seed | null = null;
  // [LAW:single-enforcer] One in-flight capture-pane RPC per stream at a time,
  // plus its staleness, as a single value (see {@link SeedCycle}). attach() and
  // reseed() short-circuit while the phase is not `idle` (the resolution will
  // pick up `this.sink` whatever it is then) — required under React StrictMode,
  // where mount→cleanup→mount happens synchronously *inside* one rendered frame,
  // landing both attaches before the first capture-pane resolves. All writes
  // live in `startSeedCycle` (start), `seed()` (resolution) and
  // `markSeedStale`.
  private seedCycle: SeedCycle = { phase: "idle" };
  // tmux paused this pane's output (`%pause`) and drops what it writes until
  // `%continue`, so no capture taken in between is the whole picture.
  private paused = false;
  // The size the stream holds the pane at: tmux's last report on this
  // connection, or, before the first, the size the first capture was taken
  // at. null until either.
  // [LAW:one-source-of-truth] Once tmux reports, only its reports write this:
  //   tmux keeps a subscription quiet while its value is the one it last sent,
  //   so only that value says what tmux's silence means.
  private size: Grid | null = null;

  // Activity accounting. Updated synchronously on every byte event.
  // The flush emits a frozen snapshot at most every `activityThrottleMs`.
  private currentLastByteAt = 0;
  private currentBytesSinceAttach = 0;
  private flushTimerId: unknown = null;

  // Listener registry. Per-event Sets so add/remove is O(1).
  private readonly listeners: ListenerRegistry = {
    "state-changed": new Set(),
    "activity-changed": new Set(),
    reconnected: new Set(),
    error: new Set(),
  };

  // [LAW:no-silent-failure] Outstanding seam failures, retained for the pull
  //   model (`get lastError()`). The subscribe effect fires in the constructor,
  //   before any consumer can attach an `'error'` listener, so a push-only
  //   signal would emit into the void; retaining it lets a consumer that
  //   subscribes afterwards still observe the failure. Mirrors the dual
  //   push/pull the class already uses for state and activity.
  //
  // [LAW:one-source-of-truth] Keyed PER PHASE, not a single slot: subscribe and
  //   seed are independent seams that can BOTH be outstanding. A single slot
  //   would let a recovery at one seam (`clearError`) erase a still-live failure
  //   at the other — re-manufacturing the silent failure this ticket removes.
  //   Insertion order is recency (report re-inserts), so `lastError` can return
  //   the most-recent still-outstanding failure.
  private readonly seamErrors = new Map<
    PaneStreamErrorPhase,
    PaneStreamError
  >();

  // Pre-bound handlers for the non-byte events PaneStream still consumes
  // from the emitter (`reconnected`, `subscription-changed`) and for the
  // throttled activity flush. Each is allocated once at construction so
  // `client.off(...)` can find the same reference at dispose. None of these
  // are on the [HOT-PATH] — the per-byte path lives in the `BytesSink`
  // attached via `client.attachBytesSink(...)`, whose `write` closure is
  // also allocated once (in the constructor's `paneSink` literal below).
  private readonly onReconnected: (ev: TmuxEventMap["reconnected"]) => void;
  private readonly boundFlushActivity: () => void;
  private readonly onSubscriptionChanged: (
    ev: TmuxEventMap["subscription-changed"],
  ) => void;
  private readonly onPause: (ev: TmuxEventMap["pause"]) => void;
  private readonly onContinue: (ev: TmuxEventMap["continue"]) => void;
  private readonly onBegin: (ev: TmuxEventMap["begin"]) => void;

  // [LAW:one-source-of-truth] The byte path's only attach point. Set once in
  //   the constructor by `client.attachBytesSink(...)`; called exactly once
  //   from `dispose()`. The library's disposer is itself idempotent, so a
  //   double-call would be a no-op — guarding here is a structural assertion
  //   that PaneStream owns one attachment, not a defensive check.
  private paneSinkDisposer: (() => void) | null = null;

  constructor(opts: PaneStreamOptions) {
    this.client = opts.client;
    this.paneId = opts.paneId;
    this.historyLines = opts.historyLines ?? 2000;
    this.activityThrottleMs = opts.activityThrottleMs ?? 100;
    // [LAW:one-source-of-truth] One name per stream instance: tmux keys
    //   subscriptions by name per control client, so a name shared by two
    //   streams of one pane (two views, or two pages through one bridge) let
    //   the first dispose end the other's subscription.
    this.subscriptionName = `wt-${uniqueToken()}-size-%${opts.paneId}`;

    this.onReconnected = () => {
      // A pause belonged to the connection that carried it.
      this.paused = false;
      // So did the size: the new connection's subscription has reported
      // nothing yet, and may never report this pane (a new control client
      // whose session does not hold it).
      this.size = null;
      // The pane moved while we were disconnected: the cache and any
      // capture-pane in flight are pre-reconnect pictures, so the
      // ReseedScheduler's upcoming reseed() (or the next attach()) captures
      // afresh.
      this.markSeedStale();
      // A reconnect can be a new control client (a browser re-joining a
      // bridge is a new peer), which holds none of the old one's
      // subscriptions; re-issuing under the same name replaces, so this is
      // right whether or not the old one survived.
      this.subscribeSize();
      // ReseedScheduler owns dispatch; we just notify our own listeners
      // so consumers (e.g. status badges) can react.
      for (const h of this.listeners.reconnected) h();
    };
    this.boundFlushActivity = () => this.flushActivity();

    // O2: attach the byte sink at construction via `attachBytesSink` with
    // paneScope. The sink's `write` closure runs for every chunk on this
    // pane's scope for the lifetime of the attachment; state value decides
    // what happens with each chunk.
    //
    // The sink is a private object literal — PaneStream does NOT expose
    // `write` publicly because that would let consumers bypass the state
    // machine. The closure forwards into `handlePaneBytes`.
    //
    // [LAW:locality-or-seam] One attachment, one disposer. `BytesSink` via
    //   `attachBytesSink` is the pane-byte subscription surface; `reconnected`
    //   and `subscription-changed` are non-byte events and stay on the emitter.
    const paneSink: BytesSink = {
      write: (msg) => this.handlePaneBytes(msg.data),
      // [LAW:types-are-the-program] end() is required by BytesSink contract.
      // PaneStream.dispose() owns teardown; end() is a no-op here.
      end(): void {
        /* stateless sink — PaneStream.dispose() owns teardown */
      },
    };
    this.paneSinkDisposer = this.client.attachBytesSink(paneSink, {
      scope: paneScope(this.paneId),
    });

    this.client.on("reconnected", this.onReconnected);

    // [LAW:dataflow-not-control-flow] The subscription path always runs; it
    // goes through the connection's own subscription methods (see
    // `TerminalConnection`) so a bridge owns its lifetime.
    this.onSubscriptionChanged = (ev) => this.handleSubscriptionChanged(ev);
    this.client.on("subscription-changed", this.onSubscriptionChanged);
    this.subscribeSize();

    // A flood: something (a bridge's backpressure, `pause-after`) paused this
    // pane's output. tmux drops what the pane writes while paused, so the
    // picture is known to be behind from the pause on, and only a fresh
    // capture after `%continue` makes it whole again. `seeding` is the state
    // that says so.
    this.onPause = (ev) => {
      if (ev.paneId !== this.paneId) return;
      this.paused = true;
      this.markSeedStale();
      if (this.sink === null) return;
      this.setState("seeding");
    };
    this.onContinue = (ev) => {
      if (ev.paneId !== this.paneId) return;
      this.paused = false;
      this.recapture();
    };
    this.client.on("pause", this.onPause);
    this.client.on("continue", this.onContinue);

    // A `begin` arrives in tmux's order with the pane bytes, and no byte
    // falls inside a reply block, so the buffer's length when it arrives is
    // where that reply sits in the pane's bytes.
    this.onBegin = (ev) => {
      if (this.seedCycle.phase !== "capturing") return;
      this.seedCycle.begins.set(ev.commandNumber, this.seedCycle.buffer.length);
    };
    this.client.on("begin", this.onBegin);

    // [LAW:one-source-of-truth] Per-client reseed scheduler. Registering at
    // construction means the scheduler can include this stream in its very
    // first reconnect dispatch — even if the consumer hasn't called
    // attach() yet (priority() will tag it 'detached', so dispatch skips it).
    getScheduler(this.client).register(this);
  }

  // Per-pane width;height in one subscription (single message,
  // semicolon-separated) so tmux performs the layout walk for us.
  // tmux sends the subscription's first value at its next check (up to a
  // second away), then each change, but only for a pane whose window is in
  // the control client's session; for any other pane it sends nothing, and
  // the first seed's size is all the sink gets.
  // [LAW:no-silent-failure] A failed subscribe means tmux will never report
  //   this pane's geometry. `reportError` lifts the failure to the 'error'
  //   seam (classifying connection-gone as the quiet, reconnect-re-driven
  //   case).
  private subscribeSize(): void {
    void this.client
      .subscribeRaw(
        this.subscriptionName,
        `%${this.paneId}`,
        "#{pane_width};#{pane_height}",
      )
      .catch((err: unknown) => this.reportError("subscribe", err));
  }

  // -------------------------------------------------------------------------
  // Public surface
  // -------------------------------------------------------------------------

  get state(): PaneStreamState {
    return this.currentState;
  }

  get activity(): PaneActivity {
    // [LAW:no-defensive-null-guards] Always a valid value; consumers that
    // want a snapshot subscribe to 'activity-changed'.
    return Object.freeze({
      lastByteAt: this.currentLastByteAt,
      bytesSinceLastAttach: this.currentBytesSinceAttach,
    });
  }

  /**
   * The most recent STILL-OUTSTANDING seam failure, or `null` if every seam is
   * healthy. A failure at one seam that has since recovered does not mask a
   * failure still outstanding at the other — each seam is tracked independently,
   * so a subscribe failure remains visible here even after a seed failure was
   * reported and then recovered. `null` after a connection-gone failure too —
   * those are deliberately not surfaced (see {@link PaneStreamError}).
   * Pull-model companion to the `'error'` event, for consumers that subscribe
   * after a construction-time subscribe failure.
   */
  get lastError(): PaneStreamError | null {
    // Map iterates in insertion order and `reportError` re-inserts, so the last
    // value is the most-recently-surfaced outstanding failure.
    let latest: PaneStreamError | null = null;
    for (const err of this.seamErrors.values()) latest = err;
    return latest;
  }

  /**
   * Attach a sink.
   *
   * - **First attach** (no cached seed) — issues one command line,
   *   capture-pane then the cursor-and-modes query, buffers the live bytes
   *   that arrive in the meantime, and on the reply seeds the sink with the
   *   snapshot and the bytes after the reply's `%begin`. State path:
   *   `idle → seeding → live`.
   * - **Re-attach** (a prior attach already seeded successfully) — replays
   *   the cached seed to the new sink synchronously, no tmux round-trip.
   *   State path: `detached → live`. This is the re-attach contract: mount churn
   *   (visibility flicker, React strict-mode, tab restore) must not multiply
   *   tmux load on an idle pane. Any byte invalidates the cache (the pane has
   *   moved past it), as do reconnect, `%pause` and a recapture.
   * - **Capture in flight** — waits for it; its resolution seeds this sink.
   */
  attach(sink: TerminalSink): void {
    if (this.currentState === "disposed") return;
    if (this.sink !== null) {
      // Already attached. Treat as no-op rather than silently swap, which
      // would orphan the previous sink's lifecycle.
      return;
    }
    this.sink = sink;
    // Reset attach-scoped activity counter so consumers see "since I started
    // looking", not "since the universe began."
    this.currentBytesSinceAttach = 0;
    // A sink attaching after the stream knows the size is handed it: tmux
    // does not send it again, and a cached seed below is drawn at it.
    fit(sink, this.size);

    if (this.seedCycle.phase !== "idle") {
      // A capture-pane is already in flight from a previous attach (e.g.
      // React StrictMode's mount→cleanup→remount happens before the first
      // RPC resolves). Don't issue a second capture — when the in-flight
      // one resolves, it will read `this.sink` and seed it. The exactly-one-
      // capture guarantee under StrictMode depends on this short-circuit.
      // Checked before the cache: the capture in flight is newer than it.
      this.setState("seeding");
      return;
    }

    if (this.lastSeed !== null) {
      // Re-attach fast path. Synchronous: hand the new sink the cached
      // payload and flip straight to live. No capture-pane is issued, and no
      // byte has arrived since the capture (any byte clears the cache), so
      // `trailing` is empty — the cached snapshot is the whole picture.
      sink.seed(this.lastSeed.captured, this.lastSeed.cursor, []);
      this.setState("live");
      return;
    }

    this.setState("seeding");
    void this.startSeedCycle();
  }

  /**
   * Detach the current sink. State flips to 'detached'; live bytes continue
   * to arrive at the output handler but only update the activity counter,
   * and mark a capture in flight stale. A capture nothing followed still
   * serves a re-attach (StrictMode's mount→cleanup→mount, synchronous: one
   * capture). Re-attaching is allowed and re-seeds.
   */
  detach(): void {
    if (this.currentState === "disposed") return;
    if (this.sink === null && this.currentState === "detached") return;
    this.sink = null;
    this.setState("detached");
  }

  /**
   * Send input bytes to the underlying pane via tmux `send-keys`.
   * Convenience wrapper so consumers don't need to format pane targets.
   */
  sendKeyBytes(bytes: Uint8Array): Promise<CommandResponse> {
    return sendKeyBytes(this.client, `%${this.paneId}`, bytes);
  }

  on<E extends EventName>(event: E, handler: Listener<E>): Unsubscribe {
    const set = this.listeners[event];
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  }

  dispose(): void {
    if (this.currentState === "disposed") return;
    this.setState("disposed");

    // [LAW:single-enforcer] One disposer per attachment. The library's
    //   `attachBytesSink` returned function is idempotent and fires
    //   `sink.end?.()` exactly once — null-out the field so a future call
    //   path that re-enters dispose() observes "already torn down" via the
    //   value, not via a separate boolean guard.
    this.paneSinkDisposer?.();
    this.paneSinkDisposer = null;
    this.client.off("reconnected", this.onReconnected);

    this.client.off("subscription-changed", this.onSubscriptionChanged);
    this.client.off("pause", this.onPause);
    this.client.off("continue", this.onContinue);
    this.client.off("begin", this.onBegin);
    // Any failure but an already-absent subscription has nobody left to
    // report to here, so it surfaces as an unhandled rejection.
    void this.client
      .unsubscribe(this.subscriptionName)
      .catch(rethrowUnlessUnsubscribed);

    if (this.flushTimerId !== null) {
      clearTimeout(this.flushTimerId);
      this.flushTimerId = null;
    }
    this.sink = null;
    for (const set of Object.values(this.listeners)) set.clear();
    // [LAW:single-enforcer] dispose() is the one teardown — drop the retained
    //   error chain too, so a consumer holding a disposed stream can't read a
    //   stale failure and the PaneStreamError.cause chain is free to GC.
    this.seamErrors.clear();
    getScheduler(this.client).unregister(this);
  }

  // -------------------------------------------------------------------------
  // ReseedTarget
  // -------------------------------------------------------------------------

  priority(): ReseedPriority {
    if (this.currentState === "disposed") return 2;
    if (this.sink === null) return 2;
    // O6: visibility is owned by the sink. Visible-attached comes first;
    // attached-but-hidden is second. The scheduler skips priority>=2.
    return this.sink.isVisible() ? 0 : 1;
  }

  async reseed(): Promise<void> {
    if (this.currentState === "disposed") return;
    if (this.sink === null) return;
    // [LAW:single-enforcer] One in-flight capture-pane per stream. If a seed
    // is already running (the reconnect handler marked it stale, so it'll
    // auto-re-issue on resolution), there's nothing for reseed() to do.
    if (this.seedCycle.phase !== "idle") return;
    // Re-enter seeding so any byte arriving during the new capture is
    // buffered, not interleaved with the previous live frame.
    this.setState("seeding");
    await this.startSeedCycle();
  }

  /**
   * The pane changed under the picture (`%continue`, a new size): drop the
   * cache, and capture again; a capture already in flight began before the
   * change, so its result is dropped and it re-issues while a sink is
   * attached.
   */
  private recapture(): void {
    this.markSeedStale();
    if (this.seedCycle.phase === "idle") void this.reseed();
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  // [HOT-PATH] Per-byte byte-arrival path: must not allocate per call.
  // Branching on values (currentState) is fine — the rule forbids
  // allocation expressions, not conditionals.
  //
  // [LAW:types-are-the-program] No paneId parameter: `attachBytesSink` with
  //   `paneScope(paneId)` filters at the attach site, so this method receives
  //   only bytes destined for *this* PaneStream. The earlier
  //   `if (paneId !== this.paneId) return` guard existed because the
  //   `on('output', …)` emitter fan-out delivered every pane's bytes to
  //   every listener; the sink contract makes that mismatch unrepresentable
  //   at the call boundary.
  private handlePaneBytes(data: Uint8Array): void {
    if (this.currentState === "disposed") return;

    // Activity accounting (no allocation: number arithmetic + getters).
    this.currentLastByteAt = Date.now();
    this.currentBytesSinceAttach += data.byteLength;

    // [LAW:one-source-of-truth] The cached seed is the pane's picture as of
    // its capture; any byte moves the pane past it, in every state, so the
    // next attach() captures afresh instead of replaying an older screen. A
    // single property write, allocation-free, so the [HOT-PATH] rule holds.
    this.lastSeed = null;

    // A live sink draws the byte (sink.write must be allocation-free per O3).
    // Detached, nobody will be handed the capture in flight with the byte
    // behind it, so it is marked stale rather than made to keep the pane's
    // output (an in-place write). Seeding, the capture's buffer takes it
    // (Array.push doesn't allocate unless the backing store grows; bounded by
    // seed time).
    if (this.currentState === "live") {
      // sink is non-null in 'live' by construction (attach assigns it
      // before transitioning). Trust the state machine.
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      this.sink!.write(data);
    } else if (this.currentState === "detached") {
      this.markSeedStale();
    } else if (this.seedCycle.phase === "capturing") {
      this.seedCycle.buffer.push(data);
    }

    // Schedule the activity-changed flush at most once per window.
    if (this.flushTimerId === null) {
      this.flushTimerId = setTimeout(
        this.boundFlushActivity,
        this.activityThrottleMs,
      );
    }
  }

  private flushActivity(): void {
    this.flushTimerId = null;
    if (this.currentState === "disposed") return;
    if (this.listeners["activity-changed"].size === 0) return;
    // [LAW:single-enforcer] One frozen snapshot per window — the only
    // allocation in the byte path, well under the 2MB/60s allocation budget.
    const snap: PaneActivity = Object.freeze({
      lastByteAt: this.currentLastByteAt,
      bytesSinceLastAttach: this.currentBytesSinceAttach,
    });
    for (const h of this.listeners["activity-changed"]) h(snap);
  }

  /**
   * Begin a new seed cycle: enter `capturing`, then issue the capture.
   *
   * [LAW:no-ambient-temporal-coupling] The cycle exists before `seed()` sends
   *   the RPC: a synchronous connection (the mock server, the chaos
   *   transport) announces the reply's `%begin` inside `execute()`, and only a
   *   capturing cycle records it. A fresh cycle is also what resets
   *   staleness — there is no separate flag to clear.
   *
   * [LAW:single-enforcer] The capture's start, here, and its resolution, in
   *   `seed()`, are the only `this.seedCycle` writes besides `markSeedStale`.
   */
  private startSeedCycle(): Promise<void> {
    const cycle: Capturing = {
      phase: "capturing",
      stale: false,
      buffer: [],
      begins: new Map(),
    };
    this.seedCycle = cycle;
    return this.seed(cycle);
  }

  /**
   * The pane moved past every picture of it this stream holds: drop the cache
   * and mark an in-flight capture stale. The triggers are a reconnect,
   * `%pause`, a recapture (`%continue`, a new size) and a byte while
   * detached. [LAW:single-enforcer]
   * The only place a capture is marked stale, and it always drops the cache
   * with it, so a stale capture never has a cache to fall back on. (A byte
   * behind an attached capture moves the pane past the cache but not the
   * capture — the capture's buffer holds it — so there the byte path drops
   * only the cache.)
   * [LAW:no-mode-explosion] Staleness is only meaningful mid-capture: a no-op
   * when `idle`.
   */
  private markSeedStale(): void {
    this.lastSeed = null;
    if (this.seedCycle.phase === "capturing") {
      this.seedCycle.stale = true;
    }
  }

  private async seed(cycle: Capturing): Promise<void> {
    // `cycle` starts non-stale. If the pane moves before the resolution
    // below, `markSeedStale` sets its `stale` and we drop the result.

    // Capture flags: -p stdout, -e SGR escapes, -q quiet (no error if the pane
    // is in copy/view mode), -N preserve trailing spaces. We deliberately do
    // NOT pass -J (join wrapped lines): -J collapses a wrapped line into one
    // output line, so the captured line count no longer equals the screen row
    // count — which breaks the row-exact seed normalization that the cursor
    // alignment depends on. The trade-off (seeded scrollback carries hard
    // breaks and won't reflow on a later resize) is cosmetic and confined to
    // history; live output after the seed is unaffected.
    const captureCmd =
      this.historyLines > 0
        ? `capture-pane -peqN -S -${this.historyLines} -t %${this.paneId}`
        : `capture-pane -peqN -t %${this.paneId}`;
    // Cursor position, the terminal modes the captured grid content cannot
    // carry (alt screen, autowrap, cursor visibility, application cursor/keypad,
    // insert) and the scroll region, plus pane_height + history_size which
    // size the row-exact normalization below, and pane_width, which with
    // pane_height is the size the capture was taken at. capture-pane -e emits only SGR colour/attrs, never
    // DEC private modes — so a TUI pane (vim/less) would seed with the wrong
    // input modes unless we restore them explicitly.
    const stateCmd = `display-message -p -t %${this.paneId} '#{cursor_x};#{cursor_y};#{alternate_on};#{cursor_flag};#{insert_flag};#{keypad_cursor_flag};#{keypad_flag};#{wrap_flag};#{pane_height};#{history_size};#{scroll_region_upper};#{scroll_region_lower};#{pane_width}'`;

    // One command line: tmux runs both commands without parsing pane bytes
    // in between, so the cursor and modes describe the captured grid. Its
    // output is the capture's lines, then the state line; its number is the
    // capture's, whose `%begin` says which buffered bytes the snapshot holds.
    let outcome: Outcome<CommandResponse>;
    try {
      const value = await this.client.execute(`${captureCmd} ; ${stateCmd}`);
      outcome = { ok: true, value };
    } catch (error) {
      outcome = { ok: false, error };
    }
    // [LAW:stale-rejection-guard-identity] This capture is no longer in flight;
    // it idles the field only while the field is still its own, so a resolution
    // never ends a capture issued after it.
    if (this.seedCycle === cycle) this.seedCycle = { phase: "idle" };

    // Re-check liveness after the await; consumer may have disposed in the
    // meantime.
    if (this.currentState === "disposed") return;
    // Every failed capture reports, even one dropped below: a failure is true
    // of the pane whether or not this capture is used.
    const reply = this.readCapture(cycle, outcome);

    // A capture taken while tmux has the pane paused misses what tmux dropped:
    // drop it and stay seeding. `%continue` reseeds.
    if (this.paused) return;

    // Stale mid-flight: the pane moved between RPC issue and now (see
    // `markSeedStale`), so the snapshot is not the current pane state. Drop
    // it. If anyone is still attached, kick off a fresh seed — through
    // `startSeedCycle` so `this.seedCycle` follows the new cycle.
    if (cycle.stale) {
      // No `lastSeed === null` guard: `markSeedStale` drops the cache as it
      // marks the capture stale, so a stale in-flight
      // capture provably has no cache to fall back on. Guarding on it here
      // would be dead control-flow whose only reachable-false behavior —
      // silently skipping the re-issue and leaving a stale screen — is
      // exactly the [LAW:no-silent-failure] trap to avoid; re-issuing when a
      // sink is still attached is the fail-safe direction regardless.
      // The stale cycle's bytes all precede the new capture, so the new
      // snapshot holds them; the new cycle buffers and cuts its own.
      if (this.sink !== null) void this.startSeedCycle();
      return;
    }

    // [LAW:single-enforcer] The whole seeding→live transition lives below.
    // No `await` from here to the state flip — nothing can push to the buffer
    // between reading it as `trailing` and handing it to the sink.
    //
    // The pure capture-grid reconstruction (flag→escape selection, blank-row
    // padding, Latin-1→bytes) lives in `buildSeed`; PaneStream owns only the
    // effects around it — the RPCs that produced these inputs, the cache, and
    // the sink handoff below.
    const picture =
      reply === null
        ? null
        : buildSeed(reply.output, reply.stateLine, this.historyLines);
    // The buffered bytes tmux wrote before the capture's `%begin` are in the
    // snapshot; `trailing` is the rest. A failed capture holds none of them.
    const trailing = cycle.buffer.slice(reply === null ? 0 : reply.begunAt);

    // Cache for the next attach() — a re-attach reuses this without a fresh
    // capture-pane round-trip. A failed capture is no picture, so it is never
    // cached and the next attach is the natural recovery point. Bytes behind
    // the capture already moved the pane past the snapshot, so only a capture
    // nothing followed is the current picture.
    this.lastSeed = trailing.length === 0 ? picture : null;
    // Before tmux's first report, the capture's size is the pane's: a pane
    // outside the control client's session is never reported, and any other
    // waits up to a second. [LAW:one-source-of-truth] A report, once there,
    // is not overwritten: a capture can catch a size tmux will not report
    // again (a zoom undone inside one check).
    this.size ??= picture?.size ?? null;
    // The seed seam just succeeded (past the stale-drop guard above), so any
    // outstanding seed failure is moot — clear it so lastError stops
    // reporting a recovered transient failure.
    if (picture !== null) this.clearError("seed");

    // If no sink is attached at resolution (e.g. detach() after the RPC was
    // issued), the cache above will serve the next attach() — no extra
    // capture-pane round-trip — unless bytes followed the capture.
    const liveSink = this.sink;
    if (liveSink === null) return;

    // Hand the snapshot and the bytes behind it over as one ordered value, at
    // the size the stream holds the pane at.
    fit(liveSink, this.size);
    if (picture !== null) {
      liveSink.seed(picture.captured, picture.cursor, trailing);
    } else {
      for (const chunk of trailing) liveSink.write(chunk);
    }
    this.setState("live");
  }

  /**
   * The capture's picture and where its `%begin` fell among the buffered
   * bytes, or null when there is none to seed with.
   *
   * A failed capture falls through to live mode WITHOUT a seed; better to
   * render live output than to wedge in 'seeding' forever. A failed capture is
   * no picture of the pane, so it is never handed over as one: the sink keeps
   * what it shows and the buffered bytes reach it as plain writes. Nothing is
   * cached, so the next attach, reconnect or pane change captures again; until
   * one comes, the sink shows what it had and `lastError` says why.
   *
   * [LAW:no-silent-failure] "Went live without a picture" is
   *   indistinguishable from "the pane is genuinely blank" — so the failure is
   *   lifted to the 'error' seam. `reportError` classifies connection-gone as
   *   quiet (the reconnect handler re-drives the seed); a live tmux failure
   *   (%error, corrupted terminator) or a connection that settled the reply
   *   ahead of its `%begin` surfaces.
   */
  private readCapture(
    cycle: Capturing,
    outcome: Outcome<CommandResponse>,
  ): CaptureReply | null {
    if (!outcome.ok) {
      this.reportError("seed", outcome.error);
      return null;
    }
    const { commandNumber, output } = outcome.value;
    const begunAt = cycle.begins.get(commandNumber);
    if (begunAt === undefined) {
      this.reportError(
        "seed",
        new Error(
          `capture of %${this.paneId} resolved before its %begin ` +
            `(command ${commandNumber}): the connection does not deliver ` +
            `a reply after the events tmux wrote before it`,
        ),
      );
      return null;
    }
    return {
      output: output.slice(0, -1),
      stateLine: output.at(-1) ?? "",
      begunAt,
    };
  }

  private handleSubscriptionChanged(
    ev: TmuxEventMap["subscription-changed"],
  ): void {
    if (ev.name !== this.subscriptionName) return;
    if (ev.paneId !== this.paneId) return;
    if (this.currentState === "disposed") return;
    const dims = parseDimensions(ev.value);
    if (dims === null) return;
    // The subscription just delivered a pane size, so the subscribe seam is
    // demonstrably working — clear any outstanding subscribe failure.
    this.clearError("subscribe");
    this.sink?.resize(dims.cols, dims.rows);
    // The pane's program redraws for the new size as soon as tmux resizes it,
    // up to a second before this value arrives, and those bytes reached the
    // sink at the old size. tmux's screen is right: take it again. Detached
    // too: a resize that prints nothing still leaves the cached picture at
    // the old size.
    const moved =
      this.size !== null &&
      (this.size.cols !== dims.cols || this.size.rows !== dims.rows);
    this.size = dims;
    if (moved) this.recapture();
  }

  private setState(next: PaneStreamState): void {
    if (this.currentState === next) return;
    this.currentState = next;
    for (const h of this.listeners["state-changed"]) h(next);
  }

  // [LAW:effects-at-boundaries] The pure interior kept computing (the stream
  //   still flips to live, bytes still flow); this is the edge REPORTING the
  //   effect's failure. Single enforcer for the 'error' seam: every seam
  //   failure routes through here, so classification lives in exactly one place.
  //
  // [LAW:no-silent-failure] Classify by error CLASS, never tmux English.
  //   Connection-gone is the one genuinely-moot case: the whole connection is
  //   tearing down and `reconnected` re-drives the seed / subscription, so
  //   surfacing a pane-level error would be noise. Everything else — tmux
  //   replied %error, or the guard terminator was corrupted, or an unexpected
  //   throw — means tmux was ALIVE and the blank pane is a real failure the
  //   consumer must be able to see. No String(err) fallthrough (the kwv.1
  //   lesson): `cause` is passed through untouched for the consumer to inspect.
  private reportError(phase: PaneStreamErrorPhase, cause: unknown): void {
    if (this.currentState === "disposed") return;
    if (isConnectionGone(cause)) return;
    const error: PaneStreamError = { phase, paneId: this.paneId, cause };
    // Delete-then-set so a re-reported phase moves to the end of the Map's
    // insertion order — keeps `lastError` recency-correct across both seams.
    this.seamErrors.delete(phase);
    this.seamErrors.set(phase, error);
    for (const h of this.listeners.error) h(error);
  }

  // [LAW:one-source-of-truth] `lastError` claims "an outstanding failure at this
  //   seam." That claim is superseded the moment the SAME seam demonstrates
  //   success — a recovered seed for the "seed" phase, a delivered pane size for
  //   the "subscribe" phase. Clearing then (and only then) keeps the pull-model
  //   value honest instead of stranding a stale error after recovery. Phase-
  //   gated so a seed success never wipes an outstanding subscribe failure, and
  //   vice versa. (Reconnect is NOT a clear point: it re-issues the seed and
  //   the subscription, but only a delivered size vouches for the latter.)
  private clearError(phase: PaneStreamErrorPhase): void {
    this.seamErrors.delete(phase);
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function parseDimensions(value: string): Grid | null {
  const [width, height, ...rest] = value.split(";");
  return rest.length === 0 ? parseGrid(width, height) : null;
}

// Size `sink` to `grid`, when the stream knows one.
function fit(sink: TerminalSink, grid: Grid | null): void {
  if (grid !== null) sink.resize(grid.cols, grid.rows);
}
