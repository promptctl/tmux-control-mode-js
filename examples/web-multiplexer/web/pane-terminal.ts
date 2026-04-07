// examples/web-multiplexer/web/pane-terminal.ts
//
// PaneTerminal — one per tmux pane the UI is showing. A plain class (not a
// React component) that owns an xterm.js Terminal and an independent slice
// of reactive state. It is instantiated from a `useMemo` keyed on pane.id
// inside <PaneView>, then `.mount(container)`-ed and `.dispose()`-d via
// useEffect lifecycle.
//
// Why a class and not a hook stew:
//  - The xterm lifecycle is imperative at the edges (constructor / open /
//    write / resize / dispose). Wrapping that in a class keeps the
//    imperative code cohesive and testable.
//  - The reactive derivations (font size, resize, seeding state machine)
//    live inside MobX reactions declared in `mount()`. React's useEffect
//    dependency arrays do not model "derive side effect from observable
//    state" cleanly; `reaction()` does.
//  - State machine (seeding → live) needs a stable owner that survives
//    container resize. A class is that owner.
//
// State machine:
//
//    new PaneTerminal()   state = idle
//        │
//        │ mount(container)
//        ▼
//    register onEvent listener (begins buffering)
//    register MobX reactions
//    state = seeding   ──►   capture-pane -e -p -S -
//                               │
//                               ▼
//                         write capture, drain buffer, flip to live
//                         (synchronous; no await)
//        │
//        │ state = live   ──►   onEvent writes directly to xterm
//        │
//        │ dispose()
//        ▼
//    state = disposed, all handlers detached, term.dispose()

import { reaction, observable, runInAction, type IReactionDisposer } from "mobx";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { decodeBase64, BridgeClient } from "./ws-client.ts";
import type { DemoStore, PaneInfo } from "./store.ts";
import type { SerializedTmuxMessage } from "../shared/protocol.ts";

type LifeState = "idle" | "seeding" | "live" | "disposed";

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
const FONT_MAX = 20;
const FONT_COMFORTABLE = 13;

/**
 * Largest integer font size in [FONT_MIN, FONT_MAX] such that cols × rows
 * fits within containerW × containerH. Returns the clamped value even when
 * the ideal size is below FONT_MIN (callers may surface an "oversized"
 * affordance in that case).
 */
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
 * Given container pixel size, compute the comfortable (cols, rows) that
 * would fit at FONT_COMFORTABLE (13 px). Used by the "Resize pane to fit
 * browser" button.
 */
export function comfortableDimensionsForContainer(
  containerW: number,
  containerH: number,
): { cols: number; rows: number } {
  const { charW, charH } = getBaseMetrics();
  const scale = FONT_COMFORTABLE / 12;
  const cols = Math.max(1, Math.floor(containerW / (charW * scale)));
  const rows = Math.max(1, Math.floor(containerH / (charH * scale)));
  return { cols, rows };
}

// ---------------------------------------------------------------------------
// PaneTerminal
// ---------------------------------------------------------------------------

export class PaneTerminal {
  readonly paneId: number;
  private readonly store: DemoStore;
  private readonly client: BridgeClient;

  // Observable container box, set by a ResizeObserver inside `mount()`.
  // The size reaction reads this AND the store's pane width/height.
  private readonly containerBox = observable({ w: 0, h: 0 });

  // Observable "oversized" flag surfaced on the store's pane record so the
  // toolbar can highlight the resize button.
  readonly status = observable({
    oversized: false,
    currentFontSize: FONT_COMFORTABLE,
    appliedCols: 0,
    appliedRows: 0,
  });

  private term: Terminal | null = null;
  private fit: FitAddon | null = null;
  private containerEl: HTMLElement | null = null;
  private ro: ResizeObserver | null = null;
  private unsubEvent: (() => void) | null = null;
  private disposers: IReactionDisposer[] = [];
  private state: LifeState = "idle";
  private buffer: Uint8Array[] = [];

  constructor(paneId: number, store: DemoStore) {
    this.paneId = paneId;
    this.store = store;
    this.client = store.client;
  }

  /**
   * Mount this PaneTerminal into a DOM container. Opens an xterm.js
   * Terminal inside it, registers the live-event listener (buffering
   * mode), kicks off capture-pane for the seed, and installs the MobX
   * reaction that keeps font size in sync with (pane dimensions,
   * container dimensions). Idempotent: calling mount twice on the same
   * instance is a no-op after the first call.
   */
  mount(container: HTMLElement): void {
    if (this.state !== "idle") return;
    this.containerEl = container;

    const term = new Terminal({
      convertEol: false,
      cursorBlink: true,
      fontFamily: FONT_FAMILY,
      fontSize: FONT_COMFORTABLE,
      scrollback: 10000,
      theme: { background: "#0b1120" },
      // We drive cols/rows manually from tmux; xterm's initial 80×24
      // will be overwritten by the first sizing reaction.
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    this.term = term;
    this.fit = fit;

    // Keystrokes → tmux send-keys on this pane.
    term.onData((data) => {
      if (this.state === "disposed") return;
      this.store.sendKeysToPane(this.paneId, data);
    });

    // Live event subscription. In "seeding" state bytes go to the buffer;
    // in "live" state bytes go straight to xterm. No event is ever
    // dropped: the listener is registered before capture-pane is sent.
    this.unsubEvent = this.client.onEvent((ev: SerializedTmuxMessage) => {
      if (this.state === "disposed") return;
      if (
        (ev.type === "output" || ev.type === "extended-output") &&
        ev.paneId === this.paneId
      ) {
        const bytes = decodeBase64(ev.dataBase64);
        if (this.state === "live") {
          term.write(bytes);
        } else {
          this.buffer.push(bytes);
        }
      }
    });

    // Container size observer → observable box.
    this.ro = new ResizeObserver((entries) => {
      if (this.state === "disposed") return;
      const r = entries[0].contentRect;
      runInAction(() => {
        this.containerBox.w = r.width;
        this.containerBox.h = r.height;
      });
    });
    this.ro.observe(container);

    // THE sizing reaction. Declared once; fires whenever pane dims OR
    // container dims change.
    //
    // [LAW:dataflow-not-control-flow] Derived state: font size and term
    // cols/rows are a pure function of (tmux pane w/h, container w/h).
    // The reaction declares that dependency and runs applySizing as the
    // effect. Nowhere else in the codebase does xterm get resized.
    this.disposers.push(
      reaction(
        () => {
          const p = this.findPane();
          return {
            cols: p?.width ?? 0,
            rows: p?.height ?? 0,
            cw: this.containerBox.w,
            ch: this.containerBox.h,
          };
        },
        ({ cols, rows, cw, ch }) => {
          if (cols <= 0 || rows <= 0 || cw <= 0 || ch <= 0) return;
          this.applySizing(cols, rows, cw, ch);
        },
        { fireImmediately: true },
      ),
    );

    // Begin the seed. This is async; events that arrive during it are
    // buffered by the onEvent listener above, then drained inside
    // finishSeed() synchronously.
    this.state = "seeding";
    void this.seed();
  }

  /**
   * Seed xterm with tmux's current pane state:
   *   1. capture-pane -e -p -S -   → full scrollback + visible screen
   *   2. display-message -p '...'  → the pane's current cursor (x, y)
   *
   * After writing the capture, emit an ANSI cursor-positioning escape so
   * xterm's cursor lands where tmux says it actually is — not at the
   * bottom of the captured buffer. Without this, typing after load
   * appears to happen on the last row instead of at the shell prompt.
   *
   * Then drain the buffered live events and flip to live mode. Everything
   * after the `await` is synchronous so no event can interleave.
   */
  private async seed(): Promise<void> {
    try {
      const [captureResp, cursorResp] = await Promise.all([
        // -e: include escapes; -p: print to stdout; -S -: from start of
        // history to visible screen bottom. Complete scrollback + current
        // visible rows in one command.
        this.client.execute(`capture-pane -e -p -S - -t %${this.paneId}`),
        // Query cursor position directly from tmux. Format vars cursor_x
        // and cursor_y are 0-indexed from the top-left of the visible
        // pane screen; we'll convert to 1-indexed for the ANSI CUP escape.
        this.client.execute(
          `display-message -p -t %${this.paneId} '#{cursor_x};#{cursor_y}'`,
        ),
      ]);
      if (this.state === "disposed") return;
      if (this.term === null) return;
      const term = this.term;

      // Join captured lines with CR/LF so xterm treats them as real row
      // breaks. tmux strips the trailing newline from each captured line.
      const captured = captureResp.output.join("\r\n");

      // Parse "<x>;<y>" from the cursor response. Guard against an empty
      // or malformed reply by defaulting to the bottom-right of the
      // visible area (which matches where the capture ends anyway, so
      // the cursor move becomes a no-op in that case).
      const cursorLine = cursorResp.output[0] ?? "";
      const match = cursorLine.match(/^(\d+);(\d+)$/);
      const cursorX = match !== null ? parseInt(match[1], 10) : -1;
      const cursorY = match !== null ? parseInt(match[2], 10) : -1;

      // [LAW:single-enforcer] The whole transition from "seeding" to
      // "live" lives here. Synchronous: no await between the first
      // write and the mode flip, so no event can interleave.
      term.write(captured);

      if (cursorX >= 0 && cursorY >= 0) {
        // ANSI Cursor Position (CUP): `\x1b[<row>;<col>H`. 1-indexed.
        // tmux's cursor_y/cursor_x are 0-indexed within the visible
        // screen; add 1 for the ANSI conversion.
        term.write(`\x1b[${cursorY + 1};${cursorX + 1}H`);
      }

      // Drain any events that arrived while we were awaiting the seed.
      for (const bytes of this.buffer) {
        term.write(bytes);
      }
      this.buffer = [];
      this.state = "live";
    } catch (err) {
      if (this.state !== "disposed") {
        this.state = "live"; // allow events to flow even if the seed failed
        console.error("[pane-terminal] seed failed:", err);
      }
    }
  }

  /**
   * Compute font size and apply it. Also calls `term.resize(cols, rows)`
   * so absolute cursor positioning in apps like Claude Code lands on the
   * right cells.
   */
  private applySizing(
    cols: number,
    rows: number,
    containerW: number,
    containerH: number,
  ): void {
    if (this.term === null || this.fit === null) return;
    const term = this.term;

    const font = fitFontSize(cols, rows, containerW, containerH);
    term.options.fontSize = font;
    // xterm recalculates cell metrics when fontSize changes, then we
    // force the cols/rows to match tmux exactly.
    term.resize(cols, rows);

    // FitAddon would normally choose cols/rows from font+container. We
    // don't want that — cols/rows come from tmux. But fit.fit() also
    // reflows the rendered cell pixel sizes to match the new font, which
    // we DO want. Call it and then re-assert our cols/rows if it drifted.
    try {
      this.fit.fit();
      if (term.cols !== cols || term.rows !== rows) {
        term.resize(cols, rows);
      }
    } catch {
      /* container not yet laid out; harmless */
    }

    runInAction(() => {
      this.status.currentFontSize = font;
      this.status.appliedCols = cols;
      this.status.appliedRows = rows;
      // "Oversized" = the tmux pane is too big to fit at a comfortable
      // (≥ 10 px) font size. That's the signal to highlight the toolbar
      // resize button.
      this.status.oversized = font < 10;
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

  dispose(): void {
    if (this.state === "disposed") return;
    this.state = "disposed";
    for (const d of this.disposers) d();
    this.disposers = [];
    this.ro?.disconnect();
    this.ro = null;
    this.unsubEvent?.();
    this.unsubEvent = null;
    try {
      this.term?.dispose();
    } catch {
      /* already gone */
    }
    this.term = null;
    this.fit = null;
    this.containerEl = null;
    this.buffer = [];
  }
}
