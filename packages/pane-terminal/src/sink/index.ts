// packages/pane-terminal/src/sink/index.ts
//
// `TerminalSink` — the seam between PaneStream (byte/text producer, no DOM)
// and any concrete renderer (XtermSink in 8w9.6, BufferingSink in 8w9.5, or
// any consumer-defined sink). PaneStream calls only the methods declared
// here; nothing about xterm, MobX, React, or DOM appears in this contract.
//
// [LAW:locality-or-seam] This interface IS the seam — it lets PaneStream's
//   tests substitute an inline collector without pulling in xterm/jsdom.
// [LAW:one-source-of-truth] One declaration of the producer↔renderer
//   contract; concrete sinks (BufferingSink, XtermSink) implement it without
//   re-declaring the shape.
// [LAW:no-mode-explosion] Two methods for the two genuinely-different data
//   sources (`seed` text + cursor; `write` raw bytes). No "mode" parameter.

/**
 * Cursor coordinates as reported by tmux's `#{cursor_x};#{cursor_y}` format
 * variables: 0-indexed within the visible pane screen, top-left origin.
 *
 * Sinks that need to position a hardware cursor are responsible for any
 * coordinate translation (e.g. xterm's ANSI CUP escape is 1-indexed).
 */
export interface SeedCursor {
  readonly x: number;
  readonly y: number;
}

/**
 * Renderer-side seam consumed by `PaneStream`.
 *
 * Lifecycle from a sink's perspective:
 *
 *   stream.attach(sink)  →  sink.seed(text, cursor)
 *                        →  sink.write(bytes) ×N         (live byte stream)
 *                        →  sink.resize(cols, rows) ×M   (layout changes)
 *                        →  stream.detach()              (no further calls)
 *                        →  sink.dispose()               (consumer-driven)
 *
 * `seed` is called exactly once per attach, BEFORE any `write`. The transition
 * from seeding to live happens synchronously after `seed` returns — no
 * `await` between `seed` and the first buffered-byte `write`, so no live
 * byte can interleave the seed.
 */
export interface TerminalSink {
  /**
   * Seed the sink with the captured text grid + cursor position.
   *
   * Called exactly once per `attach()`. `cursor` is `null` when tmux did not
   * return a parsable cursor reply; sinks should leave the cursor at the
   * natural end of the captured text in that case.
   */
  seed(text: string, cursor: SeedCursor | null): void;

  /**
   * Forward a chunk of live bytes to the renderer. Bytes are byte-identical
   * to what tmux produced — no decoding, no copying (O3 from the design
   * doc). Called many times per second on busy panes; implementations
   * should not allocate per call.
   */
  write(bytes: Uint8Array): void;

  /**
   * Apply the current pane geometry. Called when the stream observes a
   * `subscription-changed` for this pane (tmux is the size authority).
   */
  resize(cols: number, rows: number): void;

  /** Reclaim resources. Idempotent — calling twice is a no-op. */
  dispose(): void;
}
