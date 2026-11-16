// src/window-terminal/index.ts
//
// `@promptctl/tmux-control-mode-js/window-terminal` — one tmux window, live,
// in an element: `mountWindowTerminal(element, { connection, window })`.

import { createCellMeasure } from "./sizing/cell-metrics.js";
import {
  createWindowTerminal,
  type WindowTerminal,
  type WindowTerminalOptions,
} from "./terminal.js";

export type { WindowTerminal, WindowTerminalOptions } from "./terminal.js";
export type { PaneId, WindowId } from "./ids.js";
export { parsePaneId, parseWindowId } from "./ids.js";
export type { FontRange, Sizing } from "./options.js";
export type { XtermAddons, XtermOptions } from "./render/xterm-options.js";
export type { TerminalConnection } from "./engine/pane-stream.js";
export type {
  PaneRect,
  PaneView,
  WindowFlags,
  WindowTerminalError,
  WindowTerminalState,
  WindowView,
} from "./engine/window-model.js";

export function mountWindowTerminal(
  element: HTMLElement,
  options: WindowTerminalOptions,
): WindowTerminal {
  const win = element.ownerDocument.defaultView;
  if (win === null) {
    throw new RangeError("element must be in a document with a window");
  }
  return createWindowTerminal(element, options, {
    measure: () => createCellMeasure(win),
    frame: (cb) => {
      const id = win.requestAnimationFrame(cb);
      return () => win.cancelAnimationFrame(id);
    },
    now: () => Date.now(),
  });
}
