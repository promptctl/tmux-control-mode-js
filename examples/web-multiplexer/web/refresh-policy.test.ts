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
import {
  encodeSnapshotLines,
  PANES_SUB,
  SESSIONS_SUB,
  WINDOWS_SUB,
} from "./snapshot-codec.ts";
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

  it("needs list-panes and reports why when the layout is malformed", () => {
    const bad = "0000,garbage";
    const r = layoutPaneDimensions(layoutChange(bad, bad), [1, 2]);
    expect(r.needsListPanes).toBe(true);
    expect(r.rejected).toHaveLength(2);
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
    model.applySnapshot(SESSIONS_SUB, "$0|s|1");
    model.applySnapshot(WINDOWS_SUB, "$0|@7|0|w|1|0");
    model.applySnapshot(
      PANES_SUB,
      encodeSnapshotLines(
        paneIds.map((id, i) => `@7|%${id}|${i}|${i === 0 ? 1 : 0}|1|1|t`),
      ),
    );
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

  it("keeps patched sizes across a rebuild that beats the panes tick", () => {
    const { policy, model } = setup([1, 2]);
    policy.handleEvent(layoutChange(TILED, TILED));
    model.applySnapshot(WINDOWS_SUB, "$0|@7|0|renamed|1|0");
    const panes = model.sessions[0].windows[0].panes;
    expect(panes.map((p) => [p.id, p.width, p.height, p.title])).toEqual([
      [1, 80, 40, "t"],
      [2, 79, 40, "t"],
    ]);
  });

  it("falls back to list-panes for a window with a floating pane", () => {
    const { policy, commands } = setup([1, 2, 3]);
    policy.handleEvent(layoutChange(TILED, TILED));
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatch(/^list-panes -t @7 /);
  });
});
