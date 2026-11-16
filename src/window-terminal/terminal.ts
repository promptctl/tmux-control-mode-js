// src/window-terminal/terminal.ts
//
// The window terminal's composition, with the page's effects (cell
// measurement, frames, the clock) as ports, so tests drive it without a
// layout engine. `mountWindowTerminal` (index.ts) supplies the page's.
//
// The engine follows the window and runs a stream per pane; the renderer
// draws the panes and reports the box; on any change one frame solves the
// sizing (font, cell, claim), applies the plan, and hands the claim to the
// declarer — only while live, since a stale picture is no ground for
// resizing anyone's window.
//
// [LAW:single-enforcer] One scheduled frame per change, whatever changed
//   (state, box, settings, font metrics): the one path from facts to pixels
//   and to the size claim.
// [LAW:parse-dont-validate] Every option is parsed at the call that passed
//   it, mount or `update`; a bad value throws `RangeError` there and changes
//   nothing.

import { WindowEngine } from "./engine/window-engine.js";
import type { TerminalConnection } from "./engine/pane-stream.js";
import type {
  WindowTerminalError,
  WindowTerminalState,
} from "./engine/window-model.js";
import {
  parsePaneId,
  parseWindowId,
  type PaneId,
  type WindowId,
} from "./ids.js";
import {
  DEFAULT_SIZING,
  parseHistory,
  parseSizing,
  type ResolvedSizing,
  type Sizing,
} from "./options.js";
import {
  givenOptions,
  parseXtermOptions,
  sameOption,
  type ParsedXterm,
  type XtermAddons,
  type XtermOptions,
} from "./render/xterm-options.js";
import { renderPlan } from "./render/render-plan.js";
import { WindowRenderer } from "./render/window-renderer.js";
import type { CellMeasure } from "./sizing/cell-metrics.js";
import { deliver, type Listener } from "./engine/deliver.js";
import { ClientSizeDeclarer } from "./sizing/client-size.js";
import { solve, type Box } from "./sizing/solve.js";

export interface WindowTerminalOptions {
  /** `TmuxClient`, `WebSocketTmuxClient` or the Electron renderer client. */
  readonly connection: TerminalConnection;
  readonly window: WindowId;
  /** Scrollback lines per pane, captured on arrival and kept. Default 2000. */
  readonly history?: number;
  /** Default `{ window: "box", font: 14 }`. */
  readonly sizing?: Sizing;
  /** xterm.js's options for every pane, less the ones the terminal owns. */
  readonly xterm?: XtermOptions;
  /** The addons every pane's xterm loads. Fixed at mount. */
  readonly addons?: XtermAddons;
}

export interface WindowTerminal {
  /**
   * Change the settings; a setting left out is unchanged. Identity
   * (connection, window, history) and the addons are fixed.
   */
  update(settings: {
    readonly sizing?: Sizing;
    readonly xterm?: XtermOptions;
  }): void;
  readonly state: WindowTerminalState;
  /** Calls `cb` with the current state now, then on every change. */
  onState(cb: (state: WindowTerminalState) => void): () => void;
  onError(cb: (error: WindowTerminalError) => void): () => void;
  /** Send this browser's keys to `pane`. Never moves tmux's active pane. */
  focus(pane: PaneId): void;
  dispose(): void;
}

/** What the composition takes from the page; a test passes its own. */
export interface WindowTerminalPorts {
  /** Called once the options have parsed; the terminal disposes what it returns. */
  readonly measure: () => CellMeasure;
  readonly frame: (cb: () => void) => () => void;
  readonly now: () => number;
}

export function createWindowTerminal(
  element: HTMLElement,
  options: WindowTerminalOptions,
  ports: WindowTerminalPorts,
): WindowTerminal {
  const { connection } = options;
  const windowId = parseWindowId(options.window);
  const history = parseHistory(options.history);
  let sizing: ResolvedSizing = parseSizing(options.sizing ?? DEFAULT_SIZING);
  let xterm: ParsedXterm = parseXtermOptions(options.xterm);
  const measure = ports.measure();
  let box: Box = { width: 0, height: 0 };
  let cancelFrame: (() => void) | null = null;
  let disposed = false;

  const errorListeners = new Set<Listener<WindowTerminalError>>();
  const reportError = (e: WindowTerminalError): void =>
    deliver(errorListeners, e);

  const renderer = new WindowRenderer(element, {
    history,
    xterm: xterm.given,
    addons: options.addons,
    font: sizing.font.max,
    onBox: (b) => {
      box = b;
      schedule();
    },
    onFocusPane: (pane) => engine.focus(pane),
  });
  const declarer = new ClientSizeDeclarer({
    connection,
    windowId,
    onError: (cause) => reportError({ seam: "declare-size", windowId, cause }),
  });
  const engine = new WindowEngine({
    connection,
    windowId,
    history,
    surfaces: renderer,
    now: ports.now,
  });

  function schedule(): void {
    if (disposed || cancelFrame !== null) return;
    cancelFrame = ports.frame(() => {
      cancelFrame = null;
      // [LAW:single-enforcer] The frame is where drawing runs, so its failure
      //   reaches onError here, not the page's global handler.
      try {
        render();
      } catch (cause) {
        reportError({ seam: "render", windowId, cause });
      }
    });
  }

  function render(): void {
    const state = engine.state;
    if (state.phase !== "live" && state.phase !== "stale") return;
    const cell = measure.cellAt(xterm.font);
    const solution = solve(sizing, box, cell, state.window.size);
    renderer.apply(renderPlan(state.window, solution));
    declarer.apply(state.phase === "live" ? solution.claim : { kind: "hold" });
  }

  const offEngineError = engine.onError(reportError);
  const offState = engine.onState(schedule);
  const offMetrics = measure.onChange(() => {
    renderer.remeasure();
    schedule();
  });

  return {
    update(settings) {
      // Both parsed before either applies: a bad value changes nothing.
      const nextSizing =
        settings.sizing === undefined ? sizing : parseSizing(settings.sizing);
      // The options in use are already parsed: a host passing an equal set
      // (an inline object, every render) costs no probe terminal.
      const nextXterm =
        settings.xterm === undefined ||
        sameOption(givenOptions(settings.xterm), xterm.given)
          ? xterm
          : parseXtermOptions(settings.xterm);
      if (disposed) return;
      sizing = nextSizing;
      xterm = nextXterm;
      // Each pane writes only the options that changed. Its failures reach
      // the host once every pane has the options: a listener that calls
      // `update` again starts from a whole window.
      const failures = renderer.setOptions(xterm.given);
      schedule();
      for (const { pane, cause } of failures) {
        reportError({ seam: "render", windowId, paneId: pane, cause });
      }
    },
    get state() {
      return engine.state;
    },
    onState: (cb) => engine.onState(cb),
    onError(cb) {
      errorListeners.add(cb);
      return () => errorListeners.delete(cb);
    },
    focus(pane) {
      const id = parsePaneId(pane);
      engine.focus(id);
      renderer.moveFocus(id);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelFrame?.();
      cancelFrame = null;
      offState();
      offEngineError();
      offMetrics();
      declarer.dispose();
      engine.dispose();
      renderer.dispose();
      measure.dispose();
      errorListeners.clear();
    },
  };
}
