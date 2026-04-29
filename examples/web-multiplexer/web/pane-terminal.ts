// examples/web-multiplexer/web/pane-terminal.ts
//
// Demo-side adapter wiring an xterm.js Terminal into a library PaneSession.
//
// The seed→live state machine, the buffer drain, and the send-keys input
// pipe live in PaneSession (`src/pane-session.ts`). This file owns:
//   - the xterm Terminal instance and its DOM lifecycle,
//   - MobX-observable status fed to the toolbar (font size, applied dims),
//   - the ResizeObserver against the container,
//   - font-fit / pixel-to-cell math (measure-once + invert),
//   - the xterm-specific quirk that the very first synchronous resize after
//     `term.open()` throws inside Viewport.syncScrollArea — handled inside
//     the sink adapter, not in PaneSession.
//
// [LAW:single-enforcer] `applySizing` is the ONE site that drives xterm's
// dimensions. The MobX reaction below is the single source — neither React
// effects nor PaneSession ever call into xterm sizing directly.

import { reaction, observable, runInAction, type IReactionDisposer } from "mobx";
import { Terminal } from "@xterm/xterm";
import {
  PaneSession,
  type PaneSessionClient,
  type TerminalSink,
} from "../../../src/pane-session.js";
import type { TmuxBridge } from "./bridge.ts";
import type {
  ExtendedOutputMessage,
  OutputMessage,
  TmuxMessage,
} from "../../../src/protocol/types.js";
import type { DemoStore, PaneInfo } from "./store.ts";
import type { UiStore } from "./ui-store.ts";

// ---------------------------------------------------------------------------
// Font measurement — once per page, cached.
//
// At fontSize=12 in Menlo, we measure an 'M' and the line-height of a single
// line. These scale linearly with font size, so we can compute the max font
// that lets `cols × rows` fit in a given container without measuring every
// time.
// ---------------------------------------------------------------------------

// [LAW:one-source-of-truth] One font family string used everywhere —
// xterm's Terminal constructor, the measurement probe, and fallback
// consumers. "JetBrainsMono Nerd Font Mono" is bundled locally under
// web/fonts/ and loaded via web/fonts.css.
const FONT_FAMILY =
  '"JetBrainsMono Nerd Font Mono", "JetBrains Mono", Menlo, "DejaVu Sans Mono", monospace';

interface BaseMetrics {
  readonly charW: number; // pixels per column at fontSize=12
  readonly charH: number; // pixels per row at fontSize=12
}

let baseMetricsCache: BaseMetrics | null = null;

function measureOnce(): BaseMetrics {
  const probe = document.createElement("div");
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  probe.style.fontFamily = FONT_FAMILY;
  probe.style.fontSize = "12px";
  probe.style.lineHeight = "1.2";
  probe.style.whiteSpace = "pre";
  // 100 monospace M's so we average out subpixel rounding.
  probe.textContent = "M".repeat(100);
  document.body.appendChild(probe);
  const rect = probe.getBoundingClientRect();
  const charW = rect.width / 100;
  const charH = rect.height;
  document.body.removeChild(probe);
  return { charW, charH };
}

function getBaseMetrics(): BaseMetrics {
  if (baseMetricsCache !== null) return baseMetricsCache;
  baseMetricsCache = measureOnce();
  return baseMetricsCache;
}

/**
 * Force a re-measure (called after the custom font file has finished
 * loading — before that, `getBaseMetrics` would measure the fallback font
 * and produce stale numbers).
 */
function refreshBaseMetrics(): void {
  baseMetricsCache = measureOnce();
}

// Kick off font-loading on module import. When the JetBrains Mono Nerd
// Font file finishes loading, refresh the cached metrics so every
// subsequent sizing calculation uses the correct per-character pixel
// width. Panes that were sized before the font loaded will re-size on
// their next reaction fire (e.g. container resize or pane dim change).
if (typeof document !== "undefined" && "fonts" in document) {
  void document.fonts
    .load(`12px "JetBrainsMono Nerd Font Mono"`)
    .then(() => refreshBaseMetrics())
    .catch(() => {
      /* font unavailable; stick with fallback metrics */
    });
}

// ---------------------------------------------------------------------------
// Font size policy
// ---------------------------------------------------------------------------

const FONT_MIN = 6;
const FONT_MAX = 16;

/**
 * Largest integer font size in [FONT_MIN, FONT_MAX] such that cols × rows
 * fits within containerW × containerH. Returns the clamped value even when
 * the ideal size is below FONT_MIN (callers may surface an "oversized"
 * affordance in that case).
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function fitFontSize(
  cols: number,
  rows: number,
  containerW: number,
  containerH: number,
): number {
  const { charW, charH } = getBaseMetrics();
  // charW/charH are measured at 12 px. Per pixel of font size: charW/12 and charH/12.
  const maxByWidth = (containerW / cols) * (12 / charW);
  const maxByHeight = (containerH / rows) * (12 / charH);
  const ideal = Math.floor(Math.min(maxByWidth, maxByHeight));
  if (ideal < FONT_MIN) return FONT_MIN;
  if (ideal > FONT_MAX) return FONT_MAX;
  return ideal;
}

/**
 * Inverse of `fitFontSize`: given a target font size and container, return
 * the (cols, rows) that exactly fill the container at that font size.
 *
 * Used by the "Resize" toolbar button — clicking it computes the cols/rows
 * that would fill the container at FONT_MAX (16 px), then sends
 * `resize-pane` to tmux with those values. After tmux resizes, the
 * `applySizing` reaction picks the largest font in [FONT_MIN, FONT_MAX]
 * that fits — which will be FONT_MAX, by construction.
 *
 * Result: clicking Resize gives you the maximum reasonable font size with
 * the tmux pane filling the entire browser cell. No wasted pixels.
 */
export function dimensionsForContainer(
  containerW: number,
  containerH: number,
): { cols: number; rows: number } {
  const { charW, charH } = getBaseMetrics();
  const scale = FONT_MAX / 12;
  const cols = Math.max(1, Math.floor(containerW / (charW * scale)));
  const rows = Math.max(1, Math.floor(containerH / (charH * scale)));
  return { cols, rows };
}

// ---------------------------------------------------------------------------
// Bridge → PaneSessionClient adapter
// ---------------------------------------------------------------------------

/**
 * The renderer-side `TmuxBridge` collapses every server notification into a
 * single `onEvent` stream (one IPC channel for all events). PaneSession
 * wants a typed `on("output", h)` / `off("output", h)` surface so it can
 * register only what it needs and detach cleanly. This adapter routes the
 * bridge's fan-in stream to per-event listener sets.
 *
 * [LAW:locality-or-seam] This is the seam between the bridge's transport
 * shape and the library's PaneSessionClient contract. Per-pane filtering
 * happens INSIDE PaneSession (one paneId comparison per event); this layer
 * only narrows by event type.
 */
function bridgeAsPaneSessionClient(bridge: TmuxBridge): PaneSessionClient {
  const outputHandlers = new Set<(msg: OutputMessage) => void>();
  const extendedHandlers = new Set<(msg: ExtendedOutputMessage) => void>();

  // [LAW:single-enforcer] One bridge.onEvent registration; never grows.
  // Adding a third event type would extend this dispatch table, not add
  // a parallel registration.
  bridge.onEvent((ev: TmuxMessage) => {
    if (ev.type === "output") {
      for (const h of outputHandlers) h(ev);
    } else if (ev.type === "extended-output") {
      for (const h of extendedHandlers) h(ev);
    }
  });

  return {
    on(event: "output" | "extended-output", handler: never): void {
      if (event === "output") {
        outputHandlers.add(handler as (msg: OutputMessage) => void);
      } else {
        extendedHandlers.add(handler as (msg: ExtendedOutputMessage) => void);
      }
    },
    off(event: "output" | "extended-output", handler: never): void {
      if (event === "output") {
        outputHandlers.delete(handler as (msg: OutputMessage) => void);
      } else {
        extendedHandlers.delete(
          handler as (msg: ExtendedOutputMessage) => void,
        );
      }
    },
    execute(command) {
      return bridge.execute(command);
    },
    sendKeys(target, keys) {
      return bridge.sendKeys(target, keys);
    },
  } as PaneSessionClient;
}

// ---------------------------------------------------------------------------
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

  // Observable container box, set by a ResizeObserver inside `mount()`.
  // The size reaction reads this AND the store's pane width/height.
  private readonly containerBox = observable({ w: 0, h: 0 });

  // Observable status surfaced to the toolbar (font size, applied dims,
  // oversized affordance).
  readonly status = observable({
    oversized: false,
    currentFontSize: FONT_MAX,
    appliedCols: 0,
    appliedRows: 0,
  });

  private term: Terminal | null = null;
  private session: PaneSession | null = null;
  private containerEl: HTMLElement | null = null;
  private ro: ResizeObserver | null = null;
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
   * and installs the MobX reaction that keeps font size + cols/rows in
   * sync with (pane dimensions, container dimensions). Idempotent.
   */
  mount(container: HTMLElement): void {
    if (this.disposed || this.term !== null) return;
    this.containerEl = container;

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
      client: bridgeAsPaneSessionClient(this.client),
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

    // Container size observer → observable box.
    this.ro = new ResizeObserver((entries) => {
      if (this.disposed) return;
      const r = entries[0].contentRect;
      runInAction(() => {
        this.containerBox.w = r.width;
        this.containerBox.h = r.height;
      });
    });
    this.ro.observe(container);

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
      this.status.oversized = false;
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
   * Container dimensions last observed (used by the toolbar to compute
   * "comfortable size" for the resize button).
   */
  get containerDimensions(): { w: number; h: number } {
    return { w: this.containerBox.w, h: this.containerBox.h };
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
    this.ro?.disconnect();
    this.ro = null;
    this.session?.dispose();
    this.session = null;
    try {
      this.term?.dispose();
    } catch {
      /* already gone */
    }
    this.term = null;
    this.containerEl = null;
  }
}
