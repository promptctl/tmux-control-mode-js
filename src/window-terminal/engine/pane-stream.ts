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

import type { TerminalSink } from "./terminal-sink.js";
import { buildSeed, type Seed } from "./seed-builder.js";
import { uniqueToken } from "./token.js";
import { rethrowUnlessUnsubscribed } from "./teardown.js";
// [LAW:one-way-deps] The window-terminal engine runs in the browser; it imports
// the pure pane-output core from `browser.ts`, never the root entry `index.ts`
// (which pulls the Node-only transport and breaks browser bundlers).
import type {
  BytesSink,
  ClientSizeSurface,
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
 * whose failure would otherwise render as a permanently blank pane:
 *
 * - `"subscribe"` — the per-pane size subscription (`refresh-client -B`) issued
 *   at construction. Without it tmux never reports pane geometry, so the sink
 *   never receives a `resize()` and (for a defer-until-resize renderer like
 *   `XtermSink`) buffers every byte behind a first-resize that never comes.
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
 * - `capturing` — a capture is in flight. `stale` records whether reconnect or
 *   a detached-mode byte has invalidated the snapshot it is fetching; when set,
 *   `seed()` drops the result on resolution (and re-issues if anyone is still
 *   attached).
 *
 * [LAW:types-are-the-program] Formerly two fields — a `Promise|null` read as a
 *   boolean and a free-floating `stale` boolean — whose fourth combination
 *   (`idle` + `stale`) was representable but meaningless (nothing in flight to
 *   invalidate). Folding `stale` INTO the `capturing` variant makes that state
 *   unrepresentable: staleness exists exactly where the domain permits it, on an
 *   in-flight capture and nowhere else. [LAW:one-source-of-truth]
 *
 * `stale` is a mutable field (not a third `capturing-stale` tag) on purpose:
 *   the detached-byte path marks staleness per byte and is a [HOT-PATH] that
 *   must not allocate — an in-place `stale = true` write is allocation-free,
 *   whereas swapping to a new variant object per byte is not. `markSeedStale`
 *   is the single owner of that write.
 *
 * `run` is the cycle's own promise, carried so the single-flight guard
 * (`phase !== "idle"`) and the resolution `.finally` share one identity token:
 * the `.finally` resets to `idle` only if `run` still points at *its* cycle, so
 * a stale re-issue that already replaced the field is not clobbered.
 * [LAW:stale-rejection-guard-identity]
 *
 * Distinct, orthogonal axes deliberately kept separate: `lastSeed` (the cached
 * picture a re-attach replays) and `ReseedScheduler.currentRun` (the
 * cross-stream sweep guard, one per client). Neither is a capture *phase*.
 */
type SeedCycle =
  | { readonly phase: "idle" }
  | {
      readonly phase: "capturing";
      readonly run: Promise<void>;
      stale: boolean;
    };

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
  // Buffer for live bytes that arrive during seeding. Handed to the sink as the
  // seed's `trailing` argument when the capture resolves, so the snapshot and
  // the bytes captured behind it cross the seam as one ordered value.
  private buffer: Uint8Array[] = [];
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
  // live in `startSeedCycle` (start / resolution) and `markSeedStale`.
  private seedCycle: SeedCycle = { phase: "idle" };
  // tmux paused this pane's output (`%pause`) and drops what it writes until
  // `%continue`, so no capture taken in between is the whole picture.
  private paused = false;
  // The pane's size as tmux last reported it, null before the first report.
  private size: { cols: number; rows: number } | null = null;

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
      this.buffer = [];
      this.setState("seeding");
    };
    this.onContinue = (ev) => {
      if (ev.paneId !== this.paneId) return;
      this.paused = false;
      this.recapture();
    };
    this.client.on("pause", this.onPause);
    this.client.on("continue", this.onContinue);

    // [LAW:one-source-of-truth] Per-client reseed scheduler. Registering at
    // construction means the scheduler can include this stream in its very
    // first reconnect dispatch — even if the consumer hasn't called
    // attach() yet (priority() will tag it 'detached', so dispatch skips it).
    getScheduler(this.client).register(this);
  }

  // Per-pane width;height in one subscription (single message,
  // semicolon-separated) so tmux performs the layout walk for us.
  // [LAW:no-silent-failure] A failed subscribe means tmux will never report
  //   this pane's geometry, so the sink never gets a resize() — for a
  //   defer-until-resize renderer that is a permanently blank, unboundedly
  //   buffering pane. `reportError` lifts the failure to the 'error' seam
  //   (classifying connection-gone as the quiet, reconnect-re-driven case).
  //   The memory bound on the no-resize path is the sink's own concern
  //   (XtermSink caps its pre-resize buffer), independent of WHY resize is
  //   late — [LAW:decomposition].
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
   * - **First attach** (no cached seed) — issues capture-pane + cursor query,
   *   buffers any live bytes that arrive in the meantime, and synchronously
   *   seeds + drains the buffer once both responses resolve. State path:
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
    // tmux reports the size only when it changes, so a sink attaching after
    // the report is handed the size the stream already knows.
    if (this.size !== null) sink.resize(this.size.cols, this.size.rows);

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
   * to arrive at the output handler but only update the activity counter.
   * Re-attaching is allowed and re-seeds.
   */
  detach(): void {
    if (this.currentState === "disposed") return;
    if (this.sink === null && this.currentState === "detached") return;
    this.sink = null;
    // Bytes buffered behind an in-flight capture are dropped here, exactly as
    // a byte arriving while detached is — so, like that byte, they leave the
    // capture short of the picture and mark it stale. With nothing buffered
    // (StrictMode's mount→cleanup→mount) the capture still serves the
    // re-attach: one capture.
    if (this.buffer.length > 0) this.markSeedStale();
    this.buffer = [];
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
    // Any failure but an already-absent subscription has nobody left to
    // report to here, so it surfaces as an unhandled rejection.
    void this.client
      .unsubscribe(this.subscriptionName)
      .catch(rethrowUnlessUnsubscribed);

    if (this.flushTimerId !== null) {
      clearTimeout(this.flushTimerId);
      this.flushTimerId = null;
    }
    this.buffer = [];
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

    // State-driven dispatch:
    //   live:     forward to sink (sink.write must be allocation-free per O3).
    //   seeding:  push into the seed buffer (Array.push doesn't allocate
    //             unless the backing store grows; bounded by seed time).
    //   idle:     only the activity counter and cache clear above.
    //   detached: also mark any in-flight capture stale (below).
    if (this.currentState === "live") {
      // sink is non-null in 'live' by construction (attach assigns it
      // before transitioning). Trust the state machine.
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      this.sink!.write(data);
    } else if (this.currentState === "seeding") {
      this.buffer.push(data);
    } else if (this.currentState === "detached") {
      // If a capture-pane is in flight, its snapshot is now older than the
      // bytes that just arrived — the result must not become the cache.
      // Allocation-free (in-place `stale` write, or a no-op when idle), so the
      // [HOT-PATH] rule holds.
      this.markSeedStale();
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
   * Begin a new seed cycle. Owns every write to `this.pendingSeed`; the
   * inner `seed()` body never touches the field.
   *
   * Bookkeeping order: invoke `seed()` (which, as an async function, runs
   * its body synchronously until the first `await` and then yields a
   * promise), assign the returned promise to `this.pendingSeed`, attach a
   * `.finally` that clears the field iff it still points at *this* cycle.
   * That last clause matters because the body may chain a stale-re-issue
   * (`if (seedStaleMidFlight) startSeedCycle()`), in which case the new
   * cycle's promise has already replaced ours and our `.finally` must
   * leave it alone.
   *
   * Why the wrapper exists: an earlier version assigned the in-flight field
   * from inside `seed()` itself. When `execute()` threw synchronously the
   * body ran fully sync — and the outer caller's assignment then overwrote the
   * body's reset, leaving the field pointing at a resolved promise forever.
   * Lifting the assignment out of the async body fixes the race.
   *
   * Entering `capturing` here (not stale) is also what resets staleness for the
   * new cycle — there is no separate flag to clear.
   *
   * [LAW:single-enforcer] Every `this.seedCycle` write for start/resolution
   *   lives here; the only other writer is `markSeedStale`.
   */
  private startSeedCycle(): Promise<void> {
    const p = this.seed();
    this.seedCycle = { phase: "capturing", run: p, stale: false };
    void p.finally(() => {
      // [LAW:stale-rejection-guard-identity] Reset to idle only if the field
      // still points at THIS cycle's run. A stale re-issue replaces it with a
      // new run before our `.finally` fires; that new cycle owns the field.
      if (this.seedCycle.phase === "capturing" && this.seedCycle.run === p) {
        this.seedCycle = { phase: "idle" };
      }
    });
    return p;
  }

  /**
   * The pane moved past every picture of it this stream holds: drop the cache
   * and mark an in-flight capture stale. The triggers are a reconnect,
   * `%pause`, a recapture (`%continue`, a new size), a byte while detached,
   * and a detach that drops buffered bytes. [LAW:single-enforcer] The only
   * place a capture is marked stale, and it always drops the cache with it, so
   * a stale capture never has a cache to fall back on. (A byte buffered behind
   * an attached capture moves the pane past the cache but not the capture, so
   * the byte path drops only the cache.)
   * [LAW:no-mode-explosion] Staleness is only meaningful mid-capture: a no-op
   * when `idle`. In-place field writes, so the detached-byte [HOT-PATH] stays
   * allocation-free.
   */
  private markSeedStale(): void {
    this.lastSeed = null;
    if (this.seedCycle.phase === "capturing") {
      this.seedCycle.stale = true;
    }
  }

  private async seed(): Promise<void> {
    // This cycle starts non-stale: `startSeedCycle` enters `capturing` (with
    // `stale: false`) around this call. If the pane moves before the
    // resolution below, `markSeedStale` sets the in-flight cycle's `stale` and
    // we drop the result.

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
    // insert), plus pane_height + history_size which size the row-exact
    // normalization below. capture-pane -e emits only SGR colour/attrs, never
    // DEC private modes — so a TUI pane (vim/less) would seed with the wrong
    // input modes unless we restore them explicitly.
    const stateCmd = `display-message -p -t %${this.paneId} '#{cursor_x};#{cursor_y};#{alternate_on};#{cursor_flag};#{insert_flag};#{keypad_cursor_flag};#{keypad_flag};#{wrap_flag};#{pane_height};#{history_size}'`;

    let reply: { output: readonly string[]; stateLine: string } | null = null;
    try {
      const [captureResp, stateResp] = await Promise.all([
        this.client.execute(captureCmd),
        this.client.execute(stateCmd),
      ]);
      reply = {
        output: captureResp.output,
        stateLine: stateResp.output[0] ?? "",
      };
    } catch (err) {
      // Capture failed. Fall through to live mode WITHOUT a seed; better to
      // render live output than to wedge in 'seeding' forever. A failed
      // capture is no picture of the pane, so it is never handed over as one:
      // the sink keeps what it shows and the trailing bytes reach it as plain
      // writes. Nothing is cached, so the next attach, reconnect or pane
      // change captures again; until one comes, the sink shows what it had
      // and `lastError` says why.
      //
      // [LAW:no-silent-failure] But "went live without a picture" is
      //   indistinguishable from "the pane is genuinely blank" — so lift the
      //   failure to the 'error' seam. `reportError` classifies connection-gone
      //   as quiet (the reconnect handler re-drives the seed); a live tmux
      //   failure (%error, corrupted terminator) surfaces.
      this.reportError("seed", err);
    }

    // Re-check liveness after the await; consumer may have disposed in the
    // meantime.
    if (this.currentState === "disposed") return;

    // A capture taken while tmux has the pane paused misses what tmux dropped:
    // drop it and stay seeding. `%continue` reseeds.
    if (this.paused) return;

    // Stale mid-flight: the pane moved between RPC issue and now (see
    // `markSeedStale`), so the snapshot is not the current pane state. Drop
    // it. If anyone is still attached, kick off a fresh seed — through
    // `startSeedCycle` so `this.seedCycle` follows the new cycle.
    if (this.seedCycle.phase === "capturing" && this.seedCycle.stale) {
      // No `lastSeed === null` guard: `markSeedStale` drops the cache as it
      // marks the capture stale, so a stale in-flight
      // capture provably has no cache to fall back on. Guarding on it here
      // would be dead control-flow whose only reachable-false behavior —
      // silently skipping the re-issue and leaving a stale screen — is
      // exactly the [LAW:no-silent-failure] trap to avoid; re-issuing when a
      // sink is still attached is the fail-safe direction regardless.
      if (this.sink !== null) {
        // [LAW:one-source-of-truth] Clear the buffer before issuing the new
        // capture-pane. Bytes buffered during the stale seeding window arrived
        // before the new capture is issued and will be included in the new
        // snapshot — draining them after would duplicate. seed() issues the
        // RPC synchronously before its first await, so bytes arriving after
        // this clear are correctly post-capture and belong in the buffer.
        this.buffer = [];
        void this.startSeedCycle();
      }
      return;
    }

    // [LAW:single-enforcer] The whole seeding→live transition lives below.
    // No `await` from here to the state flip — nothing can mutate `this.buffer`
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

    // Cache for the next attach() — a re-attach reuses this without a fresh
    // capture-pane round-trip. A failed capture is no picture, so it is never
    // cached and the next attach is the natural recovery point. Bytes
    // buffered behind the capture already moved the pane past the snapshot,
    // so only a capture nothing followed is the current picture.
    this.lastSeed = this.buffer.length === 0 ? picture : null;
    // The seed seam just succeeded (past the stale-drop guard above), so any
    // outstanding seed failure is moot — clear it so lastError stops
    // reporting a recovered transient failure.
    if (picture !== null) this.clearError("seed");

    // If no sink is attached at resolution (e.g. detach() after the RPC was
    // issued), the cache above will serve the next attach() — no extra
    // capture-pane round-trip. The buffer is empty in that case because
    // detach() drains it.
    const liveSink = this.sink;
    if (liveSink === null) return;

    // Hand the snapshot and the bytes captured behind it over as one ordered
    // value. Clear the buffer AFTER the handoff, not before: a sink consumes
    // `trailing` synchronously and never retains the array, so aliasing is safe
    // for the duration of the call, and reassigning to a fresh array afterward
    // means PaneStream never mutates the handed-off array in place. Clearing
    // after also matches the pre-SD2 failure path — if the sink throws, the
    // buffered bytes survive in `this.buffer` rather than being dropped.
    if (picture !== null) {
      liveSink.seed(picture.captured, picture.cursor, this.buffer);
    } else {
      for (const chunk of this.buffer) liveSink.write(chunk);
    }
    this.buffer = [];
    this.setState("live");
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

function parseDimensions(value: string): { cols: number; rows: number } | null {
  const m = value.match(/^(\d+);(\d+)$/);
  if (m === null) return null;
  const cols = Number(m[1]);
  const rows = Number(m[2]);
  if (cols <= 0 || rows <= 0) return null;
  return { cols, rows };
}
