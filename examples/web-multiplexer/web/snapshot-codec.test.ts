// examples/web-multiplexer/web/snapshot-codec.test.ts
//
// Isolation tests for the pure wire↔tree codec. No MobX, no client, no
// async — every case is a plain string in, plain value out. These pin the
// snapshot-string format and the tree-assembly rules the whole DemoStore
// model rides on. [LAW:behavior-not-structure]

import { describe, it, expect } from "vitest";
import {
  encodeSnapshotLines,
  mergeSessionRows,
  mergePaneRowsByWindow,
  buildSessionTree,
} from "./snapshot-codec.ts";

// The 2-char record separator tmux preserves verbatim in delivered values.
const NL = "\\n";

describe("encodeSnapshotLines", () => {
  it("joins rows with the literal 2-char \\n separator", () => {
    expect(encodeSnapshotLines(["a", "b", "c"])).toBe(`a${NL}b${NL}c`);
  });

  it("encodes a single row without a trailing separator", () => {
    expect(encodeSnapshotLines(["only"])).toBe("only");
  });

  it("encodes the empty list to the empty string", () => {
    expect(encodeSnapshotLines([])).toBe("");
  });
});

describe("mergeSessionRows", () => {
  it("replaces only the rows for the target session, preserving the rest", () => {
    const existing = encodeSnapshotLines([
      "$1|w1|0|old|1|0",
      "$2|w2|0|keep|1|0",
    ]);
    const merged = mergeSessionRows(
      existing,
      /* sessionId */ 1,
      ["$1|w1|0|fresh|1|0"],
      /* sidFieldIndex */ 0,
    );
    expect(merged.split(NL).sort()).toEqual(
      ["$2|w2|0|keep|1|0", "$1|w1|0|fresh|1|0"].sort(),
    );
  });

  it("drops all old rows for the target session even when it contributes no fresh rows", () => {
    const existing = encodeSnapshotLines(["$1|a", "$1|b", "$2|c"]);
    expect(mergeSessionRows(existing, 1, [], 0)).toBe("$2|c");
  });

  it("matches the session id at the given field index, not position zero", () => {
    // windows format carries session_id at field 0, but the guard must honor
    // whatever index the caller passes.
    const existing = encodeSnapshotLines(["w1|$1|rest", "w2|$2|rest"]);
    const merged = mergeSessionRows(existing, 1, ["w9|$1|new"], 1);
    expect(merged.split(NL).sort()).toEqual(["w2|$2|rest", "w9|$1|new"].sort());
  });

  it("merging into an empty snapshot yields just the fresh rows", () => {
    expect(mergeSessionRows("", 1, ["$1|w1|0|new|1|0"], 0)).toBe(
      "$1|w1|0|new|1|0",
    );
  });
});

describe("mergePaneRowsByWindow", () => {
  it("replaces pane rows whose window_id is in the fresh set, keeps the others", () => {
    const existing = encodeSnapshotLines([
      "@1|%1|0|1|80|24|old",
      "@2|%2|0|1|80|24|keep",
    ]);
    const merged = mergePaneRowsByWindow(existing, new Set(["@1"]), [
      "@1|%9|0|1|80|24|fresh",
    ]);
    expect(merged.split(NL).sort()).toEqual(
      ["@2|%2|0|1|80|24|keep", "@1|%9|0|1|80|24|fresh"].sort(),
    );
  });

  it("merging into an empty snapshot yields just the fresh rows", () => {
    expect(
      mergePaneRowsByWindow("", new Set(["@1"]), ["@1|%1|0|1|80|24|fresh"]),
    ).toBe("@1|%1|0|1|80|24|fresh");
  });

  it("removes nothing when the fresh window set does not overlap existing rows", () => {
    const existing = encodeSnapshotLines([
      "@1|%1|0|1|80|24|a",
      "@2|%2|0|1|80|24|b",
    ]);
    const merged = mergePaneRowsByWindow(existing, new Set(["@9"]), [
      "@9|%9|0|1|80|24|new",
    ]);
    expect(merged.split(NL).sort()).toEqual(
      ["@1|%1|0|1|80|24|a", "@2|%2|0|1|80|24|b", "@9|%9|0|1|80|24|new"].sort(),
    );
  });
});

describe("buildSessionTree", () => {
  const sessions = encodeSnapshotLines(["$1|main|1", "$2|other|0"]);
  const windows = encodeSnapshotLines([
    "$1|@10|0|editor|1|0",
    "$1|@11|1|shell|0|1",
    "$2|@20|0|logs|1|0",
  ]);
  const panes = encodeSnapshotLines([
    "@10|%100|0|1|120|40|vim",
    "@10|%101|1|0|120|40|term",
    "@11|%110|0|1|80|24|bash",
  ]);

  it("assembles the full nested tree with ids stripped of their sigils", () => {
    const tree = buildSessionTree(sessions, windows, panes);
    expect(tree.map((s) => s.id)).toEqual([1, 2]);
    expect(tree[0].name).toBe("main");
    expect(tree[0].windows.map((w) => w.id)).toEqual([10, 11]);
    expect(tree[0].windows[0].panes.map((p) => p.id)).toEqual([100, 101]);
  });

  it("parses attached / active / zoomed flags from their '1'/'0' fields", () => {
    const tree = buildSessionTree(sessions, windows, panes);
    expect(tree[0].attached).toBe(true);
    expect(tree[1].attached).toBe(false);
    expect(tree[0].windows[0].active).toBe(true);
    expect(tree[0].windows[1].active).toBe(false);
    expect(tree[0].windows[1].zoomed).toBe(true);
    expect(tree[0].windows[0].zoomed).toBe(false);
    expect(tree[0].windows[0].panes[0].active).toBe(true);
    expect(tree[0].windows[0].panes[1].active).toBe(false);
  });

  it("sorts panes within a window by index, regardless of delivery order", () => {
    // Pane rows delivered out of index order must still assemble in index
    // order — the tree's order can't depend on tmux's nested-loop emission.
    const tree = buildSessionTree(
      "$1|main|1",
      "$1|@10|0|w|1|0",
      encodeSnapshotLines([
        "@10|%102|2|0|80|24|c",
        "@10|%100|0|1|80|24|a",
        "@10|%101|1|0|80|24|b",
      ]),
    );
    expect(tree[0].windows[0].panes.map((p) => p.index)).toEqual([0, 1, 2]);
    expect(tree[0].windows[0].panes.map((p) => p.title)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("sorts windows within a session by index", () => {
    const unordered = encodeSnapshotLines([
      "$1|@11|2|c|0|0",
      "$1|@12|0|a|1|0",
      "$1|@13|1|b|0|0",
    ]);
    const tree = buildSessionTree("$1|main|1", unordered, "");
    expect(tree[0].windows.map((w) => w.index)).toEqual([0, 1, 2]);
    expect(tree[0].windows.map((w) => w.name)).toEqual(["a", "b", "c"]);
  });

  it("defaults pane width/height to 80x24 when the field is non-numeric", () => {
    const tree = buildSessionTree(
      "$1|main|1",
      "$1|@10|0|w|1|0",
      "@10|%100|0|1|||title",
    );
    expect(tree[0].windows[0].panes[0].width).toBe(80);
    expect(tree[0].windows[0].panes[0].height).toBe(24);
  });

  it("treats an empty attached field as not-attached", () => {
    const tree = buildSessionTree("$1|main|", "", "");
    expect(tree[0].attached).toBe(false);
  });

  it("yields an empty tree from empty snapshot strings", () => {
    expect(buildSessionTree("", "", "")).toEqual([]);
  });

  it("gives a session with no windows an empty windows array", () => {
    const tree = buildSessionTree("$3|lonely|1", "", "");
    expect(tree).toHaveLength(1);
    expect(tree[0].windows).toEqual([]);
  });

  it("gives a window with no panes an empty panes array", () => {
    const tree = buildSessionTree("$1|main|1", "$1|@10|0|w|1|0", "");
    expect(tree[0].windows[0].panes).toEqual([]);
  });

  it("treats any non-'1' active/zoomed flag value as false (only '1' is truthy)", () => {
    // Pins that active/zoomed use exact '1' equality, not JS truthiness — a
    // stray '2'/'true' from a malformed row reads as false, never true.
    const tree = buildSessionTree(
      "$1|main|1",
      "$1|@10|0|w|2|true",
      "@10|%100|0|yes|80|24|t",
    );
    expect(tree[0].windows[0].active).toBe(false);
    expect(tree[0].windows[0].zoomed).toBe(false);
    expect(tree[0].windows[0].panes[0].active).toBe(false);
  });
});
