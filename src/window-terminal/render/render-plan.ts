// src/window-terminal/render/render-plan.ts
//
// What the renderer draws, as a value: the font, the cell, the window's grid
// and each pane's cell rect and marks.
//
// [LAW:effects-at-boundaries] Pure; `WindowRenderer.apply` performs it.

import type { WindowView } from "../engine/window-model.js";
import type { PaneId } from "../ids.js";
import type { CellSize, Grid, Solution } from "../sizing/solve.js";

export interface PanePlan {
  readonly id: PaneId;
  readonly x: number;
  readonly y: number;
  readonly cols: number;
  readonly rows: number;
  /** Another pane is zoomed. */
  readonly hidden: boolean;
  /** tmux's active pane. */
  readonly active: boolean;
  /** Where this browser's keys go. */
  readonly focused: boolean;
}

export interface RenderPlan {
  readonly font: number;
  readonly cell: CellSize;
  /** tmux's grid for the window: what is drawn, whatever was declared. */
  readonly grid: Grid;
  /** In tmux's layout order. */
  readonly panes: readonly PanePlan[];
  readonly focus: PaneId;
}

export function renderPlan(view: WindowView, solution: Solution): RenderPlan {
  return {
    font: solution.font,
    cell: solution.cell,
    grid: view.size,
    focus: view.focus,
    panes: view.panes.map((p) => ({
      id: p.id,
      ...p.rect,
      hidden: view.zoomed !== null && p.id !== view.zoomed,
      active: p.id === view.active,
      focused: p.id === view.focus,
    })),
  };
}
