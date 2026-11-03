// examples/web-multiplexer/web/refresh-policy.test.ts
//
// %layout-change carries pane geometry, so the fast path applies it without a
// list-panes round-trip — except for what the layout lacks (tmux-pane-detail-aha.y69).

import { describe, it, expect } from "vitest";
import type {
  CommandResponse,
  TmuxMessage,
} from "@promptctl/tmux-control-mode-js";
import { windowLayoutFields } from "@promptctl/tmux-control-mode-js/protocol";
import { layoutPaneDimensions, RefreshPolicy } from "./refresh-policy.ts";
import { TmuxModel } from "./tmux-model.ts";
import type { TmuxBridge } from "./bridge.ts";

// Two side-by-side panes %1 | %2 in a 160x40 window (checksums are tmux's).
const TILED = "8343,160x40,0,0{80x40,0,0,1,79x40,81,0,2}";
// The visible layout while %2 is zoomed.
const ZOOMED_2 = "abff,160x40,0,0,2";

function layoutChange(
  layout: string,
  visible: string,
): Extract<TmuxMessage, { type: "layout-change" }> {
  return {
    type: "layout-change",
    windowId: 7,
    ...windowLayoutFields(layout, visible, visible === layout ? "*" : "*Z"),
  };
}

describe("layoutPaneDimensions", () => {
  it("takes every tiled pane's size from an unzoomed layout", () => {
    const r = layoutPaneDimensions(layoutChange(TILED, TILED), [1, 2]);
    expect([...r.updates]).toEqual([
      [1, { w: 80, h: 40 }],
      [2, { w: 79, h: 40 }],
    ]);
    expect(r.needsListPanes).toBe(false);
  });

  it("gives the zoomed pane the full window and keeps the others pre-zoom", () => {
    const r = layoutPaneDimensions(layoutChange(TILED, ZOOMED_2), [1, 2]);
    expect(r.updates.get(1)).toEqual({ w: 80, h: 40 });
    expect(r.updates.get(2)).toEqual({ w: 160, h: 40 });
    expect(r.needsListPanes).toBe(false);
  });

  it("needs list-panes for a known pane the layout omits (floating)", () => {
    const r = layoutPaneDimensions(layoutChange(TILED, TILED), [1, 2, 3]);
    expect(r.needsListPanes).toBe(true);
  });

  it("needs list-panes when the layout is malformed", () => {
    const r = layoutPaneDimensions(layoutChange("0000,garbage", TILED), [1, 2]);
    expect(r.needsListPanes).toBe(true);
  });
});

describe("RefreshPolicy on layout-change", () => {
  function setup(paneIds: number[]): {
    policy: RefreshPolicy;
    model: TmuxModel;
    commands: string[];
  } {
    const commands: string[] = [];
    const bridge = {
      execute: (command: string): Promise<CommandResponse> => {
        commands.push(command);
        return Promise.resolve({
          commandNumber: 0,
          timestamp: 0,
          output: [],
          success: true,
        });
      },
    } as unknown as TmuxBridge;
    const model = new TmuxModel();
    model.sessions = [
      {
        id: 0,
        name: "s",
        attached: true,
        windows: [
          {
            id: 7,
            index: 0,
            name: "w",
            active: true,
            zoomed: false,
            panes: paneIds.map((id, index) => ({
              id,
              index,
              active: index === 0,
              title: "",
              width: 1,
              height: 1,
            })),
          },
        ],
      },
    ];
    return { policy: new RefreshPolicy(bridge, model), model, commands };
  }

  it("patches sizes from a zoomed layout without a round-trip", () => {
    const { policy, model, commands } = setup([1, 2]);
    policy.handleEvent(layoutChange(TILED, ZOOMED_2));
    const panes = model.sessions[0].windows[0].panes;
    expect(panes.map((p) => [p.id, p.width, p.height])).toEqual([
      [1, 80, 40],
      [2, 160, 40],
    ]);
    expect(commands).toEqual([]);
  });

  it("falls back to list-panes for a window with a floating pane", () => {
    const { policy, commands } = setup([1, 2, 3]);
    policy.handleEvent(layoutChange(TILED, TILED));
    expect(commands).toEqual([
      "list-panes -t @7 -F '#{pane_id}|#{pane_width}|#{pane_height}'",
    ]);
  });
});
