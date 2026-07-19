// packages/pane-terminal/src/stream/pane-stream.ts
//
// `PaneStream` — environment-agnostic pane data carrier. Owns the
// idle→seeding→live↔detached→disposed state machine for a single tmux pane,
// dispatches live byte chunks to an attached `TerminalSink`, and maintains a
// detached-mode activity counter (lastByteAt + bytesSinceLastAttach) coalesced
// to a single timer per stream.
//
// No DOM. No xterm. No React. Sinks come in over the seam declared in
// ../sink/index.ts; the renderer is the consumer's choice (BufferingSink for
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

import type { TerminalSink } from "../sink/index.js";
import { buildSeed, type Seed } from "./seed-builder.js";
// [LAW:one-way-deps] pane-terminal is a browser-rendering package; it imports
// the pure pane-output core from the `/browser` subpath, never the root entry
// (which pulls the Node-only transport and breaks browser bundlers).
import type {
  BytesSink,
  TmuxConnection,
  TmuxEventMap,
} from "@promptctl/tmux-control-mode-js/browser";
import {
  paneScope,
  subscribeRaw,
  unsubscribe,
  isConnectionGone,
} from "@promptctl/tmux-control-mode-js/browser";
import {
  sendKeys as encodeSendKeys,
  emptyKeysResponse,
  type CommandResponse,
} from "@promptctl/tmux-control-mode-js/protocol";

// Re-exported so `@promptctl/pane-terminal/stream` consumers don't have to
// dual-import `TmuxConnection` from the library separately.
export type { TmuxConnection };
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
  readonly client: TmuxConnection;
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

type EventName = "state-changed" | "activity-changed" | "reconnected" | "error";

// `reconnected` listeners take no payload. We model them with `[]` instead
// of `void` so the listener type stays a plain function with zero params,
// dodging `@typescript-eslint/no-invalid-void-type` while keeping the
// per-event payload type checked.
type EventPayload<E extends EventName> = E extends "state-changed"
  ? [PaneStreamState]
  : E extends "activity-changed"
    ? [PaneActivity]
    : E extends "error"
      ? [PaneStreamError]
      : [];

type Listener<E extends EventName> = (...args: EventPayload<E>) => void;

type Unsubscribe = () => void;

// ---------------------------------------------------------------------------
// PaneStream
// ---------------------------------------------------------------------------

export class PaneStream implements ReseedTarget {
  readonly paneId: number;

  private readonly client: TmuxConnection;
  private readonly historyLines: number;
  private readonly activityThrottleMs: number;
  private readonly subscriptionName: string;

  private currentState: PaneStreamState = "idle";
  private sink: TerminalSink | null = null;
  // Buffer for live bytes that arrive during seeding. Handed to the sink as the
  // seed's `trailing` argument when the capture resolves, so the snapshot and
  // the bytes captured behind it cross the seam as one ordered value.
  private buffer: Uint8Array[] = [];
  // Last successful seed payload — kept so subsequent re-attaches can hand
  // the new sink the same starting picture WITHOUT a fresh capture-pane
  // round-trip (re-mount churn on one stream → exactly one capture). Set inside
  // seed(); cleared by reconnect (the underlying pane state has moved).
  private lastSeed: Seed | null = null;
  // [LAW:single-enforcer] One in-flight capture-pane RPC per stream at a
  // time. attach() short-circuits when this is non-null (the resolution
  // will pick up `this.sink` whatever it is then). Required under
  // React StrictMode, where mount→cleanup→mount happens synchronously
  // *inside* one rendered frame — both attaches land before the first
  // capture-pane resolves.
  private pendingSeed: Promise<void> | null = null;
  // Flips true when reconnect or a byte-during-detached event invalidates
  // the snapshot the in-flight capture-pane is fetching. Checked at the end
  // of seed(); when set, the result is dropped (no cache, no seed) and a
  // fresh capture is issued if anyone is still attached. Reset to false at
  // the start of every seed() call.
  private seedStaleMidFlight = false;

  // Activity accounting. Updated synchronously on every byte event.
  // The flush emits a frozen snapshot at most every `activityThrottleMs`.
  private currentLastByteAt = 0;
  private currentBytesSinceAttach = 0;
  private flushTimerId: unknown = null;

  // Listener registries. Per-event Sets so add/remove is O(1).
  private readonly stateListeners = new Set<Listener<"state-changed">>();
  private readonly activityListeners = new Set<Listener<"activity-changed">>();
  private readonly reconnectedListeners = new Set<Listener<"reconnected">>();
  private readonly errorListeners = new Set<Listener<"error">>();

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
    this.subscriptionName = `pane-terminal-size-${opts.paneId}`;

    this.onReconnected = () => {
      // The cached seed is now stale — the underlying pane state has
      // moved while we were disconnected. Drop it so the ReseedScheduler's
      // upcoming reseed() (or the next attach()) issues a fresh capture-pane.
      this.lastSeed = null;
      // Any in-flight capture-pane is now fetching pre-reconnect data —
      // mark it stale so seed() drops the result on resolution.
      this.seedStaleMidFlight = true;
      // ReseedScheduler owns dispatch; we just notify our own listeners
      // so consumers (e.g. status badges) can react.
      for (const h of this.reconnectedListeners) h();
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

    // [LAW:dataflow-not-control-flow] subscribeRaw/unsubscribe are free
    // functions over TmuxConnection; the subscription path always runs.
    this.onSubscriptionChanged = (ev) => this.handleSubscriptionChanged(ev);
    this.client.on("subscription-changed", this.onSubscriptionChanged);
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
    void subscribeRaw(
      this.client,
      this.subscriptionName,
      `%${this.paneId}`,
      "#{pane_width};#{pane_height}",
    ).catch((err: unknown) => this.reportError("subscribe", err));

    // [LAW:one-source-of-truth] Per-client reseed scheduler. Registering at
    // construction means the scheduler can include this stream in its very
    // first reconnect dispatch — even if the consumer hasn't called
    // attach() yet (priority() will tag it 'detached', so dispatch skips it).
    getScheduler(this.client).register(this);
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
   *   tmux load. The cached seed is invalidated on `reconnected`, where the
   *   `ReseedScheduler` re-issues capture-pane in priority order.
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

    if (this.lastSeed !== null) {
      // Re-attach fast path. Synchronous: hand the new sink the cached
      // payload and flip straight to live. No capture-pane is issued, and no
      // live bytes are pending (detach() drained the buffer), so `trailing` is
      // empty — the cached snapshot is the whole picture.
      sink.seed(this.lastSeed.captured, this.lastSeed.cursor, []);
      this.setState("live");
      return;
    }

    if (this.pendingSeed !== null) {
      // A capture-pane is already in flight from a previous attach (e.g.
      // React StrictMode's mount→cleanup→remount happens before the first
      // RPC resolves). Don't issue a second capture — when the in-flight
      // one resolves, it will read `this.sink` and seed it. The exactly-one-
      // capture guarantee under StrictMode depends on this short-circuit.
      this.setState("seeding");
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
    this.buffer = [];
    this.setState("detached");
  }

  /**
   * Send keystrokes to the underlying pane via tmux `send-keys`.
   * Convenience wrapper so consumers don't need to format pane targets.
   */
  sendKeys(data: string): Promise<CommandResponse> {
    // [LAW:one-source-of-truth] The send-keys wire format AND its empty-input
    // precondition live in the library encoder (send -H hex bytes). This mirrors
    // the canonical `commands.sendKeys`: encodeSendKeys returns null for empty
    // input (no command — synthesize the no-op response) or the bare wire line
    // (NO trailing LF — execute() is the sole enforcer of LF-termination). Pass
    // the wire straight through; execute() appends the single LF. (A prior
    // version sliced the last char to "strip the encoder's trailing LF" — but
    // the encoder never emits one, so the slice dropped the last hex DIGIT,
    // corrupting every keystroke's final byte into a stray control code.)
    const wire = encodeSendKeys(`%${this.paneId}`, data);
    return wire === null
      ? Promise.resolve(emptyKeysResponse())
      : this.client.execute(wire);
  }

  on<E extends EventName>(event: E, handler: Listener<E>): Unsubscribe {
    const set = this.listenerSet(event);
    set.add(handler as never);
    return () => {
      set.delete(handler as never);
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
    // Best-effort unsubscribe — if the client is already closed, this
    // rejects; we swallow because dispose() must not throw.
    void unsubscribe(this.client, this.subscriptionName).catch(() => undefined);

    if (this.flushTimerId !== null) {
      clearTimeout(this.flushTimerId);
      this.flushTimerId = null;
    }
    this.buffer = [];
    this.sink = null;
    this.stateListeners.clear();
    this.activityListeners.clear();
    this.reconnectedListeners.clear();
    this.errorListeners.clear();
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
    // is already running (the reconnect handler set seedStaleMidFlight, so
    // it'll auto-re-issue on resolution), there's nothing for reseed() to do.
    if (this.pendingSeed !== null) return;
    // Re-enter seeding so any byte arriving during the new capture is
    // buffered, not interleaved with the previous live frame.
    this.setState("seeding");
    await this.startSeedCycle();
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

    // State-driven dispatch:
    //   live:     forward to sink (sink.write must be allocation-free per O3).
    //   seeding:  push into the seed buffer (Array.push doesn't allocate
    //             unless the backing store grows; bounded by seed time).
    //   idle:     only the activity counter is updated above (no cached seed
    //             yet, so nothing to invalidate).
    //   detached: counter, plus null out lastSeed so the next attach() takes
    //             the slow path (capture-pane). Without this, a re-attach
    //             would paint a stale screen and silently miss the bytes
    //             that arrived during detach. Cheap (single property write
    //             to null) and allocation-free, so the [HOT-PATH] rule
    //             still holds.
    if (this.currentState === "live") {
      // sink is non-null in 'live' by construction (attach assigns it
      // before transitioning). Trust the state machine.
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      this.sink!.write(data);
    } else if (this.currentState === "seeding") {
      this.buffer.push(data);
    } else if (this.currentState === "detached") {
      this.lastSeed = null;
      // If a capture-pane is in flight, its snapshot is now older than the
      // bytes that just arrived — the result must not become the cache.
      this.seedStaleMidFlight = true;
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
    if (this.activityListeners.size === 0) return;
    // [LAW:single-enforcer] One frozen snapshot per window — the only
    // allocation in the byte path, well under the 2MB/60s allocation budget.
    const snap: PaneActivity = Object.freeze({
      lastByteAt: this.currentLastByteAt,
      bytesSinceLastAttach: this.currentBytesSinceAttach,
    });
    for (const h of this.activityListeners) h(snap);
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
   * Why the wrapper exists: an earlier version assigned `pendingSeed`
   * from inside `seed()` itself. When `execute()` threw synchronously the
   * body ran fully sync — and the outer caller's assignment then
   * overwrote the body's `null`, leaving `pendingSeed` pointing at a
   * resolved promise forever. Lifting the assignment out of the async
   * body fixes the race.
   *
   * [LAW:single-enforcer] All `this.pendingSeed` writes live here.
   */
  private startSeedCycle(): Promise<void> {
    const p = this.seed();
    this.pendingSeed = p;
    void p.finally(() => {
      if (this.pendingSeed === p) this.pendingSeed = null;
    });
    return p;
  }

  private async seed(): Promise<void> {
    // Reset the staleness flag at the start of each seed cycle. If reconnect
    // or a detached-mode byte arrives between here and the resolution below,
    // these handlers flip the flag back to true and we drop the result.
    this.seedStaleMidFlight = false;

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

    let captureOutput: readonly string[] = [];
    let stateLine = "";
    let captureSucceeded = false;
    try {
      const [captureResp, stateResp] = await Promise.all([
        this.client.execute(captureCmd),
        this.client.execute(stateCmd),
      ]);
      captureOutput = captureResp.output;
      stateLine = stateResp.output[0] ?? "";
      captureSucceeded = true;
    } catch (err) {
      // Capture failed. Fall through to live mode with an empty seed; better
      // to render live output than to wedge in 'seeding' forever. Activity
      // events keep flowing. We deliberately do NOT cache this empty payload
      // below — a transient failure must not become "sticky" and prevent the
      // next attach / reseed from retrying (that retry is the recovery path).
      //
      // [LAW:no-silent-failure] But "went live with a blank seed" is
      //   indistinguishable from "the pane is genuinely blank" — so lift the
      //   failure to the 'error' seam. `reportError` classifies connection-gone
      //   as quiet (the reconnect handler re-drives the seed); a live tmux
      //   failure (%error, corrupted terminator) surfaces.
      this.reportError("seed", err);
    }

    // Re-check liveness after the await; consumer may have disposed in the
    // meantime.
    if (this.currentState === "disposed") return;

    // Stale mid-flight: a reconnect or a detached-mode byte arrived between
    // RPC issue and now, so the snapshot is older than the current pane
    // state. Drop it. If anyone is still attached, kick off a fresh seed —
    // through `startSeedCycle` so `this.pendingSeed` follows the new cycle.
    if (this.seedStaleMidFlight) {
      if (this.sink !== null && this.lastSeed === null) {
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
    const { captured, cursor } = buildSeed(
      captureOutput,
      stateLine,
      this.historyLines,
    );

    // Cache for the next attach() — a re-attach reuses this without a fresh
    // capture-pane round-trip. Only cached on success: a failed seed left
    // in the cache would let subsequent re-attaches paint a blank screen
    // forever, and the next attach is the natural recovery point.
    // Invalidated by the reconnect handler and by detached-mode bytes.
    if (captureSucceeded) {
      this.lastSeed = { captured, cursor };
      // The seed seam just succeeded (past the stale-drop guard above), so any
      // outstanding seed failure is moot — clear it so lastError stops
      // reporting a recovered transient failure.
      this.clearError("seed");
    }

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
    liveSink.seed(captured, cursor, this.buffer);
    this.buffer = [];
    this.setState("live");
  }

  private handleSubscriptionChanged(
    ev: TmuxEventMap["subscription-changed"],
  ): void {
    if (ev.name !== this.subscriptionName) return;
    if (ev.paneId !== this.paneId) return;
    if (this.currentState === "disposed") return;
    if (this.sink === null) return;
    const dims = parseDimensions(ev.value);
    if (dims === null) return;
    // The subscription just delivered a pane size, so the subscribe seam is
    // demonstrably working — clear any outstanding subscribe failure.
    this.clearError("subscribe");
    this.sink.resize(dims.cols, dims.rows);
  }

  private setState(next: PaneStreamState): void {
    if (this.currentState === next) return;
    this.currentState = next;
    for (const h of this.stateListeners) h(next);
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
    for (const h of this.errorListeners) h(error);
  }

  // [LAW:one-source-of-truth] `lastError` claims "an outstanding failure at this
  //   seam." That claim is superseded the moment the SAME seam demonstrates
  //   success — a recovered seed for the "seed" phase, a delivered pane size for
  //   the "subscribe" phase. Clearing then (and only then) keeps the pull-model
  //   value honest instead of stranding a stale error after recovery. Phase-
  //   gated so a seed success never wipes an outstanding subscribe failure, and
  //   vice versa. (Reconnect is NOT a clear point: it re-drives only the seed,
  //   not the subscription, so it cannot vouch for the subscribe seam.)
  private clearError(phase: PaneStreamErrorPhase): void {
    this.seamErrors.delete(phase);
  }

  private listenerSet<E extends EventName>(event: E): Set<Listener<E>> {
    if (event === "state-changed") {
      return this.stateListeners as unknown as Set<Listener<E>>;
    }
    if (event === "activity-changed") {
      return this.activityListeners as unknown as Set<Listener<E>>;
    }
    if (event === "error") {
      return this.errorListeners as unknown as Set<Listener<E>>;
    }
    return this.reconnectedListeners as unknown as Set<Listener<E>>;
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
