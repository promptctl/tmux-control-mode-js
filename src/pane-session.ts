// src/pane-session.ts
// PaneSession — headless seed→live state machine for one tmux pane.
//
// Promotes the pattern from examples/web-multiplexer/web/pane-terminal.ts
// into the library so consumers don't reinvent it (and don't reinvent its
// bugs). The demo's *intent* is preserved verbatim; its accidents — scattered
// disposal guards, state-checked branches in the byte path, swallowed seed
// errors, an unbounded buffer — are restructured.
//
// What the demo gets right and this preserves:
//   - The output listener registers BEFORE capture-pane is sent, so no event
//     in the seed window is dropped.
//   - capture-pane and the cursor query run in parallel.
//   - The drain-and-flip is synchronous: snapshot write, CUP cursor restore,
//     buffer drain, byte-path swap. No await between any of those steps so
//     no event can interleave.
//   - CUP from tmux's actual cursor (display-message), not from the bottom
//     of the captured snapshot.
//
// What this fixes:
//   - [LAW:dataflow-not-control-flow] The byte path is a function pointer
//     (`bytePath`), not an `if (state === "live") write else buffer` branch.
//     Same line of code runs every event; what differs is which function
//     `bytePath` references. Atomically swapped at flip time.
//   - [LAW:single-enforcer] One dispose path owns listener teardown. The
//     demo's scattered disposal checks collapse to: dispose() detaches
//     client/sink listeners and flips bytePath to a no-op for any in-flight
//     emit racing the detach.
//   - No silent fallbacks: seed failures emit a typed `seed-error` event
//     instead of being console.error'd.
//   - Bounded buffer: at the byte cap, drop oldest queued events and emit
//     `seed-overflow` so the consumer can warn the user. The demo would
//     accumulate without bound on a slow seed.
//
// What this does NOT do (intentional):
//   - Does not call resize-pane on tmux. `resize(cols, rows)` mirrors to the
//     sink only. The demo's reaction also never sends resize-pane — it
//     mirrors the dimensions tmux already published. Consumers own the
//     tmux-side trigger (toolbar buttons, layout changes, etc.).
//   - Does not own keymap routing. The sink emits onData for keystrokes the
//     consumer's keymap didn't intercept; PaneSession forwards those to
//     send-keys. Tmux-style chords (e.g. C-b n) belong on a document-level
//     handler in the consumer because per-sink listeners only fire while the
//     specific sink has focus, which is the wrong scope for window-switch
//     shortcuts.
//
// Backpressure (this file owns it):
//   - Per-pane pause/resume on top of tmux's `refresh-client -A %<id>:pause`
//     / `:continue` flow-control. Three orthogonal trigger sources, all
//     funneled into a single pause-state field:
//       (a) consumer call: `pause()` / `resume()`,
//       (b) tmux-driven: %pause / %continue notifications,
//       (c) sink-stall: when the sink implements `writeAsync`, outstanding
//           chunk count crossing the high-water mark auto-pauses; draining
//           below the low-water mark auto-resumes.
//   - The pause axis is independent of the lifecycle axis (idle/seeding/
//     live/disposed). A live pane can be running OR paused — composing
//     four lifecycle states with two pause states would balloon to eight
//     enum entries [LAW:no-mode-explosion]; keeping them as separate fields
//     keeps each axis pure and avoids combinatorial test surface.

import { PaneAction } from "./protocol/types.js";
import type {
  CommandResponse,
  ContinueMessage,
  ExtendedOutputMessage,
  OutputMessage,
  PauseMessage,
} from "./protocol/types.js";

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export type PaneSessionState = "idle" | "seeding" | "live" | "disposed";

/**
 * Minimal client surface PaneSession requires. TmuxClient satisfies this
 * directly; renderer-side bridges (Electron IPC, WebSocket) provide an
 * adapter so PaneSession works unchanged on both sides of the wire.
 *
 * [LAW:locality-or-seam] This interface IS the seam between PaneSession and
 * any consumer that fronts tmux through a non-TmuxClient transport. Adding
 * a method here is a contract change; do not extend casually.
 */
export interface PaneSessionClient {
  on(event: "output", handler: (msg: OutputMessage) => void): void;
  on(
    event: "extended-output",
    handler: (msg: ExtendedOutputMessage) => void,
  ): void;
  on(event: "pause", handler: (msg: PauseMessage) => void): void;
  on(event: "continue", handler: (msg: ContinueMessage) => void): void;
  off(event: "output", handler: (msg: OutputMessage) => void): void;
  off(
    event: "extended-output",
    handler: (msg: ExtendedOutputMessage) => void,
  ): void;
  off(event: "pause", handler: (msg: PauseMessage) => void): void;
  off(event: "continue", handler: (msg: ContinueMessage) => void): void;
  execute(command: string): Promise<CommandResponse>;
  sendKeys(target: string, keys: string): Promise<CommandResponse>;
  // [LAW:one-source-of-truth] PaneSession does NOT format
  // `refresh-client -A %X:pause` itself — that wire string lives in
  // src/protocol/encoder.ts. The seam exposes the canonical TmuxClient verb
  // so connector adapters (Electron IPC, WebSocket) keep the same shape.
  setPaneAction(paneId: number, action: PaneAction): Promise<CommandResponse>;
}

/**
 * Bidirectional terminal interface PaneSession drives. Implementations are
 * sink-side (xterm.js, Electron renderer, headless test capture, etc.).
 * PaneSession imports nothing about the renderer — the sink is the seam.
 */
export interface TerminalSink {
  /** Write decoded pane output bytes. Synchronous; used during seed flush. */
  write(bytes: Uint8Array): void;
  /** Set the sink's logical dimensions (cols × rows). */
  resize(cols: number, rows: number): void;
  /** Subscribe to user keystrokes. PaneSession forwards them to send-keys. */
  onData(handler: (bytes: Uint8Array) => void): { dispose(): void };
  /** Move keyboard focus to the sink. */
  focus(): void;
  /**
   * Optional async write hook. When implemented, PaneSession routes live
   * (post-seed) bytes through here and tracks outstanding chunks. The
   * returned promise should resolve once the sink has finished processing
   * the chunk (xterm.js: callback after rendering; Electron renderer:
   * post-paint ack). Outstanding chunks crossing the high-water mark
   * auto-pause tmux; draining below the low-water mark auto-resumes.
   *
   * Sinks without this method are treated as instantaneous: live writes go
   * through synchronous `write()` and no stall detection runs.
   */
  writeAsync?(bytes: Uint8Array): Promise<void>;
}

export interface PaneSessionOptions {
  readonly client: PaneSessionClient;
  readonly paneId: number;
  readonly sink: TerminalSink;
  /**
   * Soft cap on bytes the seed-phase buffer holds. When exceeded, the
   * oldest queued events are dropped to bring usage back under the cap and
   * a `seed-overflow` event fires with the dropped count. Defaults to
   * 4 MiB — enough for a slow remote pane to seed without dropping the
   * common case, small enough to fail loudly on a stuck seed.
   */
  readonly bufferLimitBytes?: number;
  /**
   * High-water mark (in outstanding sink chunks) at which sink-stall
   * detection auto-pauses the pane. Only consulted when the sink
   * implements `writeAsync`. Defaults to 64.
   */
  readonly stallHighChunks?: number;
  /**
   * Low-water mark (in outstanding sink chunks) at which an auto-paused
   * pane is resumed. Must be < `stallHighChunks`. Defaults to 16.
   */
  readonly stallLowChunks?: number;
}

interface PaneSessionConfig {
  readonly bufferLimitBytes: number;
  readonly stallHighChunks: number;
  readonly stallLowChunks: number;
}

/** Why the pane transitioned into the paused state. */
export type PauseReason = "consumer" | "sink-stall" | "tmux";

export interface PaneSessionEventMap {
  readonly "state-change": { readonly state: PaneSessionState };
  readonly "seed-error": { readonly cause: unknown };
  readonly "seed-overflow": { readonly droppedBytes: number };
  readonly paused: { readonly reason: PauseReason };
  readonly resumed: Record<never, never>;
}

const DEFAULT_BUFFER_LIMIT_BYTES = 4 * 1024 * 1024;
const DEFAULT_STALL_HIGH_CHUNKS = 64;
const DEFAULT_STALL_LOW_CHUNKS = 16;

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder("utf-8", { fatal: false });

const NOOP_WRITE = (_bytes: Uint8Array): void => undefined;

function paneSessionConfig(options: PaneSessionOptions): PaneSessionConfig {
  const bufferLimitBytes =
    options.bufferLimitBytes ?? DEFAULT_BUFFER_LIMIT_BYTES;
  const stallHighChunks =
    options.stallHighChunks ?? DEFAULT_STALL_HIGH_CHUNKS;
  const stallLowChunks = options.stallLowChunks ?? DEFAULT_STALL_LOW_CHUNKS;

  // [LAW:single-enforcer] Stall threshold invariants are enforced once at
  // construction, before evaluateStallPressure can observe invalid states.
  if (!Number.isInteger(stallHighChunks) || stallHighChunks < 1) {
    throw new Error(
      "PaneSession: stallHighChunks must be a positive integer",
    );
  }
  if (!Number.isInteger(stallLowChunks) || stallLowChunks < 0) {
    throw new Error(
      "PaneSession: stallLowChunks must be a non-negative integer",
    );
  }
  if (stallLowChunks >= stallHighChunks) {
    throw new Error(
      "PaneSession: stallLowChunks must be lower than stallHighChunks",
    );
  }

  return { bufferLimitBytes, stallHighChunks, stallLowChunks };
}

// ---------------------------------------------------------------------------
// PaneSession
// ---------------------------------------------------------------------------

type Handler<E> = (event: E) => void;

type ListenerSets = {
  [K in keyof PaneSessionEventMap]?: Set<Handler<PaneSessionEventMap[K]>>;
};

export class PaneSession {
  readonly paneId: number;

  private readonly client: PaneSessionClient;
  private readonly sink: TerminalSink;
  private readonly bufferLimitBytes: number;
  private readonly stallHighChunks: number;
  private readonly stallLowChunks: number;
  private readonly listeners: ListenerSets = {};

  // [LAW:dataflow-not-control-flow] The byte path is data, not control flow.
  // Initially it appends to the seed buffer; at flip time it is atomically
  // swapped to write straight through to the sink. The output handler that
  // calls `bytePath(bytes)` runs every event — no `if (state === "live")`.
  private bytePath: (bytes: Uint8Array) => void;

  // [LAW:dataflow-not-control-flow] The live writer is also a function
  // pointer — picked once at construction from the sink's capability shape
  // (writeAsync present → tracking path; absent → sync write). The hot
  // path never branches on capability.
  private readonly liveBytePath: (bytes: Uint8Array) => void;

  private buffer: Uint8Array[] = [];
  private bufferBytes = 0;
  private state: PaneSessionState = "idle";
  private inputDisposable: { dispose(): void } | null = null;
  private detachClientListeners: (() => void) | null = null;

  // [LAW:no-mode-explosion] Pause is its own axis, not folded into the
  // lifecycle enum. `pauseReason === null` means running; non-null means
  // paused with that originating cause. Auto-resume only fires when the
  // active reason is "sink-stall" — consumer/tmux pauses persist until
  // explicitly released.
  private pauseReason: PauseReason | null = null;
  private outstandingChunks = 0;

  constructor(options: PaneSessionOptions) {
    const config = paneSessionConfig(options);
    this.client = options.client;
    this.paneId = options.paneId;
    this.sink = options.sink;
    this.bufferLimitBytes = config.bufferLimitBytes;
    this.stallHighChunks = config.stallHighChunks;
    this.stallLowChunks = config.stallLowChunks;
    this.bytePath = (bytes) => this.bufferAppend(bytes);
    this.liveBytePath =
      this.sink.writeAsync !== undefined
        ? (bytes) => this.writeAsyncTracked(bytes)
        : (bytes) => this.sink.write(bytes);
  }

  /** Current lifecycle state. Synchronous mirror of the last state-change event. */
  get currentState(): PaneSessionState {
    return this.state;
  }

  // -------------------------------------------------------------------------
  // Event surface
  // -------------------------------------------------------------------------

  on<K extends keyof PaneSessionEventMap>(
    event: K,
    handler: Handler<PaneSessionEventMap[K]>,
  ): void {
    let set = this.listeners[event] as
      | Set<Handler<PaneSessionEventMap[K]>>
      | undefined;
    if (set === undefined) {
      set = new Set();
      this.listeners[event] = set as never;
    }
    set.add(handler);
  }

  off<K extends keyof PaneSessionEventMap>(
    event: K,
    handler: Handler<PaneSessionEventMap[K]>,
  ): void {
    const set = this.listeners[event] as
      | Set<Handler<PaneSessionEventMap[K]>>
      | undefined;
    set?.delete(handler);
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Begin seeding the sink and transition into the live byte stream.
   * Resolves once the seed has drained (success or failure — either way
   * live events flow afterward). Idempotent: a second call is a no-op.
   */
  async attach(): Promise<void> {
    if (this.state === "disposed") {
      throw new Error("PaneSession.attach: instance is disposed");
    }
    if (this.state !== "idle") return;

    this.installListeners();
    this.transition("seeding");
    await this.seed();
  }

  /**
   * Mirror new dimensions to the sink. Does NOT issue resize-pane to tmux —
   * the consumer owns that round-trip. PaneSession is a passive mirror so
   * that whatever topology source the consumer uses (DemoStore, TmuxModel,
   * a custom format subscription) is the single source of truth for size.
   */
  resize(cols: number, rows: number): void {
    if (this.state === "disposed") return;
    this.sink.resize(cols, rows);
  }

  /** Move focus to the sink. No-op after dispose. */
  focus(): void {
    if (this.state === "disposed") return;
    this.sink.focus();
  }

  /** True iff the pane is currently paused (by any cause). */
  get isPaused(): boolean {
    return this.pauseReason !== null;
  }

  /**
   * Ask tmux to stop emitting %output for this pane. Idempotent: a pause
   * issued while already paused is a no-op (no second `paused` event, no
   * duplicate wire command). The wire command is fire-and-forget — the
   * `paused` event fires synchronously on the consumer-call transition,
   * not on tmux's confirming `%pause` notification (the spec requires the
   * event to fire on the consumer call), and tmux's eventual `%pause`
   * lands in an already-paused state which collapses to a no-op.
   */
  pause(): void {
    if (this.state === "disposed") return;
    this.enterPaused("consumer");
  }

  /**
   * Ask tmux to resume emitting %output for this pane. Idempotent.
   * Releases the pause regardless of which trigger caused it (consumer,
   * tmux, sink-stall) — the consumer's intent overrides any source.
   */
  resume(): void {
    if (this.state === "disposed") return;
    this.exitPaused();
  }

  /**
   * Detach all listeners and discard the seed buffer. Idempotent. After
   * dispose all event-emit and sink-write paths are inert.
   */
  dispose(): void {
    if (this.state === "disposed") return;
    this.transition("disposed");
    // [LAW:single-enforcer] One dispose path detaches every listener attached
    // by installListeners(). The detachClientListeners closure removes the
    // client.on registrations; the inputDisposable removes the sink.onData
    // registration.
    this.detachClientListeners?.();
    this.detachClientListeners = null;
    this.inputDisposable?.dispose();
    this.inputDisposable = null;
    this.buffer = [];
    this.bufferBytes = 0;
    this.outstandingChunks = 0;
    this.pauseReason = null;
    // Belt-and-suspenders: if a client emit is iterating its handler set
    // concurrently with the off() above, the handler may still fire. Flipping
    // bytePath to a no-op ensures any such late call lands on the floor.
    // Also neutralizes any in-flight writeAsync ack — onSinkChunkSettled
    // exits early once state === "disposed", so a late settle from a
    // disposed session can't double-decrement counters or mis-fire stall
    // transitions.
    this.bytePath = NOOP_WRITE;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private installListeners(): void {
    // [LAW:locality-or-seam] Per-pane filtering is the seam between the
    // client's broadcast event surface and PaneSession's per-pane stream.
    // One paneId comparison per event; the consumer never sees others.
    const onOutput = (msg: OutputMessage | ExtendedOutputMessage): void => {
      if (msg.paneId !== this.paneId) return;
      this.bytePath(msg.data);
    };
    // [LAW:dataflow-not-control-flow] Tmux pause/continue notifications
    // feed the same pause-state mutator the consumer-driven path uses;
    // the source of the transition is captured in the reason field, but
    // the operation that runs is identical.
    const onPause = (msg: PauseMessage): void => {
      if (msg.paneId !== this.paneId) return;
      this.enterPaused("tmux");
    };
    const onContinue = (msg: ContinueMessage): void => {
      if (msg.paneId !== this.paneId) return;
      this.exitPaused();
    };
    this.client.on("output", onOutput);
    this.client.on("extended-output", onOutput);
    this.client.on("pause", onPause);
    this.client.on("continue", onContinue);
    this.detachClientListeners = () => {
      this.client.off("output", onOutput);
      this.client.off("extended-output", onOutput);
      this.client.off("pause", onPause);
      this.client.off("continue", onContinue);
    };

    // Wire user keystrokes from the sink → tmux send-keys. The consumer's
    // keymap (window-switch chords, etc.) sits in front of this — only
    // keystrokes the keymap ignored reach the sink and therefore us.
    this.inputDisposable = this.sink.onData((bytes) => {
      const text = TEXT_DECODER.decode(bytes);
      // Fire-and-forget. TmuxClient's FIFO queue preserves ordering relative
      // to other commands; we don't await because awaiting per-keystroke
      // would serialize input on the tmux response channel.
      void this.client.sendKeys(`%${this.paneId}`, text);
    });
  }

  private async seed(): Promise<void> {
    try {
      const [captureResp, cursorResp] = await Promise.all([
        // -e: include escapes; -p: print to stdout; -S -: from start of
        // history through the visible screen. Full scrollback in one shot.
        this.client.execute(`capture-pane -e -p -S - -t %${this.paneId}`),
        // 0-indexed cursor coords. Convert to 1-indexed below for the ANSI
        // CUP escape, which is 1-indexed by spec.
        this.client.execute(
          `display-message -p -t %${this.paneId} '#{cursor_x};#{cursor_y}'`,
        ),
      ]);
      if (this.state === "disposed") return;

      // [LAW:single-enforcer] The whole transition from seeding to live
      // happens inside this synchronous block. No await between the snapshot
      // write, the cursor restore, the buffer drain, and the bytePath swap,
      // so no event can interleave.
      const captured = captureResp.output.join("\r\n");
      this.sink.write(TEXT_ENCODER.encode(captured));

      const cursorLine = cursorResp.output[0] ?? "";
      const match = cursorLine.match(/^(\d+);(\d+)$/);
      if (match !== null) {
        const cursorX = parseInt(match[1], 10);
        const cursorY = parseInt(match[2], 10);
        const cup = `\x1b[${cursorY + 1};${cursorX + 1}H`;
        this.sink.write(TEXT_ENCODER.encode(cup));
      }

      // Drain in arrival order so live events that landed during the seed
      // window appear on top of the snapshot at the snapshot's cursor —
      // not at whatever cursor position they happened to imply.
      // [LAW:dataflow-not-control-flow] Drain through `liveBytePath` so
      // sink-stall accounting picks up the buffered chunks at flip time —
      // the same path live events take from here on.
      for (const bytes of this.buffer) this.liveBytePath(bytes);
      this.buffer = [];
      this.bufferBytes = 0;

      this.bytePath = this.liveBytePath;
      this.transition("live");
    } catch (cause) {
      if (this.state === "disposed") return;
      // No silent fallback. The seed buffer is dropped because, without the
      // snapshot, the queued events are rootless — a consumer choosing to
      // surface a "snapshot unavailable" UI affordance can decide whether
      // to reattach. Live events flow from here on.
      this.bytePath = this.liveBytePath;
      this.buffer = [];
      this.bufferBytes = 0;
      this.transition("live");
      this.emit("seed-error", { cause });
    }
  }

  // [LAW:single-enforcer] Every pause-state ENTRY funnels through here:
  // consumer pause(), tmux %pause, and sink-stall auto-pause all call this.
  // The single transition gate guarantees we emit at most one `paused` event
  // per running→paused edge regardless of how many sources collapse onto it.
  private enterPaused(reason: PauseReason): void {
    if (this.pauseReason !== null) return;
    this.pauseReason = reason;
    // Tmux is the source of truth for "we observed pause"; for tmux-driven
    // transitions we don't echo the wire command (it's already paused).
    // Consumer- and sink-stall-driven transitions DO send the wire command
    // — that's how we ask tmux to stop. Fire-and-forget; tmux acks with
    // its own %pause which lands as a no-op above.
    if (reason !== "tmux") {
      void this.client
        .setPaneAction(this.paneId, PaneAction.Pause)
        .catch(() => undefined);
    }
    this.emit("paused", { reason });
  }

  // [LAW:single-enforcer] Mirror of enterPaused — every paused→running
  // edge passes through here. tmux's %continue lands here too, so a
  // consumer that called pause() and then sees tmux spontaneously
  // resume gets a clean `resumed` event.
  private exitPaused(): void {
    if (this.pauseReason === null) return;
    const previous = this.pauseReason;
    this.pauseReason = null;
    if (previous !== "tmux") {
      void this.client
        .setPaneAction(this.paneId, PaneAction.Continue)
        .catch(() => undefined);
    }
    this.emit("resumed", {});
  }

  // Sink-stall accounting. Only invoked when this.sink.writeAsync is
  // present (the constructor picks the tracking path then; the sync path
  // never touches these counters).
  //
  // [LAW:dataflow-not-control-flow] Every chunk runs the same shape:
  // increment, evaluate watermark, dispatch. The `evaluateStallPressure`
  // call is unconditional; the data (counter vs watermark, current
  // pause reason) decides whether a transition fires.
  private writeAsyncTracked(bytes: Uint8Array): void {
    this.outstandingChunks += 1;
    this.evaluateStallPressure();
    const writeAsync = this.sink.writeAsync as (b: Uint8Array) => Promise<void>;
    const onSettled = (): void => this.onSinkChunkSettled();
    writeAsync(bytes).then(onSettled, onSettled);
  }

  private onSinkChunkSettled(): void {
    if (this.state === "disposed") return;
    this.outstandingChunks = Math.max(0, this.outstandingChunks - 1);
    this.evaluateStallPressure();
  }

  // [LAW:dataflow-not-control-flow] Pure value-driven dispatcher. Called
  // on every chunk in and every chunk done; the same operation runs each
  // tick — only the value of (counter, current pause reason) decides the
  // outcome. No "skipped" branches.
  private evaluateStallPressure(): void {
    const overHigh = this.outstandingChunks >= this.stallHighChunks;
    const underLow = this.outstandingChunks <= this.stallLowChunks;
    if (overHigh && this.pauseReason === null) {
      this.enterPaused("sink-stall");
      return;
    }
    if (underLow && this.pauseReason === "sink-stall") {
      this.exitPaused();
    }
  }

  private bufferAppend(bytes: Uint8Array): void {
    this.buffer.push(bytes);
    this.bufferBytes += bytes.byteLength;
    if (this.bufferBytes <= this.bufferLimitBytes) return;

    // [LAW:errors:no-silent-fallbacks] Don't grow without bound. Don't drop
    // silently. Drop the oldest tail, emit the byte count so the consumer
    // can warn — most likely outcome is the seed is genuinely stuck and a
    // reattach is the right move.
    let dropped = 0;
    while (this.bufferBytes > this.bufferLimitBytes && this.buffer.length > 0) {
      const head = this.buffer.shift() as Uint8Array;
      dropped += head.byteLength;
      this.bufferBytes -= head.byteLength;
    }
    this.emit("seed-overflow", { droppedBytes: dropped });
  }

  private transition(next: PaneSessionState): void {
    if (this.state === next) return;
    this.state = next;
    this.emit("state-change", { state: next });
  }

  private emit<K extends keyof PaneSessionEventMap>(
    event: K,
    payload: PaneSessionEventMap[K],
  ): void {
    const set = this.listeners[event] as
      | Set<Handler<PaneSessionEventMap[K]>>
      | undefined;
    if (set === undefined) return;
    for (const handler of set) handler(payload);
  }
}
