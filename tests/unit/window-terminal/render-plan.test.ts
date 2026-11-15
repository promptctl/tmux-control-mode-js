import { describe, expect, it } from "vitest";
import type { WindowView } from "../../../src/window-terminal/engine/window-model.js";
import { renderPlan } from "../../../src/window-terminal/render/render-plan.js";
import type { Solution } from "../../../src/window-terminal/sizing/solve.js";

function view(over: Partial<WindowView> = {}): WindowView {
  return {
    id: "@1",
    name: "editor",
    size: { cols: 80, rows: 24 },
    flags: { bell: false, activity: false, silence: false },
    active: "%0",
    focus: "%1",
    zoomed: null,
    panes: [
      {
        id: "%0",
        title: "left",
        command: "zsh",
        rect: { x: 0, y: 0, cols: 40, rows: 24 },
        resyncing: false,
      },
      {
        id: "%1",
        title: "right",
        command: "vim",
        rect: { x: 41, y: 0, cols: 39, rows: 24 },
        resyncing: false,
      },
    ],
    ...over,
  };
}

const SOLUTION: Solution = {
  font: 13,
  cell: { width: 7.8, height: 15 },
  claim: { kind: "declare", grid: { cols: 120, rows: 40 } },
};

describe("renderPlan", () => {
  it("draws tmux's grid, not the declared one, with each pane at its layout cell", () => {
    const plan = renderPlan(view(), SOLUTION);
    expect(plan.font).toBe(13);
    expect(plan.cell).toEqual({ width: 7.8, height: 15 });
    expect(plan.grid).toEqual({ cols: 80, rows: 24 });
    expect(plan.focus).toBe("%1");
    expect(plan.panes).toEqual([
      {
        id: "%0",
        x: 0,
        y: 0,
        cols: 40,
        rows: 24,
        hidden: false,
        active: true,
        focused: false,
      },
      {
        id: "%1",
        x: 41,
        y: 0,
        cols: 39,
        rows: 24,
        hidden: false,
        active: false,
        focused: true,
      },
    ]);
  });

  it("a zoom hides every pane but the zoomed one, which keeps its place in order", () => {
    const plan = renderPlan(view({ zoomed: "%1", focus: "%1" }), SOLUTION);
    expect(plan.panes.map((p) => [p.id, p.hidden])).toEqual([
      ["%0", true],
      ["%1", false],
    ]);
  });
});
