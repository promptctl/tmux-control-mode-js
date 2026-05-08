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
import type { ConnectionState } from "@promptctl/tmux-control-mode-js";
import type {
  CommandResponse,
  OutputMessage,
  ExtendedOutputMessage,
  SubscriptionChangedMessage,
} from "@promptctl/tmux-control-mode-js/protocol";

// `ReconnectedMessage` is a synthetic-event shape emitted by every
// TmuxClient-shaped class (see src/connection-state.ts in the parent
// package). It is intentionally tiny — duplicating the shape locally avoids
// pulling a non-public symbol into our typed surface, and the cost of one
// breakage if the library ever widens this type is negligible.
interface ReconnectedMessage {
  readonly type: "reconnected";
}
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
 * Visibility hint a consumer feeds the stream so the per-client
 * `ReseedScheduler` can dispatch in priority order on reconnect (O6).
 *
 * - `visible`: the sink is on screen and has a non-zero box; reseed first.
 * - `hidden`:  attached but offscreen (other tab, minimized window); reseed
 *              after every visible stream completes.
 *
 * Detached streams (no sink) are skipped entirely — tmux re-emits live
 * bytes once reconnected, and the next attach issues a fresh capture-pane.
 */
export type Visibility = "visible" | "hidden";

/**
 * Subset of `TmuxClient` surface PaneStream consumes. The real
 * `@promptctl/tmux-control-mode-js` `TmuxClient` and the bench
 * `FakeTmuxClient` both satisfy this structurally.
 *
 * `subscribe`/`unsubscribe` are optional because (a) the FakeTmuxClient
 * deliberately models only the byte-output + reconnect surface for benches,
 * and (b) the spawn-mode TmuxClient may be used without per-pane size
 * subscriptions in headless contexts.
 */
export interface PaneStreamClient {
  readonly connectionState: ConnectionState;
  on(event: "output", handler: (ev: OutputMessage) => void): void;
  on(
    event: "extended-output",
    handler: (ev: ExtendedOutputMessage) => void,
  ): void;
  on(event: "reconnected", handler: (ev: ReconnectedMessage) => void): void;
  off(event: "output", handler: (ev: OutputMessage) => void): void;
  off(
    event: "extended-output",
    handler: (ev: ExtendedOutputMessage) => void,
  ): void;
  off(event: "reconnected", handler: (ev: ReconnectedMessage) => void): void;
  execute(command: string): Promise<CommandResponse>;
  subscribe?(
    name: string,
    what: string,
    format: string,
  ): Promise<CommandResponse>;
  unsubscribe?(name: string): Promise<CommandResponse>;
}

/**
 * Internal narrowing helper used by `subscribeToSize()`/`dispose()` after we
 * confirm at runtime that the client implements `subscribe`. Independent
 * (NOT `extends`) of `PaneStreamClient` so TypeScript doesn't reject the
 * widened `on` overloads as incompatible with the narrower base type.
 *
 * The `as unknown as` cast at the call site is the [LAW:locality-or-seam]
 * boundary — one place that knows the bench fake doesn't model
 * `'subscription-changed'`, instead of every callsite.
 */
interface SubscriptionAwareClient {
  on(
    event: "subscription-changed",
    handler: (ev: SubscriptionChangedMessage) => void,
  ): void;
  off(
    event: "subscription-changed",
    handler: (ev: SubscriptionChangedMessage) => void,
  ): void;
  subscribe(
    name: string,
    what: string,
    format: string,
  ): Promise<CommandResponse>;
  unsubscribe(name: string): Promise<CommandResponse>;
}

export interface PaneStreamOptions {
  readonly client: PaneStreamClient;
  readonly paneId: number;
  /**
   * Lines of scrollback to include in the seed (`capture-pane -S -<N>`).
   * Default 0 — visible-screen-only seed (O1). Higher values trade attach
   * latency for history depth.
   */
  readonly historyLines?: number;
  /**
   * Coalescing window for `'activity-changed'` events. Default 100ms (O7).
   * The activity counters update synchronously on every byte; the *event*
   * fires at most once per window.
   */
  readonly activityThrottleMs?: number;
  /** Initial visibility. Default `"visible"`. */
  readonly visibility?: Visibility;
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

  private readonly client: PaneStreamClient;
  private readonly historyLines: number;
  private readonly activityThrottleMs: number;
  private readonly subscriptionName: string;

  private currentState: PaneStreamState = "idle";
  private sink: TerminalSink | null = null;
  // Buffer for live bytes that arrive during seeding. Drained synchronously
  // inside finishSeed() so no live byte interleaves the seed write.
  private buffer: Uint8Array[] = [];

  // Activity accounting. Updated synchronously on every byte event.
  // The flush emits a frozen snapshot at most every `activityThrottleMs`.
  private currentLastByteAt = 0;
  private currentBytesSinceAttach = 0;
  private flushTimerId: unknown = null;

  private currentVisibility: Visibility;

  // Listener registries. Per-event Sets so add/remove is O(1).
  private readonly stateListeners = new Set<Listener<"state-changed">>();
  private readonly activityListeners = new Set<Listener<"activity-changed">>();
  private readonly reconnectedListeners = new Set<Listener<"reconnected">>();

  // Pre-bound handlers so the [HOT-PATH] byte callback never allocates a
  // closure per byte and so off() can find the same reference we used for on().
  private readonly onOutput: (ev: OutputMessage) => void;
  private readonly onExtendedOutput: (ev: ExtendedOutputMessage) => void;
  private readonly onReconnected: (ev: ReconnectedMessage) => void;
  private readonly boundFlushActivity: () => void;
  private readonly onSubscriptionChanged:
    | ((ev: SubscriptionChangedMessage) => void)
    | null;

  constructor(opts: PaneStreamOptions) {
    this.client = opts.client;
    this.paneId = opts.paneId;
    this.historyLines = opts.historyLines ?? 0;
    this.activityThrottleMs = opts.activityThrottleMs ?? 100;
    this.currentVisibility = opts.visibility ?? "visible";
    this.subscriptionName = `pane-terminal-size-${opts.paneId}`;

    this.onOutput = (ev) => this.handlePaneOutput(ev.paneId, ev.data);
    this.onExtendedOutput = (ev) => this.handlePaneOutput(ev.paneId, ev.data);
    this.onReconnected = () => {
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

    // Layout-change handling — only when the client supports tmux format
    // subscriptions. The FakeTmuxClient deliberately doesn't, so benches
    // skip this path.
    if (typeof this.client.subscribe === "function") {
      const full = this.client as unknown as SubscriptionAwareClient;
      this.onSubscriptionChanged = (ev) => this.handleSubscriptionChanged(ev);
      full.on("subscription-changed", this.onSubscriptionChanged);
      // Per-pane width;height in one subscription (single message,
      // semicolon-separated) so tmux performs the layout walk for us.
      // .catch keeps construction safe — if the client is already closed or
      // tmux rejects the subscribe, swallowing here matches the symmetrical
      // unsubscribe() in dispose(), which can't surface as a usable error.
      void full
        .subscribe(
          this.subscriptionName,
          `%${this.paneId}`,
          "#{pane_width};#{pane_height}",
        )
        .catch(() => undefined);
    } else {
      this.onSubscriptionChanged = null;
    }

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

  get visibility(): Visibility {
    return this.currentVisibility;
  }

  setVisibility(v: Visibility): void {
    this.currentVisibility = v;
  }

  /**
   * Attach a sink. First attach (state === 'idle' | 'detached') triggers a
   * capture-pane + cursor query and seeds the sink synchronously when both
   * resolve. Re-attaching after detach reuses the existing PaneStream
   * lifecycle but issues a fresh seed (the visible state may have moved).
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

    this.setState("seeding");
    void this.seed();
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
    // The protocol-level `send-keys` requires a literal-flag for safety;
    // we wrap with -l (literal) and quote with surrounding "" — tmux's
    // command parser handles backslash escaping inside double quotes.
    const escaped = data.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return this.client.execute(`send-keys -t %${this.paneId} -l "${escaped}"`);
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

    if (this.onSubscriptionChanged !== null) {
      const full = this.client as unknown as SubscriptionAwareClient;
      full.off("subscription-changed", this.onSubscriptionChanged);
      // Best-effort unsubscribe — if the client is already closed, this
      // rejects; we swallow because dispose() must not throw.
      void full.unsubscribe(this.subscriptionName).catch(() => undefined);
    }

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
    return this.currentVisibility === "visible" ? 0 : 1;
  }

  async reseed(): Promise<void> {
    if (this.currentState === "disposed") return;
    if (this.sink === null) return;
    // Re-enter seeding so any byte arriving during the new capture is
    // buffered, not interleaved with the previous live frame.
    this.setState("seeding");
    await this.seed();
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
    //   idle/detached: only the activity counter updated above.
    if (this.currentState === "live") {
      // sink is non-null in 'live' by construction (attach assigns it
      // before transitioning). Trust the state machine.
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      this.sink!.write(data);
    } else if (this.currentState === "seeding") {
      this.buffer.push(data);
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

  private async seed(): Promise<void> {
    // Capture the sink at call time. If detach() runs before the responses
    // arrive, we abort cleanly without writing into a stale sink.
    const sinkAtStart = this.sink;
    if (sinkAtStart === null) return;

    const captureCmd =
      this.historyLines > 0
        ? `capture-pane -e -p -S -${this.historyLines} -t %${this.paneId}`
        : `capture-pane -e -p -t %${this.paneId}`;
    const cursorCmd = `display-message -p -t %${this.paneId} '#{cursor_x};#{cursor_y}'`;

    let captureOutput: readonly string[] = [];
    let cursorLine = "";
    try {
      const [captureResp, cursorResp] = await Promise.all([
        this.client.execute(captureCmd),
        this.client.execute(cursorCmd),
      ]);
      captureOutput = captureResp.output;
      cursorLine = cursorResp.output[0] ?? "";
    } catch {
      // Capture failed (e.g. connection closed). Fall through to live mode
      // with an empty seed; better to render nothing than to wedge in
      // 'seeding' forever. Activity events keep flowing.
    }

    // Re-check liveness after the await; consumer may have detached or
    // disposed in the meantime.
    if (this.currentState === "disposed") return;
    if (this.sink !== sinkAtStart) return;

    // [LAW:single-enforcer] The whole seeding→live transition lives below.
    // No `await` from here to the state flip — no live byte can interleave.
    const captured = captureOutput.join("\r\n");
    const cursor = parseCursor(cursorLine);

    sinkAtStart.seed(captured, cursor);

    // Drain buffered live bytes synchronously, then flip state.
    for (const bytes of this.buffer) {
      sinkAtStart.write(bytes);
    }
    this.buffer = [];
    this.setState("live");
  }

  private handleSubscriptionChanged(ev: SubscriptionChangedMessage): void {
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

function parseCursor(line: string): SeedCursor | null {
  const m = line.match(/^(\d+);(\d+)$/);
  if (m === null) return null;
  return { x: Number(m[1]), y: Number(m[2]) };
}

function parseDimensions(value: string): { cols: number; rows: number } | null {
  const m = value.match(/^(\d+);(\d+)$/);
  if (m === null) return null;
  const cols = Number(m[1]);
  const rows = Number(m[2]);
  if (cols <= 0 || rows <= 0) return null;
  return { cols, rows };
}
