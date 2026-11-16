// src/window-terminal/engine/terminal-sink.ts
//
// `TerminalSink` — the seam between PaneStream (byte/text producer, no DOM)
// and any concrete renderer (XtermSink, BufferingSink below, or
// any consumer-defined sink). PaneStream calls only the methods declared
// here; nothing about a concrete renderer or UI framework appears in this contract.
//
// [LAW:locality-or-seam] This interface IS the seam — it lets PaneStream's
//   tests substitute `BufferingSink` (or any inline collector) without
//   pulling in xterm/jsdom.
// [LAW:one-source-of-truth] One declaration of the producer↔renderer
//   contract; concrete sinks (BufferingSink, XtermSink) implement it without
//   re-declaring the shape.
// [LAW:one-source-of-truth] Both `seed` and `write` carry RAW BYTES. The seed
//   is just a snapshot of the same terminal byte stream the live path delivers,
//   so it has the same type — and the terminal emulator is the single decoding
//   authority for both. `seed` adds a cursor because the snapshot also restores
//   a position, and `trailing` — the live bytes tmux wrote after it took the
//   snapshot — so that the snapshot→live ORDERING is one value's shape, not
//   a convention re-enforced across separate `seed()`/`write()` calls.

/**
 * Cursor coordinates as reported by tmux's `#{cursor_x};#{cursor_y}` format
 * variables, normalised to a renderer-natural axis vocabulary:
 *
 * - `col`: column index (0-indexed from the left edge of the visible pane).
 * - `row`: row index    (0-indexed from the top edge of the visible pane).
 *
 * Sinks that need to position a hardware cursor are responsible for any
 * 1-indexing translation (e.g. xterm's ANSI CUP escape is 1-indexed).
 */
export interface SeedCursor {
  readonly col: number;
  readonly row: number;
}

/** A pane's size in cells, as tmux reports it (`pane_width`, `pane_height`). */
export interface PaneSize {
  readonly cols: number;
  readonly rows: number;
}

/**
 * Renderer-side seam consumed by `PaneStream`.
 *
 * Lifecycle from a sink's perspective:
 *
 *   stream.attach(sink)  →  sink.resize(cols, rows)      (the size the seed was
 *                                                          captured at, if known)
 *                        →  sink.seed(captured, cursor, trailing)  (snapshot +
 *                                                          the live bytes
 *                                                          captured behind it)
 *   then, interleaved:      sink.write(data)             (live byte stream)
 *                           sink.resize(cols, rows)      (layout changes)
 *                           sink.resize + sink.seed      (each recapture)
 *                        →  stream.detach()              (no further calls)
 *                        →  sink.dispose()               (consumer-driven)
 *
 * `seed` is called when a capture (or the re-attach cache) is handed to the
 * sink: at attach, and again whenever the stream recaptures (reconnect,
 * `%continue`, a new pane size), so it can follow `write`s. A failed capture
 * hands over no seed — its trailing bytes arrive as `write`s and the sink keeps
 * what it shows. The snapshot and its `trailing` bytes are one ordered unit,
 * so the seed-before-live guarantee rides on the value's shape — a sink
 * applies `captured` then `trailing` in order and nothing downstream
 * re-derives that order from call sequencing.
 */
export interface TerminalSink {
  /**
   * Seed the view with a snapshot captured from tmux, followed by `trailing` —
   * the live bytes tmux wrote after it took that snapshot, in order. (Bytes
   * that reached the client during the capture but were written before it are
   * inside the snapshot, and are not repeated here.) See the lifecycle above
   * for when it is called.
   *
   * `captured` is RAW BYTES: the joined `capture-pane` rows as tmux produced
   * them, wrapped by library-synthesized escapes (before the grid: alt-screen,
   * a scroll-region reset, cursor home, SGR reset, an erase of the screen and
   * of the scrollback, autowrap; after it: tmux's scroll region, which homes
   * the cursor, then cursor/keypad/insert) that PaneStream derives from
   * `display-message` state — those escapes are injected by the library, not
   * emitted by `capture-pane`. The grid is the pane's history above its
   * screen, and the erase acts on the screen buffer the seed draws into: a
   * main-screen seed replaces the sink's scrollback with tmux's, so a pane
   * recaptured any number of times holds its history once. (The alternate
   * screen has no scrollback; the main buffer keeps what it held until the
   * next main-screen seed.) Each element of
   * `trailing` is the same raw byte stream `write()` carries, so the renderer
   * is the single decoding authority; the library never interprets the
   * captured grid bytes.
   *
   * `captured` is the pane's whole picture as of the capture: every byte the
   * sink was given before this call is already inside it, so nothing the sink
   * received earlier needs to be applied after it.
   *
   * `trailing` makes the seed-before-live ordering a property of THIS value:
   * the snapshot and the bytes that immediately follow it cross the seam as one
   * ordered unit, so no consumer re-establishes that order from the arrival
   * sequence of separate calls. It is empty on a re-attach (the cached seed has
   * no pending live bytes) and whenever tmux wrote nothing after the capture.
   * A sink MUST apply `captured` then each `trailing` chunk in order.
   *
   * `cursor` is `null` when tmux did not return a parsable cursor reply;
   * sinks should leave the cursor at the natural end of the captured bytes
   * in that case.
   */
  seed(
    captured: Uint8Array,
    cursor: SeedCursor | null,
    trailing: readonly Uint8Array[],
  ): void;

  /**
   * Forward a chunk of live bytes to the renderer. Bytes are byte-identical
   * to what tmux produced — no decoding, no copying (O3 from the design
   * doc). Called many times per second on busy panes; implementations
   * should not allocate per call.
   */
  write(data: Uint8Array): void;

  /**
   * Apply the current pane geometry, as tmux (the size authority) reported
   * it: before each seed, with the size that seed was captured at, and on
   * each `subscription-changed` for this pane while attached. A seed is drawn
   * at the size the sink was last given, so it lands at tmux's size from its
   * first frame.
   */
  resize(cols: number, rows: number): void;

  /**
   * Whether this sink should be treated as visible for reseed-priority
   * purposes (the per-client `ReseedScheduler` pulls visible-attached
   * streams to the front of the dispatch queue).
   *
   * `BufferingSink` defaults to `true` and exposes a `visible` constructor
   * option + `setVisible()` so tests/benches can model an attached-but-
   * hidden sink. `XtermSink` consults its container's
   * `IntersectionObserver`/`document.visibilityState` state directly.
   */
  isVisible(): boolean;

  /** Reclaim resources. Idempotent — calling twice is a no-op. */
  dispose(): void;
}

// ---------------------------------------------------------------------------
// BufferingSink
// ---------------------------------------------------------------------------

// `BufferingSink` — canonical in-memory `TerminalSink` for tests and any
// caller that wants a renderer-free stand-in (CLI inspection, snapshot
// recording, the bench harness). Records every method call so tests can
// assert what the sink was asked to do, and concatenates `write()` payloads
// into a single byte view so byte-fidelity tests can `.equal()` the input.
//
// [LAW:one-source-of-truth] One sink class for tests; consumer-side fixtures
//   should reuse it rather than re-implementing capture-by-array.
// [LAW:behavior-not-structure] The sink records BEHAVIORAL events (seed,
//   write, resize, clear, dispose) — not internal renderer state. A test
//   that depends on internal Uint8Array buffer indices should examine the
//   call log, not the implementation.
// [LAW:no-defensive-null-guards] Methods never throw before dispose; after
//   dispose they no-op (the call is silently dropped). The dispose-after-use
//   contract is on the caller.

/** A recorded `seed()` call. */
export interface SeedCall {
  readonly captured: Uint8Array;
  readonly cursor: SeedCursor | null;
}

/** A recorded `resize()` call. */
export interface ResizeCall {
  readonly cols: number;
  readonly rows: number;
}

export interface BufferingSinkOptions {
  /**
   * Initial visibility for `isVisible()`. Default `true` (matches the
   * "fixture is in view" intent reseed-priority fixtures expect). Use `false`
   * to model an attached-but-hidden sink in reseed-priority tests.
   */
  readonly visible?: boolean;
}

export class BufferingSink implements TerminalSink {
  /** Every `seed()` call in order. Reset by `clear()`. */
  readonly seedCalls: SeedCall[] = [];
  /** Every `write()` call's bytes, in order. Reset by `clear()`. */
  readonly writes: Uint8Array[] = [];
  /** Every `resize()` call in order. Reset by `clear()`. */
  readonly resizeCalls: ResizeCall[] = [];

  private isDisposed = false;
  private visible: boolean;
  // Counters — useful when a test wants "number of calls" without
  // walking the array (which BufferingSink also exposes).
  private clearCount = 0;
  private disposeCount = 0;

  constructor(opts: BufferingSinkOptions = {}) {
    this.visible = opts.visible ?? true;
  }

  // ---------------------------------------------------------------------------
  // TerminalSink
  // ---------------------------------------------------------------------------

  seed(
    captured: Uint8Array,
    cursor: SeedCursor | null,
    trailing: readonly Uint8Array[],
  ): void {
    if (this.isDisposed) return;
    this.seedCalls.push({ captured, cursor });
    // Record the trailing live bytes as ordinary writes, in order — the same
    // behavioral events a sink observes when it applies snapshot-then-trailing.
    // A test asserting seed-before-live sees `seedCalls` then these `writes`.
    for (const chunk of trailing) this.writes.push(chunk);
  }

  write(data: Uint8Array): void {
    if (this.isDisposed) return;
    // Push the reference, not a copy — so a consumer can assert byte-identity
    // by reference (`sink.writes[0] === injected`), and the design
    // doc's O3 ("zero decoding in pipeline") forbids any copy here.
    this.writes.push(data);
  }

  resize(cols: number, rows: number): void {
    if (this.isDisposed) return;
    this.resizeCalls.push({ cols, rows });
  }

  clear(): void {
    if (this.isDisposed) return;
    this.clearCount += 1;
    // Empty in-place so test code holding a reference to seedCalls/writes/
    // resizeCalls still sees the updated array (same identity).
    this.seedCalls.length = 0;
    this.writes.length = 0;
    this.resizeCalls.length = 0;
  }

  isVisible(): boolean {
    if (this.isDisposed) return false;
    return this.visible;
  }

  dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;
    this.disposeCount += 1;
    this.seedCalls.length = 0;
    this.writes.length = 0;
    this.resizeCalls.length = 0;
  }

  // ---------------------------------------------------------------------------
  // Test-only inspection helpers
  // ---------------------------------------------------------------------------

  /** True after `dispose()` has been called at least once. */
  get disposed(): boolean {
    return this.isDisposed;
  }

  /** Total `clear()` invocations across the lifetime of the sink. */
  get clearCalls(): number {
    return this.clearCount;
  }

  /** Total `dispose()` invocations across the lifetime of the sink. */
  get disposeCalls(): number {
    return this.disposeCount;
  }

  /**
   * Mutate visibility — used by reseed-priority fixtures to
   * model "this sink is on the offscreen tab right now." No-op after
   * `dispose()` to honour the post-dispose contract documented above
   * `BufferingSink` (every method becomes a no-op).
   */
  setVisible(v: boolean): void {
    if (this.isDisposed) return;
    this.visible = v;
  }

  /**
   * Concatenated byte view of every `write()` call since the last `clear()`
   * (or since construction). Returns a single new `Uint8Array` — useful
   * when a test wants to assert "the full byte stream the sink received
   * equals the bytes injected." Allocates; do NOT call from a hot path.
   */
  concatBytes(): Uint8Array {
    let total = 0;
    for (const w of this.writes) total += w.byteLength;
    const out = new Uint8Array(total);
    let off = 0;
    for (const w of this.writes) {
      out.set(w, off);
      off += w.byteLength;
    }
    return out;
  }
}
