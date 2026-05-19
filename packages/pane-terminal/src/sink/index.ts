// packages/pane-terminal/src/sink/index.ts
//
// `TerminalSink` — the seam between PaneStream (byte/text producer, no DOM)
// and any concrete renderer (XtermSink in 8w9.6, BufferingSink below, or
// any consumer-defined sink). PaneStream calls only the methods declared
// here; nothing about xterm, MobX, React, or DOM appears in this contract.
//
// [LAW:locality-or-seam] This interface IS the seam — it lets PaneStream's
//   tests substitute `BufferingSink` (or any inline collector) without
//   pulling in xterm/jsdom.
// [LAW:one-source-of-truth] One declaration of the producer↔renderer
//   contract; concrete sinks (BufferingSink, XtermSink) implement it without
//   re-declaring the shape. tmux's byte stream is the SOLE authority for
//   cursor position — sinks never manufacture cursor-positioning escapes.
// [LAW:no-mode-explosion] Two distinct methods for the two genuinely
//   different data sources (`seed` text from capture-pane; `write` raw bytes
//   from %output). No "mode" parameter; no shared union type.

/**
 * Renderer-side seam consumed by `PaneStream`.
 *
 * Lifecycle from a sink's perspective:
 *
 *   stream.attach(sink)  →  sink.seed(captured)
 *                        →  sink.write(data) ×N          (live byte stream)
 *                        →  sink.resize(cols, rows) ×M   (layout changes)
 *                        →  stream.detach()              (no further calls)
 *                        →  sink.dispose()               (consumer-driven)
 *
 * `seed` is called exactly once per attach, BEFORE any `write`. The
 * transition from seeding to live happens synchronously after `seed`
 * returns — no `await` between `seed` and the first buffered-byte `write`,
 * so no live byte can interleave the seed.
 */
export interface TerminalSink {
  /**
   * Seed the view with rendered cells captured from tmux. Called exactly
   * once per `attach()`. The text is the joined output of `capture-pane`
   * (`\r\n` between rows) — already normalised to UTF-8 by tmux, so
   * `string` is the accurate type. Live binary bytes go through `write()`.
   *
   * The cursor lands wherever the captured text naturally ends. Cursor
   * positioning is tmux's responsibility — any program that cares about
   * cursor placement emits its own CUP escape in the live byte stream;
   * sinks never synthesise one from a side-channel query.
   */
  seed(captured: string): void;

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
   * Drop everything the renderer is holding (scrollback, current screen).
   * Used by tests and by callers that want to re-attach a stream to a
   * cleared view without disposing the sink. NOT called on detach() —
   * `PaneStream` does not own clearing decisions.
   */
  clear(): void;

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
