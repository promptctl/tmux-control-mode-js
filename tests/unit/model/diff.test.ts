// tests/unit/model/diff.test.ts
// Pure tests for computeDiff — covers every category in TmuxDiff.

import { describe, it, expect } from "vitest";
import { computeDiff, isEmptyDiff } from "../../../src/model/diff.js";
import {
  EMPTY_SNAPSHOT,
  type TmuxSnapshot,
} from "../../../src/model/types.js";

function snap(s: Partial<TmuxSnapshot> = {}): TmuxSnapshot {
  return {
    sessions: [],
    clientSessionId: null,
    ...s,
  };
}

describe("computeDiff", () => {
  it("empty → empty has empty diff", () => {
    const d = computeDiff(EMPTY_SNAPSHOT, EMPTY_SNAPSHOT);
    expect(isEmptyDiff(d)).toBe(true);
  });

  it("null prev treats every entity as added", () => {
    const next = snap({
      sessions: [
        {
          id: 1,
          name: "a",
          attached: true,
          windows: [
            {
              id: 10,
              index: 0,
              name: "w",
              active: true,
              zoomed: false,
              panes: [
                { id: 100, index: 0, active: true, title: "", width: 80, height: 24 },
              ],
            },
          ],
        },
      ],
    });
    const d = computeDiff(null, next);
    expect(d.sessions.added).toEqual([1]);
    expect(d.windows.added).toEqual([10]);
    expect(d.panes.added).toEqual([100]);
  });

  it("removes detected at every tier", () => {
    const prev = snap({
      sessions: [
        {
          id: 1,
          name: "a",
          attached: true,
          windows: [
            {
              id: 10,
              index: 0,
              name: "w",
              active: true,
              zoomed: false,
              panes: [
                { id: 100, index: 0, active: true, title: "", width: 80, height: 24 },
              ],
            },
          ],
        },
      ],
    });
    const next = snap({});
    const d = computeDiff(prev, next);
    expect(d.sessions.removed).toEqual([1]);
    expect(d.windows.removed).toEqual([10]);
    expect(d.panes.removed).toEqual([100]);
  });

  it("rename payloads carry old and new names", () => {
    const prev = snap({
      sessions: [
        {
          id: 1,
          name: "old",
          attached: true,
          windows: [
            {
              id: 10,
              index: 0,
              name: "w-old",
              active: true,
              zoomed: false,
              panes: [],
            },
          ],
        },
      ],
    });
    const next = snap({
      sessions: [
        {
          id: 1,
          name: "new",
          attached: true,
          windows: [
            {
              id: 10,
              index: 0,
              name: "w-new",
              active: true,
              zoomed: false,
              panes: [],
            },
          ],
        },
      ],
    });
    const d = computeDiff(prev, next);
    expect(d.sessions.renamed).toEqual([
      { id: 1, oldName: "old", newName: "new" },
    ]);
    expect(d.windows.renamed).toEqual([
      { id: 10, oldName: "w-old", newName: "w-new" },
    ]);
  });

  it("attach / active / zoom flag flips populate the right list", () => {
    const prev = snap({
      sessions: [
        {
          id: 1,
          name: "s",
          attached: false,
          windows: [
            {
              id: 10,
              index: 0,
              name: "w",
              active: false,
              zoomed: false,
              panes: [
                { id: 100, index: 0, active: false, title: "t", width: 80, height: 24 },
              ],
            },
          ],
        },
      ],
    });
    const next = snap({
      sessions: [
        {
          id: 1,
          name: "s",
          attached: true,
          windows: [
            {
              id: 10,
              index: 0,
              name: "w",
              active: true,
              zoomed: true,
              panes: [
                { id: 100, index: 0, active: true, title: "t", width: 80, height: 24 },
              ],
            },
          ],
        },
      ],
    });
    const d = computeDiff(prev, next);
    expect(d.sessions.attachChanged).toEqual([1]);
    expect(d.windows.activeChanged).toEqual([10]);
    expect(d.windows.zoomedChanged).toEqual([10]);
    expect(d.panes.activeChanged).toEqual([100]);
  });

  it("dimChanged fires when width or height changes", () => {
    const prev = snap({
      sessions: [
        {
          id: 1,
          name: "s",
          attached: true,
          windows: [
            {
              id: 10,
              index: 0,
              name: "w",
              active: true,
              zoomed: false,
              panes: [
                { id: 100, index: 0, active: true, title: "", width: 80, height: 24 },
                { id: 101, index: 1, active: false, title: "", width: 40, height: 12 },
              ],
            },
          ],
        },
      ],
    });
    const next = snap({
      sessions: [
        {
          id: 1,
          name: "s",
          attached: true,
          windows: [
            {
              id: 10,
              index: 0,
              name: "w",
              active: true,
              zoomed: false,
              panes: [
                { id: 100, index: 0, active: true, title: "", width: 100, height: 24 },
                { id: 101, index: 1, active: false, title: "", width: 40, height: 20 },
              ],
            },
          ],
        },
      ],
    });
    const d = computeDiff(prev, next);
    expect(d.panes.dimChanged.sort()).toEqual([100, 101]);
  });

  it("titleChanged fires only on title change", () => {
    const prev = snap({
      sessions: [
        {
          id: 1,
          name: "s",
          attached: true,
          windows: [
            {
              id: 10,
              index: 0,
              name: "w",
              active: true,
              zoomed: false,
              panes: [
                { id: 100, index: 0, active: true, title: "old", width: 80, height: 24 },
              ],
            },
          ],
        },
      ],
    });
    const next = snap({
      sessions: [
        {
          id: 1,
          name: "s",
          attached: true,
          windows: [
            {
              id: 10,
              index: 0,
              name: "w",
              active: true,
              zoomed: false,
              panes: [
                { id: 100, index: 0, active: true, title: "new", width: 80, height: 24 },
              ],
            },
          ],
        },
      ],
    });
    expect(computeDiff(prev, next).panes.titleChanged).toEqual([100]);
  });

  it("clientSessionChanged flips when clientSessionId changes", () => {
    const prev = snap({ clientSessionId: 1 });
    const next = snap({ clientSessionId: 2 });
    expect(computeDiff(prev, next).clientSessionChanged).toBe(true);
  });

  it("isEmptyDiff: true on identical snapshots", () => {
    const s = snap({
      sessions: [
        {
          id: 1,
          name: "x",
          attached: true,
          windows: [
            { id: 10, index: 0, name: "w", active: true, zoomed: false, panes: [] },
          ],
        },
      ],
    });
    expect(isEmptyDiff(computeDiff(s, s))).toBe(true);
  });
});
