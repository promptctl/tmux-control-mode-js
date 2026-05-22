// packages/pane-terminal/src/xterm-sink/index.ts
//
// `XtermSink` — DOM-backed `TerminalSink` that drives an xterm.js `Terminal`.
// The single entry point in this package that touches the DOM and the heavy
// xterm peer dependency. Everything else (PaneStream, BufferingSink) is
// environment-agnostic.
//
// State invariants this class enforces:
//
//  1. The `Terminal` is constructed once in the constructor and disposed
//     once in `dispose()`. Style changes (font size, theme) flow through
//     xterm's in-place option setters; we never tear-down-and-rebuild
//     (O10).
//  2. Container resize never calls xterm directly. A `ResizeObserver`
//     writes the new container box into `box`, queues at most one rAF, and
//     the rAF runs `fitFont()` + the font-size update once per frame
//     regardless of how many resize events fired (O9).
//  3. The very first `term.resize()` is deferred by one rAF. Xterm's
//     `Viewport.syncScrollArea` dereferences a renderer-`dimensions` object
//     that is only instantiated on the first render tick — calling
//     `term.resize()` synchronously inside `term.open()` throws
//     "Cannot read properties of undefined (reading 'dimensions')".
//     This is the demo's hard-won lesson and stays load-bearing here.
//  4. `write(Uint8Array)` forwards directly to `term.write()` — no
//     `TextDecoder` in the live path. Gate 5's byte-fidelity guarantee
//     comes from this single line.
//  5. `dispose()` releases every observer/listener/timer and disposes the
//     `Terminal`. After dispose, every public method is a no-op.
//
// [LAW:locality-or-seam] PaneStream (the producer side of the seam) sees
//   only the `TerminalSink` interface declared in ../sink/index.ts; it has
//   no access to xterm or the DOM. Direct consumers of XtermSink — which
//   already bundle `@xterm/xterm` and the DOM by virtue of choosing this
//   sink — get an explicit escape hatch via the `terminal` field below
//   (xterm-addon mounting, custom decorators, viewport queries). The seam
//   that matters for the architecture is producer↔renderer, not
//   consumer↔renderer; the latter is intentionally permeable.
// [LAW:single-enforcer] One ResizeObserver per sink, one rAF coalescing
//   pending, one IntersectionObserver, one document-visibility listener.
//   No duplicate paths.
// [LAW:dataflow-not-control-flow] The constructor wires up observers
//   unconditionally; their callbacks update plain values; the rAF flush
//   reads those values and applies them. The same code path runs every
//   resize event regardless of count.

import { Terminal } from "@xterm/xterm";
import type { ITheme, IDisposable } from "@xterm/xterm";
import type { TerminalSink, SeedCursor } from "../sink/index.js";
import { fitFont as computeFitFont } from "./font-cache.js";

/**
 * Default monospace stack. The list is platform-spanning so XtermSink is
 * usable out of the box; consumers that bundle a custom font (e.g. the
 * demo's "JetBrainsMono Nerd Font Mono") pass it via `fontFamily`.
 */
const DEFAULT_FONT_FAMILY =
  '"JetBrains Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace';
const DEFAULT_FONT_SIZE = 14;
const DEFAULT_FONT_MIN = 6;
const DEFAULT_FONT_MAX = 16;
const DEFAULT_SCROLLBACK = 10000;
const FONT_WEIGHT = "normal";

export interface XtermSinkOptions {
  readonly container: HTMLElement;
  readonly fontFamily?: string;
  readonly fontSize?: number;
  readonly fontMin?: number;
  readonly fontMax?: number;
  readonly scrollback?: number;
  readonly theme?: {
    readonly background?: string;
    readonly foreground?: string;
  };
}

export class XtermSink implements TerminalSink {
  /**
   * Documented escape hatch for advanced consumers — addon mounting
   * (`@xterm/addon-search`, custom decorators), viewport queries, theme
   * inspection. The producer-side seam is `TerminalSink`; PaneStream never
   * sees this field. Touching it bypasses the wrapper's invariants
   * (rAF-coalesced resize, in-place option mutation), so reach for it
   * only when the wrapper genuinely doesn't expose what you need.
   */
  readonly terminal: Terminal;

  private readonly container: HTMLElement;
  private readonly fontFamily: string;
  private readonly fontMin: number;
  private readonly fontMax: number;

  // Tmux-reported pane geometry. Updated only by `resize()`.
  private cols = 0;
  private rows = 0;
  // Container-pixel box. Updated by the ResizeObserver.
  private boxW = 0;
  private boxH = 0;

  private isDisposed = false;
  private firstResizeDone = false;
  private firstResizeQueued = false;
  private rafResizePending = false;
  private rafResizeId: number | null = null;
  private rafFirstResizeId: number | null = null;
  // Seed content buffered when seed() arrives before the first terminal.resize().
  // Applied immediately after the first resize fires in its rAF, guaranteeing
  // that content is always written at the correct terminal dimensions.
  private pendingSeed: {
    captured: Uint8Array;
    cursor: SeedCursor | null;
  } | null = null;
  // Live bytes buffered before the first resize rAF. PaneStream drains its
  // seeding-window buffer synchronously immediately after seed() returns —
  // those write() calls must land *after* the seed in the xterm write queue.
  // pendingWrites holds them until the first-resize rAF fires and applies both
  // the seed and the trailing live bytes in the correct order. Nulled after
  // drain so subsequent write() calls bypass the buffer entirely.
  private pendingWrites: Uint8Array[] | null = [];

  private ro: ResizeObserver | null = null;
  private io: IntersectionObserver | null = null;
  private intersecting = true;
  private docVisible = true;

  private readonly onDocumentVisibility: () => void;
  private readonly onContainerResize: ResizeObserverCallback;
  private readonly onIntersection: IntersectionObserverCallback;
  private readonly flushBoundResize: () => void;

  constructor(opts: XtermSinkOptions) {
    this.container = opts.container;
    this.fontFamily = opts.fontFamily ?? DEFAULT_FONT_FAMILY;
    this.fontMin = opts.fontMin ?? DEFAULT_FONT_MIN;
    this.fontMax = opts.fontMax ?? DEFAULT_FONT_MAX;
    const fontSize = opts.fontSize ?? DEFAULT_FONT_SIZE;
    const scrollback = opts.scrollback ?? DEFAULT_SCROLLBACK;
    const theme = themeFor(opts.theme);

    // [LAW:single-enforcer] Terminal constructed once, disposed once. Style
    // mutations go through `terminal.options` setters below — never another
    // `new Terminal()`.
    this.terminal = new Terminal({
      convertEol: false,
      cursorBlink: true,
      fontFamily: this.fontFamily,
      fontSize,
      scrollback,
      theme,
      // We do NOT use FitAddon — `Viewport.syncScrollArea` dereferences a
      // renderer that's instantiated on first render tick; the addon's
      // post-`open()` resize would crash. cols/rows come from tmux via
      // `resize()`; the container only drives font fit.
    });
    this.terminal.open(this.container);

    // Pre-bound callbacks so we can `removeEventListener` / `disconnect`
    // with the same reference on dispose.
    this.flushBoundResize = () => this.flushRafResize();
    this.onContainerResize = (entries) => {
      if (this.isDisposed) return;
      const r = entries[0]?.contentRect;
      if (r === undefined) return;
      this.boxW = r.width;
      this.boxH = r.height;
      this.queueRafResize();
    };
    this.onIntersection = (entries) => {
      if (this.isDisposed) return;
      const e = entries[0];
      if (e === undefined) return;
      this.intersecting = e.isIntersecting;
    };
    this.onDocumentVisibility = () => {
      this.docVisible = isDocumentVisible();
    };

    // [LAW:dataflow-not-control-flow] Observers always run; their callbacks
    // write into instance fields; the rAF reads those fields. There is no
    // "if container is large enough" branch — the same code path runs.
    if (typeof ResizeObserver !== "undefined") {
      this.ro = new ResizeObserver(this.onContainerResize);
      this.ro.observe(this.container);
    }
    if (typeof IntersectionObserver !== "undefined") {
      this.io = new IntersectionObserver(this.onIntersection);
      this.io.observe(this.container);
    }
    if (typeof document !== "undefined") {
      this.docVisible = isDocumentVisible();
      document.addEventListener("visibilitychange", this.onDocumentVisibility);
    }
  }

  // ---------------------------------------------------------------------------
  // TerminalSink contract
  // ---------------------------------------------------------------------------

  seed(captured: Uint8Array, cursor: SeedCursor | null): void {
    if (this.isDisposed) return;
    if (!this.firstResizeDone) {
      // terminal.resize() is deferred to the first rAF. Writing content
      // before resize means xterm renders at wrong dimensions, then reflows
      // when resize fires — breaking the scroll area and misaligning the
      // CUP. Buffer instead; the first-resize rAF will call applySeed().
      // A second seed() call before the rAF fires simply overwrites (newer
      // content wins, same as any re-seed).
      this.pendingSeed = { captured, cursor };
      return;
    }
    this.applySeed(captured, cursor);
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
      // `SeedCursor.col`/`row` are 0-indexed (see ../sink/index.ts). Adding
      // 1 here is the only translation; sinks that don't position a hardware
      // cursor (BufferingSink) ignore the cursor entirely.
      this.terminal.write(
        `\x1b[${cursor.row + 1};${cursor.col + 1}H`,
        () => { if (!this.isDisposed) this.terminal.scrollToBottom(); },
      );
    } else {
      this.terminal.write(
        captured,
        () => { if (!this.isDisposed) this.terminal.scrollToBottom(); },
      );
    }
  }

  // [HOT-PATH] live byte forwarding — must not allocate per call.
  // `term.write(Uint8Array)` accepts the buffer by reference; no copy, no
  // decode. Gate 5 (non-UTF8 fidelity) is satisfied by the absence of any
  // TextDecoder on this path.
  write(data: Uint8Array): void {
    if (this.isDisposed) return;
    // [LAW:single-enforcer] pendingWrites is the sole gate for pre-first-resize
    // writes. PaneStream drains its seeding-window buffer synchronously after
    // seed() returns — those bytes must land after the seed in xterm's write
    // queue. We hold them here until the first-resize rAF applies both.
    if (this.pendingWrites !== null) {
      this.pendingWrites.push(data);
      return;
    }
    this.terminal.write(data);
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
        this.firstResizeDone = true;
        this.terminal.resize(this.cols, this.rows);
        // Apply any seed that arrived while the first resize was deferred.
        // Resize must precede the write so content is laid out at the correct
        // dimensions from the start (no reflow, no broken scroll area).
        if (this.pendingSeed !== null) {
          const { captured, cursor } = this.pendingSeed;
          this.pendingSeed = null;
          this.applySeed(captured, cursor);
        }
        // Drain any live bytes that arrived before the first resize completed.
        // These were buffered in pendingWrites to preserve ordering: seed
        // content always precedes live bytes in the xterm write queue.
        const writes = this.pendingWrites;
        this.pendingWrites = null;
        if (writes !== null) {
          for (const chunk of writes) {
            this.terminal.write(chunk);
          }
        }
      });
      return;
    }
    this.terminal.resize(cols, rows);
  }

  clear(): void {
    if (this.isDisposed) return;
    // `terminal.clear()` empties the screen + scrollback to a single row;
    // `terminal.reset()` would also reset modes/state, which is more than
    // the contract calls for. PaneStream uses this only when re-attaching
    // to a cleared view.
    this.terminal.clear();
  }

  isVisible(): boolean {
    if (this.isDisposed) return false;
    // Container off-screen OR tab hidden ⇒ not visible. The IO state defaults
    // to `true` until the IO callback fires (the default keeps single-pane
    // browsers without IO support — happy-dom — treating the sink as visible).
    return this.intersecting && this.docVisible;
  }

  dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;
    this.pendingSeed = null;
    this.pendingWrites = null;

    if (this.ro !== null) {
      this.ro.disconnect();
      this.ro = null;
    }
    if (this.io !== null) {
      this.io.disconnect();
      this.io = null;
    }
    if (typeof document !== "undefined") {
      document.removeEventListener(
        "visibilitychange",
        this.onDocumentVisibility,
      );
    }
    if (this.rafResizeId !== null) {
      cancelAnimationFrame(this.rafResizeId);
      this.rafResizeId = null;
    }
    if (this.rafFirstResizeId !== null) {
      cancelAnimationFrame(this.rafFirstResizeId);
      this.rafFirstResizeId = null;
    }
    this.rafResizePending = false;
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

  /**
   * Compute the largest integer font size in `[fontMin, fontMax]` that lets
   * the current `(cols, rows)` fit inside the current container box. Pure
   * arithmetic against the module-scope font cache — no DOM measurement.
   * Public so consumers (e.g. a "Resize to fit" toolbar action) can preview
   * the answer without forcing the rAF.
   */
  fitFont(): number {
    return computeFitFont({
      cols: this.cols,
      rows: this.rows,
      containerW: this.boxW,
      containerH: this.boxH,
      fontFamily: this.fontFamily,
      fontWeight: FONT_WEIGHT,
      fontMin: this.fontMin,
      fontMax: this.fontMax,
    });
  }

  /** In-place font-size set. NEVER reconstructs the Terminal. */
  setFontSize(px: number): void {
    if (this.isDisposed) return;
    if (this.terminal.options.fontSize === px) return;
    this.terminal.options.fontSize = px;
  }

  /** In-place theme merge. NEVER reconstructs the Terminal. */
  setTheme(theme: { background?: string; foreground?: string }): void {
    if (this.isDisposed) return;
    const merged: ITheme = {
      ...(this.terminal.options.theme ?? {}),
      ...themeFor(theme),
    };
    this.terminal.options.theme = merged;
  }

  /** Focus the underlying xterm. Safe after dispose (no-op). */
  focus(): void {
    if (this.isDisposed) return;
    this.terminal.focus();
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private queueRafResize(): void {
    if (this.rafResizePending) return;
    this.rafResizePending = true;
    this.rafResizeId = requestAnimationFrame(this.flushBoundResize);
  }

  private flushRafResize(): void {
    this.rafResizeId = null;
    this.rafResizePending = false;
    if (this.isDisposed) return;
    if (this.boxW <= 0 || this.boxH <= 0) return;
    if (this.cols <= 0 || this.rows <= 0) return;
    const px = this.fitFont();
    // Avoid touching xterm's options if the answer hasn't changed —
    // resize-storm test asserts this.
    if (this.terminal.options.fontSize === px) return;
    this.terminal.options.fontSize = px;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function themeFor(t?: { background?: string; foreground?: string }): ITheme {
  if (t === undefined) return {};
  const out: ITheme = {};
  if (t.background !== undefined) out.background = t.background;
  if (t.foreground !== undefined) out.foreground = t.foreground;
  return out;
}

function isDocumentVisible(): boolean {
  if (typeof document === "undefined") return true;
  // `visibilityState` may be undefined in tests with bare DOMs; treat
  // anything-other-than-"hidden" as visible.
  return document.visibilityState !== "hidden";
}
