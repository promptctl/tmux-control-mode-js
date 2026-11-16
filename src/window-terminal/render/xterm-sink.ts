// src/window-terminal/render/xterm-sink.ts
//
// XtermSink — DOM-backed `TerminalSink` that drives an xterm.js `Terminal`.
// Which modules may touch the DOM at all is stated by tsconfig.dom.json's
// includes; the engine (PaneStream, BufferingSink) is environment-agnostic.
//
// This file owns the Terminal lifecycle. Two orthogonal concerns are delegated
// to collaborators:
//   - FirstResizeGate (first-resize-gate.ts) — the seed/live-byte ordering
//     buffer that spans the one-rAF first-resize defer.
//   - VisibilityTracker (visibility-tracker.ts) — on-screen visibility.
// The sink never sizes itself: cols/rows come from tmux through `resize()`,
// and the font size from whoever owns the layout through `setFont()`.
//
// State invariants this class enforces:
//
//  1. The `Terminal` is constructed once in the constructor and disposed
//     once in `dispose()`. Style changes (font, theme, line height, cursor)
//     flow through xterm's in-place option setters; we never
//     tear-down-and-rebuild (O10).
//  2. The very first `term.resize()` is deferred by one rAF. Xterm's
//     `Viewport.syncScrollArea` dereferences a renderer-`dimensions` object
//     that is only instantiated on the first render tick — calling
//     `term.resize()` synchronously inside `term.open()` throws
//     "Cannot read properties of undefined (reading 'dimensions')".
//     This is the demo's hard-won lesson and stays load-bearing here.
//  3. `write(Uint8Array)` forwards directly to `term.write()` — no
//     `TextDecoder` in the live path. The byte-fidelity guarantee
//     comes from this single line.
//  4. `dispose()` releases every observer/listener/timer and disposes the
//     `Terminal`. After dispose, every public method is a no-op.
//
// [LAW:locality-or-seam] PaneStream (the producer side of the seam) sees
//   only the `TerminalSink` interface declared in ../engine/terminal-sink.ts; it has
//   no access to xterm or the DOM. Direct consumers of XtermSink — which
//   already bundle `@xterm/xterm` and the DOM by virtue of choosing this
//   sink — get an explicit escape hatch via the `terminal` field below
//   (xterm-addon mounting, custom decorators, viewport queries). The seam
//   that matters for the architecture is producer↔renderer, not
//   consumer↔renderer; the latter is intentionally permeable.

import { Terminal } from "@xterm/xterm";
import type { IDisposable } from "@xterm/xterm";
import type { TerminalSink, SeedCursor } from "../engine/terminal-sink.js";
import type { Appearance } from "./appearance.js";
import { FirstResizeGate, type DrainBatch } from "./first-resize-gate.js";
import { VisibilityTracker } from "./visibility-tracker.js";

/**
 * Default monospace stack. The list is platform-spanning so XtermSink is
 * usable out of the box; consumers that bundle a custom font pass it as
 * `appearance.fontFamily`.
 */
export const DEFAULT_FONT_FAMILY =
  '"JetBrains Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace';
/** xterm.js's own default `lineHeight`. */
export const DEFAULT_LINE_HEIGHT = 1;

/** The font a cell is drawn in: what xterm draws and the solver measures. */
export function cellFont(a: Appearance): {
  readonly fontFamily: string;
  readonly lineHeight: number;
} {
  return {
    fontFamily: a.fontFamily ?? DEFAULT_FONT_FAMILY,
    lineHeight: a.lineHeight ?? DEFAULT_LINE_HEIGHT,
  };
}
const DEFAULT_FONT_SIZE = 14;
const DEFAULT_SCROLLBACK = 10000;

export interface XtermSinkOptions {
  readonly container: HTMLElement;
  readonly fontSize?: number;
  readonly scrollback?: number;
  readonly appearance?: Appearance;
}

export class XtermSink implements TerminalSink {
  /**
   * Documented escape hatch for advanced consumers — addon mounting
   * (`@xterm/addon-search`, custom decorators), viewport queries, theme
   * inspection. The producer-side seam is `TerminalSink`; PaneStream never
   * sees this field. Touching it bypasses the wrapper's invariants
   * (deferred first resize, in-place option mutation), so reach for it
   * only when the wrapper genuinely doesn't expose what you need.
   */
  readonly terminal: Terminal;

  private readonly container: HTMLElement;

  // Tmux-reported pane geometry. Updated only by `resize()`.
  private cols = 0;
  private rows = 0;

  private isDisposed = false;
  private firstResizeDone = false;
  private firstResizeQueued = false;
  private rafFirstResizeId: number | null = null;

  // Seed / live-byte ordering across the one-rAF first-resize defer.
  private readonly gate = new FirstResizeGate();
  // On-screen visibility (IntersectionObserver + document visibility).
  private readonly visibility: VisibilityTracker;

  constructor(opts: XtermSinkOptions) {
    this.container = opts.container;
    const a = opts.appearance ?? {};

    // [LAW:single-enforcer] Terminal constructed once, disposed once. Style
    // mutations go through `terminal.options` setters below — never another
    // `new Terminal()`.
    this.terminal = new Terminal({
      convertEol: false,
      cursorBlink: true,
      ...cellFont(a),
      fontSize: opts.fontSize ?? DEFAULT_FONT_SIZE,
      scrollback: opts.scrollback ?? DEFAULT_SCROLLBACK,
      theme: a.theme ?? {},
      ...(a.cursorStyle === undefined ? {} : { cursorStyle: a.cursorStyle }),
      // We do NOT use FitAddon — `Viewport.syncScrollArea` dereferences a
      // renderer that's instantiated on first render tick; the addon's
      // post-`open()` resize would crash. cols/rows come from tmux via
      // `resize()`.
    });
    this.terminal.open(this.container);

    this.visibility = new VisibilityTracker(this.container);
  }

  // ---------------------------------------------------------------------------
  // TerminalSink contract
  // ---------------------------------------------------------------------------

  seed(
    captured: Uint8Array,
    cursor: SeedCursor | null,
    trailing: readonly Uint8Array[],
  ): void {
    if (this.isDisposed) return;
    // The snapshot and its `trailing` live bytes are one ordered unit (see
    // TerminalSink.seed). Apply the snapshot, then route each trailing chunk
    // through `write()` so it shares the gate/cap path — the gate never needs to
    // interleave a separately-arriving seed with separately-arriving live bytes,
    // because they arrive together and in order here.
    if (this.gate.buffering) {
      // First resize not yet fired: hold the snapshot; the trailing chunks land
      // in the same gate buffer via write() below, after it. A later reseed
      // supersedes this snapshot and every byte buffered behind it.
      this.gate.bufferSeed({ captured, cursor });
    } else {
      // Gate open — apply the snapshot inline. This is authoritative by
      // construction, WITHOUT a clear: a reseed's `captured` is a snapshot
      // normalized to exactly `pane_height` rows (tested: PaneStream
      // "normalizes the seed to exactly pane_height rows") led by a screen-mode
      // preamble that homes the cursor, so writing it rewrites EVERY visible row
      // — no stale visible row can survive underneath. That holds equally for a
      // steady-state reseed and for one arriving in the post-cap-drain window
      // (gate opened early because the pane-size subscription was silent), so it
      // no longer rides on "this reseed's capture postdates the drained bytes"
      // folklore. Scrollback above the visible screen is deliberately preserved
      // (a clear would discard the history xterm accumulated during a drain).
      this.applySeed(captured, cursor);
    }
    for (const chunk of trailing) this.write(chunk);
  }

  private applySeed(captured: Uint8Array, cursor: SeedCursor | null): void {
    // xterm.write accepts Uint8Array; the seed is raw bytes (same as the live
    // path) and xterm is the single decoding authority. The CUP below is an
    // ASCII string — xterm.write accepts either form.
    //
    // scrollToBottom via the write callback: terminal.write() is internally
    // async (processes data in chunks across frames). The callback fires after
    // the data is fully parsed, ensuring the viewport scrolls to the current
    // screen AFTER the seed content is rendered — not before.
    if (cursor !== null) {
      this.terminal.write(captured);
      // ANSI Cursor Position (CUP): `\x1b[<row>;<col>H`, 1-indexed.
      // `SeedCursor.col`/`row` are 0-indexed (see ../engine/terminal-sink.ts). Adding
      // 1 here is the only translation; sinks that don't position a hardware
      // cursor (BufferingSink) ignore the cursor entirely.
      this.terminal.write(`\x1b[${cursor.row + 1};${cursor.col + 1}H`, () => {
        if (!this.isDisposed) this.terminal.scrollToBottom();
      });
    } else {
      this.terminal.write(captured, () => {
        if (!this.isDisposed) this.terminal.scrollToBottom();
      });
    }
  }

  // [HOT-PATH] live byte forwarding — must not allocate per call.
  // `term.write(Uint8Array)` accepts the buffer by reference; no copy, no
  // decode. Non-UTF8 fidelity is preserved by the absence of any
  // TextDecoder on this path.
  write(data: Uint8Array): void {
    if (this.isDisposed) return;
    // [LAW:single-enforcer] The gate is the sole owner of pre-first-resize
    // buffering. In steady state it is `open` and this branch is skipped, so
    // the hot path is a bare `term.write(data)` — no allocation. Only during
    // the brief startup window do writes route through the gate, which returns
    // a DrainBatch when the cap forces an early drain (the no-resize valve).
    if (this.gate.buffering) {
      const overflow = this.gate.bufferWrite(data);
      if (overflow !== null) this.performDrain(overflow);
      return;
    }
    this.terminal.write(data);
  }

  // Apply a batch the gate released: the pending seed (if any) then the
  // buffered live bytes, preserving seed-before-live ordering. term.write() is
  // safe before the first resize (only term.resize() dereferences the
  // not-yet-initialised renderer dimensions); content renders at xterm's
  // default geometry until a real resize arrives and reflows.
  private performDrain(batch: DrainBatch): void {
    // [LAW:composability] Self-guard the disposed state rather than trust each
    //   caller to have checked it — this helper writes to the terminal, so it
    //   owns the "no writes after dispose" invariant (invariant #4) locally and
    //   asks nothing of its callers. A disposed terminal must never be written.
    if (this.isDisposed) return;
    if (batch.seed !== null) {
      this.applySeed(batch.seed.captured, batch.seed.cursor);
    }
    for (const chunk of batch.writes) {
      this.terminal.write(chunk);
    }
  }

  resize(cols: number, rows: number): void {
    if (this.isDisposed) return;
    if (cols <= 0 || rows <= 0) return;
    this.cols = cols;
    this.rows = rows;

    if (!this.firstResizeDone) {
      // First-resize defer. Calling `term.resize()` synchronously inside or
      // immediately after `term.open()` throws because xterm's renderer
      // hasn't initialised its `dimensions` object yet — that happens on
      // the first render tick. Defer by one rAF; subsequent resizes are
      // synchronous because the renderer is now alive.
      if (this.firstResizeQueued) return;
      this.firstResizeQueued = true;
      this.rafFirstResizeId = requestAnimationFrame(() => {
        this.rafFirstResizeId = null;
        this.firstResizeQueued = false;
        if (this.isDisposed) return;
        if (this.cols <= 0 || this.rows <= 0) return;
        // [LAW:no-ambient-temporal-coupling] Advance the phase only AFTER the
        // resize it names actually happens. If `terminal.resize()` threw, the
        // flag would stay false, so the next resize() re-queues this rAF (a
        // retry) and the gate stays buffering (its byte cap still bounds the
        // no-resize path) — never a "past first resize but never released"
        // limbo.
        this.terminal.resize(this.cols, this.rows);
        this.firstResizeDone = true;
        // Resize precedes the drain so content lays out at the correct
        // dimensions from the start (no reflow, no broken scroll area). The
        // gate releases any pending seed, then the buffered live bytes in
        // order. If the cap already forced an early drain, the gate is open and
        // this returns an empty batch — the resize alone reflows.
        this.performDrain(this.gate.release());
      });
      return;
    }
    this.terminal.resize(cols, rows);
  }

  clear(): void {
    if (this.isDisposed) return;
    // `terminal.clear()` empties the screen + scrollback to a single row;
    // `terminal.reset()` would also reset modes/state, which is more than
    // the contract calls for.
    this.terminal.clear();
  }

  isVisible(): boolean {
    if (this.isDisposed) return false;
    // Container off-screen OR tab hidden ⇒ not visible. See VisibilityTracker
    // for the default-visible behavior in hosts without IntersectionObserver.
    return this.visibility.isVisible();
  }

  dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;
    this.gate.dispose();
    this.visibility.dispose();
    if (this.rafFirstResizeId !== null) {
      cancelAnimationFrame(this.rafFirstResizeId);
      this.rafFirstResizeId = null;
    }
    this.firstResizeQueued = false;

    // xterm.dispose() detaches DOM nodes and releases its internal listeners.
    // Our own `isDisposed` guard at the top of this method already prevents a
    // second call here, so any throw from xterm reflects a real disposal
    // failure (corrupt internal state, double-dispose from outside our
    // wrapper) — surfacing it is more useful than swallowing it.
    this.terminal.dispose();
  }

  // ---------------------------------------------------------------------------
  // Public extras (beyond TerminalSink)
  // ---------------------------------------------------------------------------

  /**
   * Subscribe to keystrokes the user types into the xterm DOM. The returned
   * function detaches the listener when called. Called by consumers that
   * want to forward keys to tmux via `PaneStream.sendKeys()`.
   */
  onData(handler: (data: string) => void): () => void {
    if (this.isDisposed) {
      return () => undefined;
    }
    const d: IDisposable = this.terminal.onData(handler);
    return () => d.dispose();
  }

  /** In-place font-size set. NEVER reconstructs the Terminal. */
  setFont(px: number): void {
    if (this.isDisposed) return;
    if (this.terminal.options.fontSize === px) return;
    this.terminal.options.fontSize = px;
  }

  /**
   * In-place look. NEVER reconstructs the Terminal. Each option is written
   * as given (a field left out returns to its default), and xterm re-measures
   * itself when the family changes.
   */
  setAppearance(a: Appearance): void {
    if (this.isDisposed) return;
    const o = this.terminal.options;
    const font = cellFont(a);
    o.fontFamily = font.fontFamily;
    o.lineHeight = font.lineHeight;
    o.theme = a.theme ?? {};
    o.cursorStyle = a.cursorStyle ?? "block";
  }

  /**
   * Make xterm measure its font again. xterm measures only when `fontFamily`
   * or `fontSize` changes value, so a webfont that finished loading after the
   * terminal opened leaves it on the fallback font's cell size; nudging the
   * size and back runs its own measurement twice and paints once.
   */
  remeasure(): void {
    if (this.isDisposed) return;
    const px = this.terminal.options.fontSize ?? DEFAULT_FONT_SIZE;
    this.terminal.options.fontSize = px + 1;
    this.terminal.options.fontSize = px;
  }

  /** Focus the underlying xterm. Safe after dispose (no-op). */
  focus(): void {
    if (this.isDisposed) return;
    this.terminal.focus();
  }
}
