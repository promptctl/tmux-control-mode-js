// examples/web-multiplexer/web/pane-terminal.ts
//
// Demo-side adapter wiring an xterm.js Terminal into a library PaneSession.
//
// The seed→live state machine, the buffer drain, and the send-keys input
// pipe live in PaneSession (`src/pane-session.ts`). This file owns:
//   - the xterm Terminal instance and its DOM lifecycle,
//   - MobX-observable status fed to the toolbar (font size, applied dims),
//   - the xterm-specific quirk that the very first synchronous resize after
//     `term.open()` throws inside Viewport.syncScrollArea — handled inside
//     the sink adapter, not in PaneSession.
//
// Renderer-agnostic font measurement and pixel↔grid math used to live in
// this file; it now ships from the library at
// `@promptctl/tmux-control-mode-js/terminal` for any DOM consumer that
// needs to invert container pixels into tmux cols/rows.
//
// [LAW:single-enforcer] `applySizing` is the ONE site that drives xterm's
// dimensions. The MobX reaction below is the single source — neither React
// effects nor PaneSession ever call into xterm sizing directly.

import {
  reaction,
  observable,
  runInAction,
  type IReactionDisposer,
} from "mobx";
import { Terminal } from "@xterm/xterm";
import {
  PaneSession,
  type TerminalSink,
} from "../../../src/pane-session.js";
import { paneSessionClientFromBridge } from "../../../src/connectors/bridge/index.js";
import type { TmuxBridge } from "./bridge.ts";
import type { DemoStore, PaneInfo } from "./store.ts";
import type { UiStore } from "./ui-store.ts";

// [LAW:one-source-of-truth] One font family string used everywhere —
// xterm's Terminal constructor and any future measurement probe. The
// font file is bundled locally under web/fonts/ and loaded via
// web/fonts.css.
const FONT_FAMILY =
  '"JetBrainsMono Nerd Font Mono", "JetBrains Mono", Menlo, "DejaVu Sans Mono", monospace';

const FONT_MAX = 16;

// xterm sink adapter
// ---------------------------------------------------------------------------

const TEXT_ENCODER = new TextEncoder();

/**
 * Build a `TerminalSink` driving the given xterm `Terminal`. Owns one
 * xterm-specific quirk: the very first synchronous `term.resize()` after
 * `term.open()` throws because xterm's Viewport subscribes to onResize
 * inside open() and dereferences the renderer's `dimensions` before the
 * renderer has booted (renderer init runs on the first render tick, not
 * inside open()). Defer the first resize by one animation frame so the
 * renderer is up. Subsequent resizes go through directly.
 *
 * [LAW:locality-or-seam] The rAF deferral is sink-specific. PaneSession
 * sees a clean `sink.resize(cols, rows)` contract and stays renderer-
 * agnostic.
 */
function createXtermSink(term: Terminal): TerminalSink {
  let firstResizeApplied = false;
  return {
    write(bytes) {
      term.write(bytes);
    },
    // [LAW:dataflow-not-control-flow] Live writes go through writeAsync so
    // PaneSession's outstanding-chunk counter advances on each call and
    // decrements when xterm has parsed and rendered the chunk. xterm's
    // write callback is the single ack — when the renderer is paint-bound,
    // these callbacks back up, which is exactly the signal PaneSession
    // converts into a tmux-side pause via refresh-client -A %X:pause.
    writeAsync(bytes) {
      return new Promise<void>((resolve) => {
        term.write(bytes, () => resolve());
      });
    },
    resize(cols, rows) {
      if (!firstResizeApplied) {
        firstResizeApplied = true;
        requestAnimationFrame(() => term.resize(cols, rows));
        return;
      }
      term.resize(cols, rows);
    },
    onData(handler) {
      const d = term.onData((s) => handler(TEXT_ENCODER.encode(s)));
      return { dispose: () => d.dispose() };
    },
    focus() {
      term.focus();
    },
  };
}

// ---------------------------------------------------------------------------
// PaneTerminal — framework adapter
// ---------------------------------------------------------------------------

export class PaneTerminal {
  readonly paneId: number;
  private readonly store: DemoStore;
  private readonly uiStore: UiStore;
  private readonly client: TmuxBridge;

  // Observable status surfaced to the toolbar (font size, applied dims).
  readonly status = observable({
    currentFontSize: FONT_MAX,
    appliedCols: 0,
    appliedRows: 0,
  });

  private term: Terminal | null = null;
  private session: PaneSession | null = null;
  private disposers: IReactionDisposer[] = [];
  private disposed = false;

  constructor(paneId: number, store: DemoStore, uiStore: UiStore) {
    this.paneId = paneId;
    this.store = store;
    this.uiStore = uiStore;
    this.client = store.client;
  }

  /**
   * Mount this PaneTerminal into a DOM container. Opens an xterm.js
   * Terminal inside it, builds a PaneSession on top, kicks off the seed,
   * and installs the MobX reaction that applies tmux pane cols/rows with
   * the user's chosen font size. Idempotent.
   */
  mount(container: HTMLElement): void {
    if (this.disposed || this.term !== null) return;

    const term = new Terminal({
      convertEol: false,
      cursorBlink: true,
      fontFamily: FONT_FAMILY,
      fontSize: FONT_MAX,
      scrollback: 10000,
      theme: { background: "#0b1120" },
      // We drive cols/rows manually from tmux; xterm's initial 80×24
      // will be overwritten by the first sizing reaction.
    });
    // [LAW:no-mode-explosion] No FitAddon: we drive cols/rows from tmux
    // directly via the sink, and the user picks font size via the toolbar.
    term.open(container);
    this.term = term;

    // Keymap interception is NOT attached here. A per-xterm key handler
    // only fires while that specific xterm has focus, which is the wrong
    // scope for tmux-style shortcuts — pressing `C-b n` moves to the next
    // window and unmounts this xterm, so the FOLLOWING chord would fire on
    // a fresh (unfocused) xterm and do nothing. The demo attaches a
    // single document-level capture-phase keydown listener in App.tsx
    // instead; see store.handleKeyEvent for routing.
    //
    // PaneSession owns the "keystrokes the keymap ignored → tmux send-keys"
    // path: createXtermSink hooks `term.onData`, PaneSession calls
    // `client.sendKeys` for each chunk. Three lines of demo code disappear.

    const sink = createXtermSink(term);
    const session = new PaneSession({
      client: paneSessionClientFromBridge(this.client),
      paneId: this.paneId,
      sink,
    });
    this.session = session;

    // Surface the failure modes the library exposes. The demo currently
    // logs; production consumers might surface a UI affordance.
    session.on("seed-error", ({ cause }) => {
      console.error(`[pane-terminal %${this.paneId}] seed failed:`, cause);
    });
    session.on("seed-overflow", ({ droppedBytes }) => {
      console.warn(
        `[pane-terminal %${this.paneId}] seed buffer overflow, dropped ${droppedBytes} bytes`,
      );
    });

    void session.attach();

    // THE sizing reaction. Declared once; fires whenever pane dims OR
    // the user's chosen font size change.
    //
    // [LAW:dataflow-not-control-flow] Derived state: cols/rows come from
    // tmux via the topology subscription, font size from UiStore. Both
    // are observable. Reaction declares the dependency and runs
    // applySizing as the effect — once for the initial values
    // (fireImmediately) and again on each change. The xterm sink's
    // first-resize rAF deferral makes that initial synchronous fire
    // safe.
    this.disposers.push(
      reaction(
        () => {
          const p = this.findPane();
          return {
            cols: p?.width ?? 0,
            rows: p?.height ?? 0,
            font: this.uiStore.terminalFontSize,
          };
        },
        ({ cols, rows, font }) => {
          if (cols <= 0 || rows <= 0) return;
          this.applySizing(cols, rows, font);
        },
        { fireImmediately: true },
      ),
    );
  }

  /**
   * Apply the user's chosen font size and the tmux pane's cols × rows.
   * The container clips overflow if needed; the user chooses the font
   * size manually via the toolbar +/- buttons (no auto-fit math).
   */
  private applySizing(cols: number, rows: number, font: number): void {
    if (this.term === null || this.session === null) return;
    this.term.options.fontSize = font;
    this.session.resize(cols, rows);
    runInAction(() => {
      this.status.currentFontSize = font;
      this.status.appliedCols = cols;
      this.status.appliedRows = rows;
    });
  }

  /**
   * Look up the pane info from the store. Returns null if the pane is
   * no longer present (window closed, session killed, etc).
   */
  private findPane(): PaneInfo | null {
    for (const s of this.store.sessions) {
      for (const win of s.windows) {
        const p = win.panes.find((x) => x.id === this.paneId);
        if (p !== undefined) return p;
      }
    }
    return null;
  }

  /**
   * Focus the underlying xterm. Called by PaneCell whenever the owning
   * pane becomes the active pane — which happens on window switch, pane
   * click, or any keymap-driven focus change.
   */
  focus(): void {
    if (this.disposed) return;
    this.session?.focus();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const d of this.disposers) d();
    this.disposers = [];
    this.session?.dispose();
    this.session = null;
    try {
      this.term?.dispose();
    } catch {
      /* already gone */
    }
    this.term = null;
  }
}
