// src/window-terminal/render/window-renderer.ts
//
// `WindowRenderer` — the DOM of one window terminal: a scrolling root in the
// consumer's element, a grid sized in cells, and one absolutely positioned
// pane element per pane holding its `XtermSink`. It is the engine's
// `PaneSurfaces`, applies `RenderPlan`s, reports the box it has, and turns
// focus entering a pane into the engine's pin.
//
// Layout is in cells: `--wt-cell-w` / `--wt-cell-h` on the grid, and every
// pane rect is `calc(n * var(--wt-cell-…))`, so one font change moves every
// pane by changing two values. Each xterm draws at its pane's top left. tmux
// leaves one cell between panes for its border; an outline in
// `--wt-border-color` (tmux's active pane: `--wt-active-border-color`) is drawn
// into it. Styles are inline: the only stylesheet is xterm's own
// (`@xterm/xterm/css/xterm.css`), which the consumer imports.
//
// [LAW:effects-at-boundaries] Every DOM effect of the terminal lives here;
//   what to draw arrives as a value.
// [LAW:one-source-of-truth] The window's grid is tmux's (`plan.grid`), never
//   the declared one: what is drawn is what tmux laid out.

import type { PaneSurface, PaneSurfaces } from "../engine/window-engine.js";
import type { PaneId } from "../ids.js";
import { parsePaneId } from "../ids.js";
import type { TerminalSink } from "../engine/terminal-sink.js";
import type { Box } from "../sizing/solve.js";
import type { RenderPlan } from "./render-plan.js";
import type { XtermAddons, XtermOptions } from "./xterm-options.js";
import { XtermSink } from "./xterm-sink.js";

export interface WindowRendererOptions {
  readonly history: number;
  readonly xterm: XtermOptions;
  readonly addons: XtermAddons | undefined;
  /** The font a pane opens at, before the first plan reaches it. */
  readonly font: number;
  /** The box the terminal has to draw in, on every change. */
  readonly onBox: (box: Box) => void;
  /** Focus entered `pane` (a click, a tab). */
  readonly onFocusPane: (pane: PaneId) => void;
  /**
   * `pane`'s xterm failed: to open (a host addon threw; it draws nothing), or
   * to take options xterm accepted (an addon refused them).
   */
  readonly onError: (pane: PaneId, cause: unknown) => void;
}

/** What the renderer drives in a pane. */
type PaneDrawing = TerminalSink &
  Pick<XtermSink, "onInput" | "setFont" | "setOptions" | "remeasure" | "focus">;

// [LAW:dataflow-not-control-flow] A pane with no xterm takes every call and
//   draws nothing, so nothing that drives panes asks which kind it has.
const NOTHING_DRAWN: PaneDrawing = {
  seed: () => undefined,
  write: () => undefined,
  resize: () => undefined,
  isVisible: () => false,
  dispose: () => undefined,
  onInput: () => () => undefined,
  setFont: () => undefined,
  setOptions: () => undefined,
  remeasure: () => undefined,
  focus: () => undefined,
};

interface PaneEl {
  readonly el: HTMLDivElement;
  readonly sink: PaneDrawing;
}

export class WindowRenderer implements PaneSurfaces {
  private readonly root: HTMLDivElement;
  private readonly grid: HTMLDivElement;
  private readonly panes = new Map<PaneId, PaneEl>();
  private readonly history: number;
  private readonly onFocusPane: (pane: PaneId) => void;
  private readonly observer: ResizeObserver;
  private readonly onError: (pane: PaneId, cause: unknown) => void;
  private readonly addons: XtermAddons | undefined;
  private xterm: XtermOptions;
  private font: number;
  // Set while this renderer moves DOM focus itself, so the focus it moves is
  // not read back as a person choosing a pane.
  private moving = false;

  private readonly onFocusIn = (ev: FocusEvent): void => {
    if (this.moving) return;
    const target = ev.target as Element | null;
    const pane = target?.closest<HTMLElement>("[data-pane-id]");
    if (pane === null || pane === undefined) return;
    this.onFocusPane(parsePaneId(pane.dataset.paneId));
  };

  constructor(host: HTMLElement, opts: WindowRendererOptions) {
    this.history = opts.history;
    this.xterm = opts.xterm;
    this.addons = opts.addons;
    this.onError = opts.onError;
    this.font = opts.font;
    this.onFocusPane = opts.onFocusPane;
    const doc = host.ownerDocument;

    this.root = doc.createElement("div");
    this.root.className = "wt-root";
    Object.assign(this.root.style, {
      position: "relative",
      width: "100%",
      height: "100%",
      overflow: "auto",
      // A scrollbar appearing must not shrink the box and re-size the window.
      scrollbarGutter: "stable",
    });
    this.grid = doc.createElement("div");
    this.grid.className = "wt-grid";
    Object.assign(this.grid.style, {
      position: "relative",
      width: "calc(var(--wt-cols) * var(--wt-cell-w))",
      height: "calc(var(--wt-rows) * var(--wt-cell-h))",
    });
    this.root.appendChild(this.grid);
    host.appendChild(this.root);

    this.root.addEventListener("focusin", this.onFocusIn);
    this.observer = new ResizeObserver((entries) => {
      const r = entries[entries.length - 1].contentRect;
      opts.onBox({ width: r.width, height: r.height });
    });
    this.observer.observe(this.root);
  }

  // -------------------------------------------------------------------------
  // PaneSurfaces
  // -------------------------------------------------------------------------

  create(pane: PaneId, keys: (bytes: Uint8Array) => void): PaneSurface {
    const el = this.grid.ownerDocument.createElement("div");
    el.className = "wt-pane";
    el.dataset.paneId = pane;
    Object.assign(el.style, {
      position: "absolute",
      overflow: "hidden",
      outline: "1px solid var(--wt-border-color, #555)",
    });
    this.grid.appendChild(el);
    const { sink, failures } = this.open(el);
    const offInput = sink.onInput(keys);
    this.panes.set(pane, { el, sink });
    // Reported once the pane is held: a listener that disposes the terminal
    // finds the renderer whole, and disposes this pane with the rest.
    for (const cause of failures) this.onError(pane, cause);
    return {
      sink,
      dispose: () => {
        offInput();
        sink.dispose();
        el.remove();
        this.panes.delete(pane);
      },
    };
  }

  // A pane's xterm, or nothing drawn where it failed to open (a host addon
  // threw): the pane is still the window's, an empty box, reported once.
  private open(el: HTMLDivElement): {
    readonly sink: PaneDrawing;
    readonly failures: readonly unknown[];
  } {
    let sink: XtermSink;
    try {
      sink = new XtermSink({
        container: el,
        fontSize: this.font,
        scrollback: this.history,
        xterm: this.xterm,
        addons: this.addons,
      });
    } catch (cause) {
      return { sink: NOTHING_DRAWN, failures: [cause] };
    }
    // The pane's own box clips the terminal to its cell rect; a viewport
    // scrollbar would cover its last columns. Wheel scrolling still works.
    const viewport =
      sink.terminal.element?.querySelector<HTMLElement>(".xterm-viewport");
    if (viewport !== null && viewport !== undefined) {
      viewport.style.scrollbarWidth = "none";
    }
    return { sink, failures: [] };
  }

  // -------------------------------------------------------------------------
  // Applying a plan
  // -------------------------------------------------------------------------

  apply(plan: RenderPlan): void {
    const s = this.grid.style;
    s.setProperty("--wt-cell-w", `${plan.cell.width}px`);
    s.setProperty("--wt-cell-h", `${plan.cell.height}px`);
    s.setProperty("--wt-cols", String(plan.grid.cols));
    s.setProperty("--wt-rows", String(plan.grid.rows));
    this.font = plan.font;
    // Read before reordering: moving the focused pane's element blurs it.
    const doc = this.root.ownerDocument;
    const keyboardHere = this.root.contains(doc.activeElement);

    plan.panes.forEach((p, i) => {
      const pane = this.panes.get(p.id);
      if (pane === undefined) return;
      const { el, sink } = pane;
      // Layout order is DOM order (tab order, and what assistive tech reads).
      if (this.grid.children[i] !== el) {
        this.grid.insertBefore(el, this.grid.children[i] ?? null);
      }
      Object.assign(el.style, {
        left: `calc(${p.x} * var(--wt-cell-w))`,
        top: `calc(${p.y} * var(--wt-cell-h))`,
        width: `calc(${p.cols} * var(--wt-cell-w))`,
        height: `calc(${p.rows} * var(--wt-cell-h))`,
        outlineColor: p.active
          ? "var(--wt-active-border-color, #6a6)"
          : "var(--wt-border-color, #555)",
      });
      el.hidden = p.hidden;
      el.dataset.active = String(p.active);
      el.dataset.focused = String(p.focused);
      sink.setFont(plan.font);
    });

    // DOM focus follows the plan only while the keyboard is in this terminal
    // and not already in the planned pane: a zoom, or a focused pane closing.
    // It is never taken from the rest of the page.
    if (
      keyboardHere &&
      !(this.panes.get(plan.focus)?.el.contains(doc.activeElement) ?? false)
    ) {
      this.moveFocus(plan.focus);
    }
  }

  /** Put the keyboard in `pane`. */
  moveFocus(pane: PaneId): void {
    const target = this.panes.get(pane);
    if (target === undefined) return;
    this.moving = true;
    try {
      target.sink.focus();
    } finally {
      this.moving = false;
    }
  }

  // A pane's xterm or addon that throws on an option xterm accepted is that
  // pane's failure, reported as a pane that fails to open is; every other
  // pane still takes the options.
  setOptions(xterm: XtermOptions): void {
    this.xterm = xterm;
    for (const [pane, { sink }] of this.panes) {
      try {
        sink.setOptions(xterm);
      } catch (cause) {
        this.onError(pane, cause);
      }
    }
  }

  /** Cell sizes changed under the same settings (a font loaded, a zoom). */
  remeasure(): void {
    for (const { sink } of this.panes.values()) sink.remeasure();
  }

  dispose(): void {
    this.observer.disconnect();
    this.root.removeEventListener("focusin", this.onFocusIn);
    for (const { sink } of this.panes.values()) sink.dispose();
    this.panes.clear();
    this.root.remove();
  }
}
