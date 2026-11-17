// src/window-terminal/render/xterm-sink.ts
//
// XtermSink — DOM-backed `TerminalSink` that drives an xterm.js `Terminal`.
// Which modules may touch the DOM at all is stated by tsconfig.dom.json's
// includes; the engine (PaneStream, BufferingSink) is environment-agnostic.
//
// This file owns the Terminal lifecycle. On-screen visibility is delegated to
// VisibilityTracker (visibility-tracker.ts).
// The sink never sizes itself: cols/rows come from tmux through `resize()`,
// and the font size from whoever owns the layout through `setFont()`.
//
// State invariants this class enforces:
//
//  1. The `Terminal` is constructed once in the constructor and disposed
//     once in `dispose()` (or in the constructor, when opening it throws).
//     Option changes (the host's `XtermOptions`, the font size) flow
//     through xterm's in-place option setters; we never
//     tear-down-and-rebuild (O10).
//  2. `resize()`, `seed()` and `write()` reach xterm when they are called;
//     nothing is held back.
//  3. `write(Uint8Array)` forwards directly to `term.write()` — no
//     `TextDecoder` in the live path. The byte-fidelity guarantee
//     comes from this single line.
//  4. `dispose()` releases every observer/listener and disposes the
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
import type { IDisposable, ITerminalAddon } from "@xterm/xterm";
import type { TerminalSink } from "../engine/terminal-sink.js";
import {
  optionWrites,
  TERMINAL_DEFAULTS,
  type XtermAddons,
  type XtermOptions,
} from "./xterm-options.js";
import { VisibilityTracker } from "./visibility-tracker.js";
import { latin1ToBytes } from "../../protocol/index.js";
import type { CellRenderer } from "../sizing/cell-metrics.js";
import { TMUX_CELLS } from "./tmux-cells.js";

const utf8Encoder = new TextEncoder();

const DEFAULT_FONT_SIZE = 14;

// Dispose each of `owned`, then throw `err`. A dispose that throws as well
// is not lost: the error leaves as an AggregateError, `err` first.
function release(err: unknown, owned: readonly IDisposable[]): never {
  const failures: unknown[] = [];
  for (const d of owned) {
    try {
      d.dispose();
    } catch (e) {
      failures.push(e);
    }
  }
  throw failures.length === 0
    ? err
    : new AggregateError(
        [err, ...failures],
        "an xterm failed to open, and releasing it threw as well",
      );
}

export interface XtermSinkOptions {
  readonly container: HTMLElement;
  readonly fontSize?: number;
  /**
   * Lines of scrollback. Fed by a PaneStream, give it the stream's
   * `historyLines`: each seed replaces the scrollback with that many lines.
   */
  readonly scrollback: number;
  readonly xterm?: XtermOptions;
  readonly addons?: XtermAddons;
}

export class XtermSink implements TerminalSink {
  /**
   * Documented escape hatch for advanced consumers — custom decorators,
   * viewport queries, buffer inspection. Options and addons have their own
   * way in (`xterm`, `addons`). The producer-side seam is `TerminalSink`; PaneStream never
   * sees this field. Touching it bypasses the wrapper's invariants
   * (tmux's size, in-place option mutation), so reach for it
   * only when the wrapper genuinely doesn't expose what you need.
   */
  readonly terminal: Terminal;

  private readonly container: HTMLElement;

  private isDisposed = false;

  // On-screen visibility (IntersectionObserver + document visibility).
  private readonly visibility: VisibilityTracker;
  // Every option's value before any host option: xterm's default or the
  // terminal's. A host option left out returns to it.
  private readonly base: Readonly<Record<string, unknown>>;
  // The host options this pane has now.
  private applied: XtermOptions = {};
  // xterm's screen element, where a renderer draws: the DOM renderer its
  // rows, a renderer addon its canvases.
  private readonly screen: Element;
  // Fires when the screen's children change: a renderer took over.
  private readonly rendererListeners = new Set<() => void>();
  private readonly rendererObserver = new MutationObserver(() => {
    for (const cb of this.rendererListeners) cb();
  });

  constructor(opts: XtermSinkOptions) {
    this.container = opts.container;

    // [LAW:single-enforcer] Terminal constructed once, disposed once. Option
    // changes go through `terminal.options` setters (`setOptions`) — never
    // another `new Terminal()`.
    this.terminal = new Terminal({
      ...TERMINAL_DEFAULTS,
      convertEol: false,
      // The Unicode provider below is xterm's proposed API.
      allowProposedApi: true,
      fontSize: opts.fontSize ?? DEFAULT_FONT_SIZE,
      scrollback: opts.scrollback,
      // No FitAddon: cols/rows are tmux's, from `resize()`, never fitted to
      // the container.
    });
    // [LAW:one-source-of-truth] xterm fills every option of a terminal it
    //   constructed, so it supplies each reset value; the terminal keeps no
    //   table of xterm's defaults.
    this.base = { ...this.terminal.options };
    // The sink owns the terminal and every addon the factory made. If any
    // step throws, the terminal (and with it each addon xterm took, the one
    // whose activate threw included) and the addons it never took are
    // released before the error leaves.
    let addons: readonly ITerminalAddon[] = [];
    let taken = 0;
    try {
      // [LAW:single-enforcer] A character's cells are counted as tmux counts
      //   them, in every pane, before a byte is written.
      this.terminal.unicode.register(TMUX_CELLS);
      this.terminal.unicode.activeVersion = TMUX_CELLS.version;
      // Before the addons load: one may need an option.
      this.setOptions(opts.xterm ?? {});
      this.terminal.open(this.container);
      const screen = this.terminal.element?.querySelector(".xterm-screen");
      if (screen === null || screen === undefined) {
        throw new Error("xterm opened without a screen element");
      }
      this.screen = screen;
      addons = (opts.addons ?? (() => []))();
      for (const addon of addons) {
        taken += 1;
        this.terminal.loadAddon(addon);
      }
      const counted = this.terminal.unicode.activeVersion;
      if (counted !== TMUX_CELLS.version) {
        throw new Error(
          `an addon made xterm count cells by Unicode ${counted}; a pane counts them as tmux does`,
        );
      }
      // Watched once the terminal stands: the renderer it opened with is
      // read at the first layout, and only a later change needs telling.
      this.rendererObserver.observe(screen, { childList: true });
      this.visibility = new VisibilityTracker(this.container);
    } catch (err) {
      release(err, [this.terminal, ...addons.slice(taken)]);
    }
  }

  // ---------------------------------------------------------------------------
  // TerminalSink contract
  // ---------------------------------------------------------------------------

  seed(captured: Uint8Array, trailing: readonly Uint8Array[]): void {
    if (this.isDisposed) return;
    // The snapshot is authoritative by construction, WITHOUT terminal.clear():
    // `captured` carries its own clear in-band (see TerminalSink.seed), so it
    // is ordered behind every byte xterm has queued, where a synchronous
    // clear() would run ahead of them. It is then tmux's history plus a
    // screen normalized to exactly `pane_height` rows, so no stale row
    // survives in the buffer it draws into. Its `trailing` live bytes follow
    // it in order.
    //
    // xterm.write accepts Uint8Array; the seed is raw bytes (same as the live
    // path) and xterm is the single decoding authority.
    //
    // scrollToBottom via the write callback: terminal.write() is internally
    // async (processes data in chunks across frames). The callback fires after
    // the data is fully parsed, ensuring the viewport scrolls to the current
    // screen AFTER the seed content is rendered — not before.
    this.terminal.write(captured, () => {
      if (!this.isDisposed) this.terminal.scrollToBottom();
    });
    for (const chunk of trailing) this.terminal.write(chunk);
  }

  // [HOT-PATH] live byte forwarding — must not allocate per call.
  // `term.write(Uint8Array)` accepts the buffer by reference; no copy, no
  // decode. Non-UTF8 fidelity is preserved by the absence of any
  // TextDecoder on this path.
  write(data: Uint8Array): void {
    if (this.isDisposed) return;
    this.terminal.write(data);
  }

  resize(cols: number, rows: number): void {
    if (this.isDisposed) return;
    if (cols <= 0 || rows <= 0) return;
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
    this.visibility.dispose();
    this.rendererObserver.disconnect();
    this.rendererListeners.clear();

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
   * Subscribe to the bytes the user's input produces: keystrokes, pastes, and
   * the mouse reports xterm generates once the pane's program asks for mouse
   * tracking. The returned function detaches the listener. Called by consumers
   * that forward input to tmux via `sendKeyBytes()`.
   *
   * xterm emits input on two events: `onData` carries text (UTF-16, sent as
   * its UTF-8 bytes) and `onBinary` carries raw bytes, one per code unit — the
   * DEFAULT mouse encoding (`CSI M Cb Cx Cy`) always arrives there, with
   * coordinate bytes ≥ 0x80 that no text encoding round-trips.
   */
  onInput(handler: (bytes: Uint8Array) => void): () => void {
    if (this.isDisposed) {
      return () => undefined;
    }
    const subs: IDisposable[] = [
      this.terminal.onData((text) => handler(utf8Encoder.encode(text))),
      this.terminal.onBinary((data) => handler(latin1ToBytes(data))),
    ];
    return () => subs.forEach((d) => d.dispose());
  }

  /** In-place font-size set. NEVER reconstructs the Terminal. */
  setFont(px: number): void {
    if (this.isDisposed) return;
    if (this.terminal.options.fontSize === px) return;
    this.terminal.options.fontSize = px;
  }

  /**
   * In-place options. NEVER reconstructs the Terminal. Only an option whose
   * value changed is written, and one left out returns to its value before
   * any host option; xterm re-measures itself when the font changes.
   */
  setOptions(next: XtermOptions): void {
    if (this.isDisposed) return;
    const o = this.terminal.options as Record<string, unknown>;
    for (const [key, value] of optionWrites(this.applied, next, this.base)) {
      o[key] = value;
    }
    this.applied = next;
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

  /**
   * The renderer drawing this terminal now. A renderer addon (WebGL) draws
   * links on its own canvas in xterm's screen element,
   * `xterm-link-layer`; the DOM renderer draws none, and an addon that only
   * adds a layer (the image addon's `xterm-image-layer`) is not a renderer.
   */
  get renderer(): CellRenderer {
    return this.screen.querySelector("canvas.xterm-link-layer") === null
      ? "dom"
      : "canvas";
  }

  /**
   * Call `cb` when the renderer may have changed: a renderer addon loaded,
   * or one was disposed (a host that drops WebGL on context loss) and the
   * DOM renderer took the pane back. The returned function detaches it.
   */
  onRendererChange(cb: () => void): () => void {
    this.rendererListeners.add(cb);
    return () => this.rendererListeners.delete(cb);
  }

  /** Focus the underlying xterm. Safe after dispose (no-op). */
  focus(): void {
    if (this.isDisposed) return;
    this.terminal.focus();
  }
}
