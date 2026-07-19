// packages/pane-terminal/src/sink/index.ts
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
//   a position, and `trailing` — the live bytes that arrived while the snapshot
//   was in flight — so that the snapshot→live ORDERING is one value's shape, not
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

/**
 * Renderer-side seam consumed by `PaneStream`.
 *
 * Lifecycle from a sink's perspective:
 *
 *   stream.attach(sink)  →  sink.seed(captured, cursor, trailing)  (snapshot +
 *                        →                                          the live bytes
 *                        →                                          captured behind it)
 *                        →  sink.write(data) ×N          (live byte stream)
 *                        →  sink.resize(cols, rows) ×M   (layout changes)
 *                        →  stream.detach()              (no further calls)
 *                        →  sink.dispose()               (consumer-driven)
 *
 * `seed` is called exactly once per attach, BEFORE any `write`. The snapshot and
 * its `trailing` bytes are one ordered unit, so the seed-before-live guarantee
 * rides on the value's shape — a sink applies `captured` then `trailing` in
 * order and nothing downstream re-derives that order from call sequencing.
 */
export interface TerminalSink {
  /**
   * Seed the view with a snapshot captured from tmux, followed by `trailing` —
   * the live bytes that arrived while that snapshot was being fetched, in
   * arrival order. Called exactly once per `attach()`, BEFORE any `write()`.
   *
   * `captured` is RAW BYTES: the joined `capture-pane` rows as tmux produced
   * them, wrapped by library-synthesized mode-restore escapes (alt-screen/
   * autowrap before the grid, cursor/keypad/insert after) that PaneStream
   * derives from `display-message` state — those escapes are injected by the
   * library, not emitted by `capture-pane`. Each element of `trailing` is the
   * same raw byte stream `write()` carries, so the renderer is the single
   * decoding authority; the library never interprets the captured grid bytes.
   *
   * `trailing` makes the seed-before-live ordering a property of THIS value:
   * the snapshot and the bytes that immediately follow it cross the seam as one
   * ordered unit, so no consumer re-establishes that order from the arrival
   * sequence of separate calls. It is empty on a re-attach (the cached seed has
   * no pending live bytes) and whenever nothing arrived during the capture
   * window. A sink MUST apply `captured` then each `trailing` chunk in order.
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
   * Apply the current pane geometry. Called when the stream observes a
   * `subscription-changed` for this pane (tmux is the size authority).
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
// BufferingSink — canonical test fixture, also re-exported for consumer use
// ---------------------------------------------------------------------------

export { BufferingSink } from "./buffering-sink.js";
