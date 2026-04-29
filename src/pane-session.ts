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
//   - [LAW:single-enforcer] One AbortController gates all listener teardown.
//     The demo's five separate `if (state === "disposed") return` callback
//     guards collapse to: dispose() aborts; listeners detach; bytePath flips
//     to a no-op for any in-flight emit racing the abort.
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
//   - Does not implement %pause/%continue backpressure. The demo doesn't
//     either; promoting it without exposing the gap would mask the bug.
//     Tracked in tmux-headless-api-59c as a follow-up ticket.
//   - Does not own keymap routing. The sink emits onData for keystrokes the
//     consumer's keymap didn't intercept; PaneSession forwards those to
//     send-keys. Tmux-style chords (e.g. C-b n) belong on a document-level
//     handler in the consumer because per-sink listeners only fire while the
//     specific sink has focus, which is the wrong scope for window-switch
//     shortcuts.

import type {
  CommandResponse,
  ExtendedOutputMessage,
  OutputMessage,
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
  off(event: "output", handler: (msg: OutputMessage) => void): void;
  off(
    event: "extended-output",
    handler: (msg: ExtendedOutputMessage) => void,
  ): void;
  execute(command: string): Promise<CommandResponse>;
  sendKeys(target: string, keys: string): Promise<CommandResponse>;
}

/**
 * Bidirectional terminal interface PaneSession drives. Implementations are
 * sink-side (xterm.js, Electron renderer, headless test capture, etc.).
 * PaneSession imports nothing about the renderer — the sink is the seam.
 */
export interface TerminalSink {
  /** Write decoded pane output bytes. */
  write(bytes: Uint8Array): void;
  /** Set the sink's logical dimensions (cols × rows). */
  resize(cols: number, rows: number): void;
  /** Subscribe to user keystrokes. PaneSession forwards them to send-keys. */
  onData(handler: (bytes: Uint8Array) => void): { dispose(): void };
  /** Move keyboard focus to the sink. */
  focus(): void;
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
}

export interface PaneSessionEventMap {
  readonly "state-change": { readonly state: PaneSessionState };
  readonly "seed-error": { readonly cause: unknown };
  readonly "seed-overflow": { readonly droppedBytes: number };
}

const DEFAULT_BUFFER_LIMIT_BYTES = 4 * 1024 * 1024;

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder("utf-8", { fatal: false });

const NOOP_WRITE = (_bytes: Uint8Array): void => undefined;

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
  private readonly abort: AbortController;
  private readonly listeners: ListenerSets = {};

  // [LAW:dataflow-not-control-flow] The byte path is data, not control flow.
  // Initially it appends to the seed buffer; at flip time it is atomically
  // swapped to write straight through to the sink. The output handler that
  // calls `bytePath(bytes)` runs every event — no `if (state === "live")`.
  private bytePath: (bytes: Uint8Array) => void;
  private buffer: Uint8Array[] = [];
  private bufferBytes = 0;
  private state: PaneSessionState = "idle";
  private inputDisposable: { dispose(): void } | null = null;
  private detachClientListeners: (() => void) | null = null;

  constructor(options: PaneSessionOptions) {
    this.client = options.client;
    this.paneId = options.paneId;
    this.sink = options.sink;
    this.bufferLimitBytes =
      options.bufferLimitBytes ?? DEFAULT_BUFFER_LIMIT_BYTES;
    this.abort = new AbortController();
    this.bytePath = (bytes) => this.bufferAppend(bytes);
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

  /**
   * Detach all listeners and discard the seed buffer. Idempotent. After
   * dispose all event-emit and sink-write paths are inert.
   */
  dispose(): void {
    if (this.state === "disposed") return;
    this.transition("disposed");
    // [LAW:single-enforcer] One abort signal cancels every listener attached
    // by installListeners(). The detachClientListeners closure removes the
    // client.on registrations; the inputDisposable removes the sink.onData
    // registration; the abort signal is the synchronization point.
    this.abort.abort();
    this.detachClientListeners?.();
    this.detachClientListeners = null;
    this.inputDisposable?.dispose();
    this.inputDisposable = null;
    this.buffer = [];
    this.bufferBytes = 0;
    // Belt-and-suspenders: if a client emit is iterating its handler set
    // concurrently with the off() above, the handler may still fire. Flipping
    // bytePath to a no-op ensures any such late call lands on the floor.
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
    this.client.on("output", onOutput);
    this.client.on("extended-output", onOutput);
    this.detachClientListeners = () => {
      this.client.off("output", onOutput);
      this.client.off("extended-output", onOutput);
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
      for (const bytes of this.buffer) this.sink.write(bytes);
      this.buffer = [];
      this.bufferBytes = 0;

      this.bytePath = (bytes) => this.sink.write(bytes);
      this.transition("live");
    } catch (cause) {
      if (this.state === "disposed") return;
      // No silent fallback. The seed buffer is dropped because, without the
      // snapshot, the queued events are rootless — a consumer choosing to
      // surface a "snapshot unavailable" UI affordance can decide whether
      // to reattach. Live events flow from here on.
      this.bytePath = (bytes) => this.sink.write(bytes);
      this.buffer = [];
      this.bufferBytes = 0;
      this.transition("live");
      this.emit("seed-error", { cause });
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
