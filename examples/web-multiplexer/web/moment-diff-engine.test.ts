// examples/web-multiplexer/web/moment-diff-engine.test.ts
//
// Pure-engine tests for "diff two moments in pane history". No tmux, no DOM —
// synthetic seeds + recordings in, a classified cell grid out. The load-bearing
// invariants:
//   - the cell accept/reject table: (before, after) → exactly one of
//     same/added/removed/changed, with appearance — not provenance — deciding
//     equality (two moments are always written by different bytes).
//   - SEED BOTH SIDES, SAME SEED ⇒ PURE FORWARD DELTA: content present in the
//     seed appears identically in both reconstructions and is classified "same",
//     never "added"/"changed". This is the .5 gap the .9 seed closes, applied to
//     a two-sided diff.
//   - cursor + summary are honest projections of the same two grids.

import { describe, it, expect } from "vitest";
import {
  type CellChange,
  cellChange,
  diffMoments,
  gridAtMoment,
} from "./moment-diff-engine.ts";
import type { AttributedCell } from "./byte-attribution-engine.ts";
import {
  parseCaptureReply,
  type ScrollbackSnapshot,
  type Timeline,
} from "./scrollback-engine.ts";
import {
  buildRecording,
  type PaneGeometry,
  type RecordedChunk,
} from "./session-recording-engine.ts";

// --- builders --------------------------------------------------------------

function cell(
  char: string,
  extra: Partial<AttributedCell> = {},
): AttributedCell {
  return {
    char,
    chunkId: 0,
    tMs: 0,
    byteOffset: 0,
    streamOffset: 0,
    fg: null,
    bg: null,
    bold: false,
    ...extra,
  };
}

const NO_GEOMETRY = new Map<number, PaneGeometry>();

function chunk(paneId: number, tMs: number, s: string): RecordedChunk {
  return {
    paneId,
    tMs,
    bytes: new Uint8Array([...s].map((c) => c.charCodeAt(0))),
  };
}

/** A seed snapshot from literal rows; `rows` of them are the visible screen. */
function seed(
  lines: string[],
  geometry: PaneGeometry,
  paneId: number,
): ScrollbackSnapshot {
  return parseCaptureReply(lines, geometry, paneId);
}

function timeline(
  snapshot: ScrollbackSnapshot,
  chunks: RecordedChunk[],
  paneId: number,
): Timeline {
  const recording = buildRecording(chunks, NO_GEOMETRY);
  return { snapshot, recording, paneId, durationMs: recording.durationMs };
}

/** The CellChange at (row,col) in a diff, for terse assertions. */
function at(
  d: ReturnType<typeof diffMoments>,
  row: number,
  col: number,
): CellChange {
  return d.cells[row * d.cols + col];
}

// --- cellChange: the accept/reject table -----------------------------------

describe("cellChange — the accept/reject table", () => {
  it("blank on both sides is 'same'", () => {
    expect(cellChange(null, null)).toEqual({ kind: "same", cell: null });
  });

  it("blank → written is 'added' (carries after)", () => {
    const a = cell("X");
    expect(cellChange(null, a)).toEqual({ kind: "added", after: a });
  });

  it("written → blank is 'removed' (carries before)", () => {
    const b = cell("X");
    expect(cellChange(b, null)).toEqual({ kind: "removed", before: b });
  });

  it("identical appearance is 'same' EVEN WITH different provenance", () => {
    // The two moments are written by different bytes at different times — the
    // diff must ignore provenance and compare appearance only.
    const before = cell("A", {
      chunkId: 1,
      tMs: 10,
      byteOffset: 3,
      streamOffset: 3,
    });
    const after = cell("A", {
      chunkId: 9,
      tMs: 99,
      byteOffset: 0,
      streamOffset: 50,
    });
    expect(cellChange(before, after)).toEqual({ kind: "same", cell: after });
  });

  it("different glyph is 'changed'", () => {
    const before = cell("A");
    const after = cell("B");
    expect(cellChange(before, after)).toEqual({
      kind: "changed",
      before,
      after,
    });
  });

  it("same glyph, different color is 'changed'", () => {
    const before = cell("A", { fg: "#ff0000" });
    const after = cell("A", { fg: "#0000ff" });
    expect(cellChange(before, after).kind).toBe("changed");
  });

  it("same glyph, different boldness is 'changed'", () => {
    expect(cellChange(cell("A", { bold: true }), cell("A")).kind).toBe(
      "changed",
    );
  });
});

// --- diffMoments over a recording ------------------------------------------

describe("diffMoments — forward delta between two recorded times", () => {
  const GEO: PaneGeometry = { cols: 5, rows: 2 };
  const PANE = 7;
  // Empty pane (no pre-existing content); program homes the cursor each write.
  const SNAP = seed(["", ""], GEO, PANE);
  const CHUNKS = [
    chunk(PANE, 10, "\x1b[Habc"), // row0: "abc"
    chunk(PANE, 20, "\x1b[HabX"), // row0: "abX"  (c → X)
    chunk(PANE, 30, "\x1b[HabXde"), // row0: "abXde" (+ d,e)
  ];
  const TL = timeline(SNAP, CHUNKS, PANE);

  it("a moment diffed against itself is all-same and the cursor stays put", () => {
    const d = diffMoments(TL, 10, 10);
    expect(d.summary).toEqual({ same: 10, added: 0, removed: 0, changed: 0 });
    expect(d.cursor.moved).toBe(false);
  });

  it("an overwritten cell is 'changed'; the rest are 'same'", () => {
    const d = diffMoments(TL, 10, 20);
    expect(at(d, 0, 2).kind).toBe("changed");
    expect(d.summary).toEqual({ same: 9, added: 0, removed: 0, changed: 1 });
    // Both wrote 3 glyphs from home → cursor at col 3 both times.
    expect(d.cursor.moved).toBe(false);
  });

  it("newly written cells are 'added' and advance the cursor", () => {
    const d = diffMoments(TL, 10, 30);
    expect(at(d, 0, 2).kind).toBe("changed"); // c → X
    expect(at(d, 0, 3).kind).toBe("added"); // → d
    expect(at(d, 0, 4).kind).toBe("added"); // → e
    expect(d.summary).toEqual({ same: 7, added: 2, removed: 0, changed: 1 });
    expect(d.cursor.moved).toBe(true);
  });

  it("the diff is antisymmetric: added one way is removed the other", () => {
    const fwd = diffMoments(TL, 10, 30);
    const rev = diffMoments(TL, 30, 10);
    expect(rev.summary.removed).toBe(fwd.summary.added);
    expect(rev.summary.added).toBe(fwd.summary.removed);
    expect(rev.summary.changed).toBe(fwd.summary.changed);
    expect(at(rev, 0, 3).kind).toBe("removed");
  });
});

// --- the seed invariant: same seed both sides → only the delta shows --------

describe("diffMoments — seed content never counts as a change", () => {
  const GEO: PaneGeometry = { cols: 5, rows: 2 };
  const PANE = 3;
  // Pre-existing content on the visible screen the browser never attached to.
  const SNAP = seed(["SEED!", ""], GEO, PANE);
  // The only forward activity: write "xy" on row 1.
  const CHUNKS = [chunk(PANE, 10, "\x1b[2;1Hxy")];
  const TL = timeline(SNAP, CHUNKS, PANE);

  it("reconstructs the seed at a moment before any recorded byte", () => {
    const g = gridAtMoment(TL, 0);
    const row0 = [0, 1, 2, 3, 4].map((c) => g.cells[c]?.char ?? " ").join("");
    expect(row0).toBe("SEED!");
  });

  it("classifies the seed row as 'same' and only the delta as 'added'", () => {
    const d = diffMoments(TL, 0, 10);
    // Row 0 (the seed) is identical in both reconstructions → all same.
    for (let c = 0; c < GEO.cols; c++) expect(at(d, 0, c).kind).toBe("same");
    // Row 1 gained "xy".
    expect(at(d, 1, 0).kind).toBe("added");
    expect(at(d, 1, 1).kind).toBe("added");
    expect(d.summary).toEqual({ same: 8, added: 2, removed: 0, changed: 0 });
  });
});
