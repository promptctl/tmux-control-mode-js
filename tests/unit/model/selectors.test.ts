// tests/unit/model/selectors.test.ts
// Pure-function tests for the TmuxModel selectors. No tmux, no client.

import { describe, it, expect } from "vitest";
import {
  activeSessionId,
  activeWindowId,
  activePaneId,
  currentSession,
  currentWindow,
  paneLabels,
  findPane,
} from "../../../src/model/selectors.js";
import {
  EMPTY_SNAPSHOT,
  type TmuxSnapshot,
} from "../../../src/model/types.js";

function snapshot(over: Partial<TmuxSnapshot> = {}): TmuxSnapshot {
  return {
    sessions: [],
    clientSessionId: null,
    ...over,
  };
}

describe("activeSessionId", () => {
  it("returns null on the empty snapshot", () => {
    expect(activeSessionId(EMPTY_SNAPSHOT)).toBe(null);
  });

  it("prefers clientSessionId when it matches an existing session", () => {
    const s = snapshot({
      clientSessionId: 2,
      sessions: [
        { id: 1, name: "a", attached: true, windows: [] },
        { id: 2, name: "b", attached: false, windows: [] },
      ],
    });
    expect(activeSessionId(s)).toBe(2);
  });

  it("falls back to first attached when clientSessionId is unknown", () => {
    const s = snapshot({
      clientSessionId: 99,
      sessions: [
        { id: 1, name: "a", attached: false, windows: [] },
        { id: 2, name: "b", attached: true, windows: [] },
      ],
    });
    expect(activeSessionId(s)).toBe(2);
  });

  it("falls back to first session when nothing is attached", () => {
    const s = snapshot({
      sessions: [
        { id: 5, name: "a", attached: false, windows: [] },
        { id: 7, name: "b", attached: false, windows: [] },
      ],
    });
    expect(activeSessionId(s)).toBe(5);
  });
});

describe("activeWindowId / currentWindow", () => {
  const s = snapshot({
    clientSessionId: 1,
    sessions: [
      {
        id: 1,
        name: "main",
        attached: true,
        windows: [
          { id: 10, index: 0, name: "w0", active: false, zoomed: false, panes: [] },
          { id: 11, index: 1, name: "w1", active: true, zoomed: false, panes: [] },
        ],
      },
    ],
  });

  it("activeWindowId picks the window with active=true", () => {
    expect(activeWindowId(s)).toBe(11);
  });

  it("currentWindow returns the snapshot for the active window", () => {
    expect(currentWindow(s)?.name).toBe("w1");
  });

  it("activeWindowId falls back to first window when none is active", () => {
    const noActive = snapshot({
      clientSessionId: 1,
      sessions: [
        {
          id: 1,
          name: "main",
          attached: true,
          windows: [
            { id: 10, index: 0, name: "w0", active: false, zoomed: false, panes: [] },
          ],
        },
      ],
    });
    expect(activeWindowId(noActive)).toBe(10);
  });
});

describe("activePaneId", () => {
  it("returns the active pane in the active window", () => {
    const s = snapshot({
      clientSessionId: 1,
      sessions: [
        {
          id: 1,
          name: "main",
          attached: true,
          windows: [
            {
              id: 10,
              index: 0,
              name: "w",
              active: true,
              zoomed: false,
              panes: [
                { id: 100, index: 0, active: false, title: "", width: 80, height: 24 },
                { id: 101, index: 1, active: true, title: "", width: 80, height: 24 },
              ],
            },
          ],
        },
      ],
    });
    expect(activePaneId(s)).toBe(101);
  });
});

describe("paneLabels", () => {
  it("builds 'session:winIdx.paneIdx' labels for every pane", () => {
    const s = snapshot({
      sessions: [
        {
          id: 1,
          name: "alpha",
          attached: true,
          windows: [
            {
              id: 10,
              index: 0,
              name: "w0",
              active: true,
              zoomed: false,
              panes: [
                { id: 100, index: 0, active: true, title: "", width: 80, height: 24 },
                { id: 101, index: 1, active: false, title: "", width: 80, height: 24 },
              ],
            },
          ],
        },
        {
          id: 2,
          name: "beta",
          attached: false,
          windows: [
            {
              id: 20,
              index: 1,
              name: "w1",
              active: true,
              zoomed: false,
              panes: [
                { id: 200, index: 0, active: true, title: "", width: 80, height: 24 },
              ],
            },
          ],
        },
      ],
    });
    const labels = paneLabels(s);
    expect(labels.get(100)).toBe("alpha:0.0");
    expect(labels.get(101)).toBe("alpha:0.1");
    expect(labels.get(200)).toBe("beta:1.0");
    expect(labels.size).toBe(3);
  });
});

describe("findPane", () => {
  const s = snapshot({
    sessions: [
      {
        id: 1,
        name: "main",
        attached: true,
        windows: [
          {
            id: 10,
            index: 0,
            name: "w0",
            active: true,
            zoomed: false,
            panes: [
              { id: 100, index: 0, active: true, title: "p100", width: 80, height: 24 },
            ],
          },
        ],
      },
    ],
  });

  it("returns the pane snapshot when found", () => {
    expect(findPane(s, 100)?.title).toBe("p100");
  });

  it("returns null when not found", () => {
    expect(findPane(s, 999)).toBe(null);
  });
});

describe("currentSession", () => {
  it("returns null on empty snapshot", () => {
    expect(currentSession(EMPTY_SNAPSHOT)).toBe(null);
  });

  it("returns the resolved active session", () => {
    const s = snapshot({
      sessions: [
        { id: 1, name: "main", attached: true, windows: [] },
      ],
    });
    expect(currentSession(s)?.name).toBe("main");
  });
});
