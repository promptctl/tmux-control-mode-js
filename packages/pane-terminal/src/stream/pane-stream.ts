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
// [LAW:dataflow-not-control-flow] The output handler is registered ONCE in
//   the constructor (O2) and runs on every output event. The same operations
//   execute every byte; the value of `state` and the data's `paneId` decide
//   what happens. No subscribe/unsubscribe churn at attach time.
// [LAW:single-enforcer] One activity-flush timer per stream. The byte path
//   only sets a flag and calls setTimeout(boundFlush) when no flush is
//   pending — there is exactly one path that emits 'activity-changed'.
// [LAW:one-source-of-truth] State transitions live in `setState` only.
//   External views (`get state()`) read from `currentState` directly.

import type { TerminalSink, SeedCursor } from "../sink/index.js";
import type {
  TmuxClientLike,
  TmuxEventMap,
} from "@promptctl/tmux-control-mode-js";
import {
  sendKeys as encodeSendKeys,
  type CommandResponse,
} from "@promptctl/tmux-control-mode-js/protocol";

// Re-exported so `@promptctl/pane-terminal/stream` consumers don't have to
// dual-import `TmuxClientLike` from the library separately.
export type { TmuxClientLike };
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

// Per the design doc (O6), visibility is owned by the *sink* — the sink
// knows its own DOM container's IntersectionObserver / document.visibilityState
// state. PaneStream delegates to `sink.isVisible()` when computing reseed
// priority. There is no stream-side `Visibility` type or setter.

export interface PaneStreamOptions {
  readonly client: TmuxClientLike;
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

type EventName = "state-changed" | "activity-changed" | "reconnected";

// `reconnected` listeners take no payload. We model them with `[]` instead
// of `void` so the listener type stays a plain function with zero params,
// dodging `@typescript-eslint/no-invalid-void-type` while keeping the
// per-event payload type checked.
type EventPayload<E extends EventName> = E extends "state-changed"
  ? [PaneStreamState]
  : E extends "activity-changed"
    ? [PaneActivity]
    : [];

type Listener<E extends EventName> = (...args: EventPayload<E>) => void;

type Unsubscribe = () => void;

// ---------------------------------------------------------------------------
// PaneStream
// ---------------------------------------------------------------------------

export class PaneStream implements ReseedTarget {
  readonly paneId: number;

  private readonly client: TmuxClientLike;
  private readonly historyLines: number;
  private readonly activityThrottleMs: number;
  private readonly subscriptionName: string;

  private currentState: PaneStreamState = "idle";
  private sink: TerminalSink | null = null;
  // Buffer for live bytes that arrive during seeding. Drained synchronously
  // inside finishSeed() so no live byte interleaves the seed write.
  private buffer: Uint8Array[] = [];
  // Last successful seed payload — kept so subsequent re-attaches can hand
  // the new sink the same starting picture WITHOUT a fresh capture-pane
  // round-trip (gate #4: re-mount ×100 → exactly one capture). Set inside
  // seed(); cleared by reconnect (the underlying pane state has moved).
  private lastSeed: {
    captured: Uint8Array;
    cursor: SeedCursor | null;
  } | null = null;
  // [LAW:single-enforcer] One in-flight capture-pane RPC per stream at a
  // time. attach() short-circuits when this is non-null (the resolution
  // will pick up `this.sink` whatever it is then). Required by gate #4 under
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

  // Pre-bound handlers so the [HOT-PATH] byte callback never allocates a
  // closure per byte and so off() can find the same reference we used for on().
  private readonly onOutput: (ev: TmuxEventMap["output"]) => void;
  private readonly onExtendedOutput: (
    ev: TmuxEventMap["extended-output"],
  ) => void;
  private readonly onReconnected: (ev: TmuxEventMap["reconnected"]) => void;
  private readonly boundFlushActivity: () => void;
  private readonly onSubscriptionChanged: (
    ev: TmuxEventMap["subscription-changed"],
  ) => void;

  constructor(opts: PaneStreamOptions) {
    this.client = opts.client;
    this.paneId = opts.paneId;
    this.historyLines = opts.historyLines ?? 2000;
    this.activityThrottleMs = opts.activityThrottleMs ?? 100;
    this.subscriptionName = `pane-terminal-size-${opts.paneId}`;

    this.onOutput = (ev) => this.handlePaneOutput(ev.paneId, ev.data);
    this.onExtendedOutput = (ev) => this.handlePaneOutput(ev.paneId, ev.data);
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

    // O2: register byte handlers at construction. The same callback runs
    // every byte event for the lifetime of this stream; state value decides
    // what happens with each chunk.
    this.client.on("output", this.onOutput);
    this.client.on("extended-output", this.onExtendedOutput);
    this.client.on("reconnected", this.onReconnected);

    // [LAW:dataflow-not-control-flow] subscribeRaw/unsubscribe are mandatory
    // on TmuxClientLike, so the subscription path always runs. Earlier shapes
    // gated this on a runtime `typeof === "function"` probe; making the
    // capability part of the type erased the branch.
    this.onSubscriptionChanged = (ev) => this.handleSubscriptionChanged(ev);
    this.client.on("subscription-changed", this.onSubscriptionChanged);
    // Per-pane width;height in one subscription (single message,
    // semicolon-separated) so tmux performs the layout walk for us.
    // .catch keeps construction safe — if the client is already closed or
    // tmux rejects the subscribe, swallowing here matches the symmetrical
    // unsubscribe() in dispose(), which can't surface as a usable error.
    void this.client
      .subscribeRaw(
        this.subscriptionName,
        `%${this.paneId}`,
        "#{pane_width};#{pane_height}",
      )
      .catch(() => undefined);

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
   * Attach a sink.
   *
   * - **First attach** (no cached seed) — issues capture-pane + cursor query,
   *   buffers any live bytes that arrive in the meantime, and synchronously
   *   seeds + drains the buffer once both responses resolve. State path:
   *   `idle → seeding → live`.
   * - **Re-attach** (a prior attach already seeded successfully) — replays
   *   the cached seed to the new sink synchronously, no tmux round-trip.
   *   State path: `detached → live`. This is gate #4's contract: mount churn
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
      // payload and flip straight to live. No capture-pane is issued.
      sink.seed(this.lastSeed.captured, this.lastSeed.cursor);
      this.setState("live");
      return;
    }

    if (this.pendingSeed !== null) {
      // A capture-pane is already in flight from a previous attach (e.g.
      // React StrictMode's mount→cleanup→remount happens before the first
      // RPC resolves). Don't issue a second capture — when the in-flight
      // one resolves, it will read `this.sink` and seed it. Gate #4 under
      // StrictMode depends on this short-circuit.
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
    // [LAW:one-source-of-truth] The send-keys wire format lives in the library
    // encoder (send -H hex bytes), shared with TmuxClient.sendKeys. encodeSendKeys
    // returns a full wire line (trailing LF); execute() re-adds the LF via
    // buildCommand, so strip the encoder's trailing LF to avoid emitting a bare
    // empty line (which tmux treats as the detach signal).
    const wire = encodeSendKeys(`%${this.paneId}`, data);
    return this.client.execute(wire.slice(0, -1));
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

    this.client.off("output", this.onOutput);
    this.client.off("extended-output", this.onExtendedOutput);
    this.client.off("reconnected", this.onReconnected);

    this.client.off("subscription-changed", this.onSubscriptionChanged);
    // Best-effort unsubscribe — if the client is already closed, this
    // rejects; we swallow because dispose() must not throw.
    void this.client.unsubscribe(this.subscriptionName).catch(() => undefined);

    if (this.flushTimerId !== null) {
      clearTimeout(this.flushTimerId);
      this.flushTimerId = null;
    }
    this.buffer = [];
    this.sink = null;
    this.stateListeners.clear();
    this.activityListeners.clear();
    this.reconnectedListeners.clear();
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
  // Branching on values (paneId, currentState) is fine — the rule forbids
  // allocation expressions, not conditionals.
  private handlePaneOutput(paneId: number, data: Uint8Array): void {
    if (paneId !== this.paneId) return;
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
    // allocation in the byte path, well under Gate 3's 2MB/60s budget.
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
    // count — which breaks the row-exact normalization below that the cursor
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
    } catch {
      // Capture failed (e.g. connection closed). Fall through to live mode
      // with an empty seed; better to render nothing than to wedge in
      // 'seeding' forever. Activity events keep flowing. We deliberately
      // do NOT cache this empty payload below — a transient failure must
      // not become "sticky" and prevent the next attach from retrying.
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
    // No `await` from here to the state flip — no live byte can interleave.
    const { cursor, height, historySize, preamble, epilogue } =
      parseSeedState(stateLine);

    // [LAW:dataflow-not-control-flow] The cursor lands correctly by making the
    // seed the exact shape tmux's grid has — not by adjusting the CUP. The sink
    // writes the seed, then a viewport-relative CUP. xterm anchors its viewport
    // to the bottom of the buffer, so the viewport's top aligns with tmux's
    // visible-screen top ONLY when the seed ends with exactly `pane_height`
    // rows. capture-pane (no -J) emits one line per screen row plus a trailing
    // \n after the last row, which the parser turns into a spurious "" tail.
    // But tmux also elides trailing blank rows ambiguously: a genuine blank
    // bottom row is indistinguishable from that artifact. Stripping one "" can
    // therefore drop a real blank row, leaving the seed a row short — then the
    // bottom-anchored viewport pulls a scrollback row up into view and the
    // cursor renders one row above its true position.
    //
    // Fix: strip the single trailing artifact, then PAD trailing blank rows
    // back up to the true grid height — `min(historyLines, history_size)`
    // history rows plus `pane_height` visible rows. The visible screen is then
    // exactly `pane_height` rows by construction and the CUP is correct.
    const stripped =
      captureOutput.length > 0 && captureOutput[captureOutput.length - 1] === ""
        ? captureOutput.slice(0, -1)
        : captureOutput.slice();
    const historyRows = Number.isFinite(historySize)
      ? Math.min(this.historyLines, historySize)
      : 0;
    const targetRows = Number.isFinite(height) ? historyRows + height : 0;
    const lines =
      stripped.length < targetRows
        ? stripped.concat(new Array(targetRows - stripped.length).fill(""))
        : stripped;
    const screen = lines.join("\r\n");
    // Restore terminal modes around the screen content: alt-screen + wrap
    // before drawing (they affect layout), input/cursor modes after. The CUP
    // the sink appends from `cursor` lands last, so it reflects the final
    // restored state.
    //
    // The capture text arrives as Latin-1 (one code unit per raw byte — see the
    // transport). Convert back to the exact byte sequence so the sink receives
    // RAW BYTES, identical in kind to the live `write()` path; the renderer is
    // the single decoding authority. We never UTF-8-decode terminal data. The
    // mode escapes are ASCII, so they encode 1:1.
    const captured = latin1ToBytes(preamble + screen + epilogue);

    // Cache for the next attach() — gate #4 reuses this without a fresh
    // capture-pane round-trip. Only cached on success: a failed seed left
    // in the cache would let subsequent re-attaches paint a blank screen
    // forever, and the next attach is the natural recovery point.
    // Invalidated by the reconnect handler and by detached-mode bytes.
    if (captureSucceeded) {
      this.lastSeed = { captured, cursor };
    }

    // If no sink is attached at resolution (e.g. detach() after the RPC was
    // issued), the cache above will serve the next attach() — no extra
    // capture-pane round-trip. The buffer is empty in that case because
    // detach() drains it.
    const liveSink = this.sink;
    if (liveSink === null) return;

    liveSink.seed(captured, cursor);

    // Drain buffered live bytes synchronously, then flip state.
    for (const bytes of this.buffer) {
      liveSink.write(bytes);
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
    if (this.sink === null) return;
    const dims = parseDimensions(ev.value);
    if (dims === null) return;
    this.sink.resize(dims.cols, dims.rows);
  }

  private setState(next: PaneStreamState): void {
    if (this.currentState === next) return;
    this.currentState = next;
    for (const h of this.stateListeners) h(next);
  }

  private listenerSet<E extends EventName>(event: E): Set<Listener<E>> {
    if (event === "state-changed") {
      return this.stateListeners as unknown as Set<Listener<E>>;
    }
    if (event === "activity-changed") {
      return this.activityListeners as unknown as Set<Listener<E>>;
    }
    return this.reconnectedListeners as unknown as Set<Listener<E>>;
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

// Inverse of the transport's Latin-1 byte container: each code unit (0x00-0xFF)
// becomes exactly one byte. Lossless — NOT a semantic decode. UTF-8 multibyte
// sequences in the captured screen survive as their original consecutive bytes,
// to be decoded by the renderer.
function latin1ToBytes(s: string): Uint8Array {
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i) & 0xff;
  return bytes;
}

interface SeedState {
  readonly cursor: SeedCursor | null;
  /** Visible grid height (`pane_height`); `NaN` if tmux didn't report it. */
  readonly height: number;
  /** Scrollback line count (`history_size`); `NaN` if not reported. */
  readonly historySize: number;
  /** Mode-setting escapes applied BEFORE the screen content (layout-affecting). */
  readonly preamble: string;
  /** Mode-setting escapes applied AFTER the screen content (input/cursor). */
  readonly epilogue: string;
}

// tmux flag values are "1"/"0"; map each to its DEC private-mode set/reset
// sequence. [LAW:dataflow-not-control-flow] The escape is selected by the
// flag VALUE through a table — no per-flag branching beyond the lookup.
function mode(flag: string | undefined, onSeq: string, offSeq: string): string {
  if (flag === undefined) return "";
  return flag === "1" ? onSeq : offSeq;
}

const ESC = "\x1b";

function parseSeedState(line: string): SeedState {
  // Reply layout (see stateCmd): cursor_x;cursor_y;alternate_on;cursor_flag;
  // insert_flag;keypad_cursor_flag;keypad_flag;wrap_flag;pane_height;
  // history_size. cursor_x/y are 0-indexed; the middle fields are 0/1 mode
  // flags; the trailing two are grid dimensions.
  const f = line.split(";");
  const cx = Number(f[0]);
  const cy = Number(f[1]);
  const cursor =
    f.length >= 2 && Number.isInteger(cx) && Number.isInteger(cy) && f[0] !== ""
      ? { col: cx, row: cy }
      : null;
  // NaN when absent (e.g. a fake/older tmux) — the seed normalization treats
  // NaN as "skip", degrading to the strip-only behaviour rather than padding.
  const height = f[8] !== undefined && f[8] !== "" ? Number(f[8]) : NaN;
  const historySize = f[9] !== undefined && f[9] !== "" ? Number(f[9]) : NaN;

  // Before content: enter alt screen (if active) then set autowrap — both
  // change how the subsequent screen content lays out.
  const preamble =
    (f[2] === "1" ? `${ESC}[?1049h` : "") +
    mode(f[7], `${ESC}[?7h`, `${ESC}[?7l`); // DECAWM autowrap

  // After content: input/cursor modes that the captured grid can't carry.
  const epilogue =
    mode(f[3], `${ESC}[?25h`, `${ESC}[?25l`) + // DECTCEM cursor visibility
    mode(f[4], `${ESC}[4h`, `${ESC}[4l`) + // IRM insert mode
    mode(f[5], `${ESC}[?1h`, `${ESC}[?1l`) + // DECCKM application cursor keys
    mode(f[6], `${ESC}=`, `${ESC}>`); // DECKPAM/DECKPNM keypad mode

  return { cursor, height, historySize, preamble, epilogue };
}

function parseDimensions(value: string): { cols: number; rows: number } | null {
  const m = value.match(/^(\d+);(\d+)$/);
  if (m === null) return null;
  const cols = Number(m[1]);
  const rows = Number(m[2]);
  if (cols <= 0 || rows <= 0) return null;
  return { cols, rows };
}
