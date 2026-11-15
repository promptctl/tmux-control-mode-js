import { describe, expect, it } from "vitest";
import { windowLayoutFields } from "../../../src/protocol/index.js";
import type { ConnectionState } from "../../../src/browser.js";
import {
  deriveView,
  factsFromSnapshot,
  paneDiff,
  phaseFor,
  reduceWindow,
  type FocusPolicy,
  type Reduced,
  type WindowFacts,
  type WindowTerminalState,
  type WindowView,
} from "../../../src/window-terminal/engine/window-model.js";
import {
  ONE_PANE,
  THREE_PANES,
  TWO_PANES,
  ZOOMED_0,
} from "../../helpers/layout.js";

const FOLLOW: FocusPolicy = { kind: "follow-active" };
const NONE = new Set<never>();

function facts(r: Reduced): WindowFacts {
  if (r.kind !== "facts") throw new Error(r.reason);
  return r.facts;
}

function snapshot(
  layout = TWO_PANES,
  visible = layout,
  flags = "*",
): WindowFacts {
  return facts(
    factsFromSnapshot({
      id: "@1",
      name: "editor",
      active: "%1",
      flags: { bell: false, activity: false, silence: false },
      layout: windowLayoutFields(layout, visible, flags),
      meta: new Map([
        ["%0", { title: "left", command: "vim" }],
        ["%1", { title: "right", command: "zsh" }],
      ]),
    }),
  );
}

describe("window model — layout", () => {
  it("turns a layout into rects in layout order, the window size and each pane's meta", () => {
    const view = deriveView(snapshot(), FOLLOW, NONE);
    expect(view.size).toEqual({ cols: 80, rows: 24 });
    expect(view.panes).toEqual([
      {
        id: "%0",
        title: "left",
        command: "vim",
        rect: { x: 0, y: 0, cols: 40, rows: 24 },
        resyncing: false,
      },
      {
        id: "%1",
        title: "right",
        command: "zsh",
        rect: { x: 41, y: 0, cols: 39, rows: 24 },
        resyncing: false,
      },
    ]);
    expect(view.zoomed).toBeNull();
  });

  it("zoomed: every pane stays, the zoomed one at the whole window", () => {
    const view = deriveView(snapshot(TWO_PANES, ZOOMED_0, "*Z"), FOLLOW, NONE);
    expect(view.zoomed).toBe("%0");
    expect(view.panes.map((p) => p.id)).toEqual(["%0", "%1"]);
    expect(view.panes[0].rect).toEqual({ x: 0, y: 0, cols: 80, rows: 24 });
  });

  it("a split adds the pane; a close removes it and its meta", () => {
    const f = snapshot();
    const split = facts(
      reduceWindow(f, {
        kind: "layout",
        layout: windowLayoutFields(THREE_PANES, THREE_PANES, "*"),
      }),
    );
    expect(split.panes.map((p) => p.id)).toEqual(["%0", "%1", "%2"]);
    const closed = facts(
      reduceWindow(split, {
        kind: "layout",
        layout: windowLayoutFields(ONE_PANE, ONE_PANE, "*"),
      }),
    );
    expect(closed.panes.map((p) => p.id)).toEqual(["%0"]);
    expect([...closed.meta.keys()]).toEqual(["%0"]);
  });

  it("a malformed layout is refused, naming why", () => {
    const r = reduceWindow(snapshot(), {
      kind: "layout",
      layout: windowLayoutFields("zzzz,80x24", "zzzz,80x24", "*"),
    });
    expect(r.kind).toBe("malformed");
  });

  it("a zoomed flag without a visible pane is refused", () => {
    const r = reduceWindow(snapshot(), {
      kind: "layout",
      layout: windowLayoutFields(TWO_PANES, "garbage", "*Z"),
    });
    expect(r.kind).toBe("malformed");
  });

  it("follows the active pane, the name, the flags and a pane's meta", () => {
    let f = snapshot();
    f = facts(reduceWindow(f, { kind: "active", pane: "%0" }));
    f = facts(reduceWindow(f, { kind: "renamed", name: "logs" }));
    f = facts(
      reduceWindow(f, {
        kind: "flags",
        flags: { bell: true, activity: false, silence: true },
      }),
    );
    f = facts(
      reduceWindow(f, {
        kind: "pane-meta",
        pane: "%1",
        meta: { title: "build", command: "make" },
      }),
    );
    const view = deriveView(f, FOLLOW, NONE);
    expect(view.active).toBe("%0");
    expect(view.name).toBe("logs");
    expect(view.flags).toEqual({ bell: true, activity: false, silence: true });
    expect(view.panes[1]).toMatchObject({ title: "build", command: "make" });
  });

  it("paneDiff names the added and removed panes", () => {
    expect(paneDiff(["%0", "%1"], ["%1", "%2"])).toEqual({
      added: ["%2"],
      removed: ["%0"],
    });
  });

  it("marks the panes being resynced", () => {
    const view = deriveView(snapshot(), FOLLOW, new Set(["%1"] as const));
    expect(view.panes.map((p) => p.resyncing)).toEqual([false, true]);
  });
});

describe("window model — focus", () => {
  it("follows tmux's active pane until pinned", () => {
    expect(deriveView(snapshot(), FOLLOW, NONE).focus).toBe("%1");
  });

  it("a pin holds when tmux's active pane moves", () => {
    const f = facts(reduceWindow(snapshot(), { kind: "active", pane: "%1" }));
    expect(deriveView(f, { kind: "pinned", pane: "%0" }, NONE).focus).toBe(
      "%0",
    );
  });

  it("a pin on a pane that left reads as the active pane", () => {
    const f = facts(
      reduceWindow(snapshot(), {
        kind: "layout",
        layout: windowLayoutFields(ONE_PANE, ONE_PANE, "*"),
      }),
    );
    const g = facts(reduceWindow(f, { kind: "active", pane: "%0" }));
    expect(deriveView(g, { kind: "pinned", pane: "%1" }, NONE).focus).toBe(
      "%0",
    );
  });

  it("zoomed, focus is the zoomed pane; the pin applies again after", () => {
    const pin: FocusPolicy = { kind: "pinned", pane: "%1" };
    const zoomed = snapshot(TWO_PANES, ZOOMED_0, "*Z");
    expect(deriveView(zoomed, pin, NONE).focus).toBe("%0");
    const unzoomed = facts(
      reduceWindow(zoomed, {
        kind: "layout",
        layout: windowLayoutFields(TWO_PANES, TWO_PANES, "*"),
      }),
    );
    expect(deriveView(unzoomed, pin, NONE).focus).toBe("%1");
  });
});

describe("window model — phaseFor", () => {
  const view: WindowView = deriveView(snapshot(), FOLLOW, NONE);
  const connecting: WindowTerminalState = { phase: "connecting" };
  const states: Record<ConnectionState["status"], ConnectionState> = {
    connecting: { status: "connecting" },
    ready: { status: "ready" },
    reconnecting: { status: "reconnecting", attempt: 2 },
    closed: { status: "closed", reason: "exit" },
  };

  it("connecting until there is a picture", () => {
    for (const s of ["connecting", "ready", "reconnecting"] as const) {
      expect(
        phaseFor(states[s], { kind: "unsynced" }, null, connecting, 5),
      ).toEqual(connecting);
    }
  });

  it("live when ready and synced", () => {
    expect(
      phaseFor(states.ready, { kind: "synced" }, view, connecting, 5),
    ).toEqual({ phase: "live", window: view });
  });

  it("stale keeps the last picture and the time it went stale", () => {
    const first = phaseFor(
      states.reconnecting,
      { kind: "unsynced" },
      view,
      connecting,
      5,
    );
    expect(first).toEqual({
      phase: "stale",
      window: view,
      since: 5,
      reason: "reconnecting (attempt 2)",
    });
    const later = phaseFor(
      states.connecting,
      { kind: "unsynced" },
      view,
      first,
      9,
    );
    expect(later).toMatchObject({
      phase: "stale",
      since: 5,
      reason: "connecting",
    });
    expect(
      phaseFor(states.ready, { kind: "unsynced" }, view, later, 12),
    ).toMatchObject({ phase: "stale", since: 5 });
  });

  it("a reconnect error is part of the reason", () => {
    const s: ConnectionState = {
      status: "reconnecting",
      attempt: 1,
      lastError: new Error("ECONNREFUSED"),
    };
    expect(
      phaseFor(s, { kind: "unsynced" }, view, connecting, 1),
    ).toMatchObject({
      reason: "reconnecting (attempt 1): ECONNREFUSED",
    });
  });

  it("closed is gone(connection-closed) with the close reason", () => {
    expect(
      phaseFor(states.closed, { kind: "synced" }, view, connecting, 1),
    ).toEqual({
      phase: "gone",
      reason: "connection-closed",
      detail: "exit",
    });
  });

  it("a gone window outranks every connection state", () => {
    for (const s of Object.values(states)) {
      expect(
        phaseFor(
          s,
          { kind: "gone", reason: "window-closed" },
          view,
          connecting,
          1,
        ),
      ).toEqual({ phase: "gone", reason: "window-closed" });
    }
  });
});
