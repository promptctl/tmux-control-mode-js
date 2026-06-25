// examples/web-multiplexer/web/bisect-engine.test.ts
//
// Pure-engine tests for "bisect a TUI bug in a recorded session". No tmux, no
// DOM — synthetic seeds + recordings in, a converged culprit out. The
// load-bearing invariants:
//   - THE REDUCER IS git-bisect: startBisect → probe the midpoint → recordVerdict
//     halves the interval → converge to an adjacent (absent, present) pair whose
//     gap pins the offending byte. The verdict is a value; the reducer is blind
//     to whether a human or a predicate produced it.
//   - autoBisect (predicate oracle) converges to the EXACT byte that completes
//     the bug when the predicate is monotonic — the byte whose addition flips the
//     screen. This is what "find the offending escape sequence" reduces to.
//   - SEED IS NEVER BLAMED: reconstruction is emulate(seed ++ stream.slice(0,n)),
//     so seed content shows identically at every offset and the culprit is always
//     in the forward delta — the .9 seed insight, applied to a byte search.
//   - culpritSequence names the WHOLE escape sequence the byte falls in (via the
//     one shared ANSI tokenizer), not just the flipping byte.

import { describe, it, expect } from "vitest";
import type { AttributionGrid } from "./byte-attribution-engine.ts";
import {
  type BisectState,
  type Verdict,
  autoBisect,
  culprit,
  culpritSequence,
  gridAtOffset,
  gridFromStream,
  isConverged,
  probeOffset,
  recordVerdict,
  startBisect,
} from "./bisect-engine.ts";
import {
  parseCaptureReply,
  type ScrollbackSnapshot,
  type Timeline,
} from "./scrollback-engine.ts";
import {
  buildRecording,
  paneStreamBytes,
  type PaneGeometry,
  type RecordedChunk,
} from "./session-recording-engine.ts";

// --- builders --------------------------------------------------------------

const NO_GEOMETRY = new Map<number, PaneGeometry>();
const PANE = 1;

function bytes(s: string): Uint8Array {
  return new Uint8Array([...s].map((c) => c.charCodeAt(0)));
}

function chunk(tMs: number, s: string): RecordedChunk {
  return { paneId: PANE, tMs, bytes: bytes(s) };
}

function seed(lines: string[], geometry: PaneGeometry): ScrollbackSnapshot {
  return parseCaptureReply(lines, geometry, PANE);
}

function timeline(
  snapshot: ScrollbackSnapshot,
  chunks: RecordedChunk[],
): Timeline {
  const recording = buildRecording(chunks, NO_GEOMETRY);
  return {
    snapshot,
    recording,
    paneId: PANE,
    durationMs: recording.durationMs,
  };
}

/** Flatten a reconstructed grid into newline-joined rows for substring asserts. */
function gridText(grid: AttributionGrid): string {
  const rows: string[] = [];
  for (let r = 0; r < grid.rows; r++) {
    let row = "";
    for (let c = 0; c < grid.cols; c++) {
      const cell = grid.cells[r * grid.cols + c];
      row += cell === null ? " " : cell.char;
    }
    rows.push(row);
  }
  return rows.join("\n");
}

function contains(grid: AttributionGrid, text: string): boolean {
  return gridText(grid).includes(text);
}

// --- the reducer: the accept/reject table ----------------------------------

describe("startBisect", () => {
  it("brackets the whole stream: absent at 0, present at length", () => {
    expect(startBisect(10)).toEqual({ lo: 0, hi: 10 });
  });

  it("rounds and floors a junk length to a sane bracket", () => {
    expect(startBisect(-5)).toEqual({ lo: 0, hi: 0 });
    expect(startBisect(7.6)).toEqual({ lo: 0, hi: 8 });
  });

  it("a 0-length stream starts already-converged with no culprit", () => {
    const s = startBisect(0);
    expect(isConverged(s)).toBe(true);
    expect(culprit(s)).toBeNull();
  });

  it("a 1-byte stream is immediately converged on that byte", () => {
    const s = startBisect(1);
    expect(isConverged(s)).toBe(true);
    expect(culprit(s)).toEqual({ goodOffset: 0, badOffset: 1, byteOffset: 0 });
  });
});

describe("probeOffset", () => {
  it("is the midpoint of the open interval (lo, hi)", () => {
    expect(probeOffset({ lo: 0, hi: 10 })).toBe(5);
    expect(probeOffset({ lo: 4, hi: 9 })).toBe(6); // 4 + floor(5/2)
    expect(probeOffset({ lo: 2, hi: 4 })).toBe(3); // strictly between
  });
});

describe("recordVerdict — each step halves the interval", () => {
  it("'absent' lifts the good floor to the probe", () => {
    expect(recordVerdict({ lo: 0, hi: 10 }, "absent")).toEqual({
      lo: 5,
      hi: 10,
    });
  });

  it("'present' lowers the bad ceiling to the probe", () => {
    expect(recordVerdict({ lo: 0, hi: 10 }, "present")).toEqual({
      lo: 0,
      hi: 5,
    });
  });

  it("is the identity on an already-converged state (no swallowed verdict)", () => {
    const conv: BisectState = { lo: 3, hi: 4 };
    expect(recordVerdict(conv, "present")).toEqual(conv);
    expect(recordVerdict(conv, "absent")).toEqual(conv);
  });

  it("a full manual walk converges to a unique byte", () => {
    // Hand-drive the reducer as the UI would: each verdict says the bug IS
    // present at the probe iff offset >= 6 (the culprit byte is 5).
    let state = startBisect(8); // {0,8}
    const verdicts: Verdict[] = [];
    while (!isConverged(state)) {
      const probe = probeOffset(state);
      const v: Verdict = probe >= 6 ? "present" : "absent";
      verdicts.push(v);
      state = recordVerdict(state, v);
    }
    expect(culprit(state)).toEqual({
      goodOffset: 5,
      badOffset: 6,
      byteOffset: 5,
    });
    // log2(8) = 3 probes to pin one of 8 boundaries.
    expect(verdicts).toHaveLength(3);
  });
});

describe("culprit", () => {
  it("is null until the gap is exactly one byte", () => {
    expect(culprit({ lo: 0, hi: 8 })).toBeNull();
    expect(culprit({ lo: 4, hi: 6 })).toBeNull();
    expect(culprit({ lo: 0, hi: 0 })).toBeNull(); // degenerate empty
  });

  it("pins the byte whose addition flips good→bad", () => {
    expect(culprit({ lo: 41, hi: 42 })).toEqual({
      goodOffset: 41,
      badOffset: 42,
      byteOffset: 41,
    });
  });
});

// --- reconstruction at an offset -------------------------------------------

describe("gridFromStream / gridAtOffset", () => {
  const geometry: PaneGeometry = { cols: 40, rows: 4 };
  const snap = seed(["SEEDLINE", "", "", ""], geometry);
  const tl = timeline(snap, [
    chunk(0, "hello world "),
    chunk(10, "BUG appeared"),
  ]);
  const stream = paneStreamBytes(tl.recording, PANE);

  it("offset 0 is the seed alone — the known-good end, bug absent", () => {
    const g = gridFromStream(snap, geometry, stream, 0);
    expect(contains(g, "SEEDLINE")).toBe(true);
    expect(contains(g, "BUG")).toBe(false);
  });

  it("the full stream shows the bug — and the seed, untouched", () => {
    const g = gridAtOffset(tl, stream.length);
    expect(contains(g, "BUG appeared")).toBe(true);
    expect(contains(g, "SEEDLINE")).toBe(true); // seed is never overwritten
  });

  it("clamps an out-of-range offset rather than reading past the buffer", () => {
    const over = gridFromStream(snap, geometry, stream, stream.length + 999);
    expect(contains(over, "BUG appeared")).toBe(true);
    const under = gridFromStream(snap, geometry, stream, -10);
    expect(contains(under, "BUG")).toBe(false);
  });
});

// --- autoBisect: the predicate oracle --------------------------------------

describe("autoBisect", () => {
  const geometry: PaneGeometry = { cols: 40, rows: 4 };
  const snap = seed(["", "", "", ""], geometry);
  // "BUG" occupies stream offsets 12,13,14; it is fully on screen once the byte
  // at 14 ('G') has been written, i.e. slice length 15.
  const tl = timeline(snap, [
    chunk(0, "hello world "),
    chunk(10, "BUG appeared"),
  ]);

  it("converges to the exact byte that completes the bug", () => {
    const result = autoBisect(tl, (g) => contains(g, "BUG"));
    expect(result.culprit?.byteOffset).toBe(14); // the 'G'
    expect(result.culprit?.badOffset).toBe(15); // first prefix containing BUG
  });

  it("every probe drew a verdict; the path is logged", () => {
    const result = autoBisect(tl, (g) => contains(g, "BUG"));
    expect(result.steps.length).toBeGreaterThan(0);
    for (const s of result.steps)
      expect(s.verdict === "present" || s.verdict === "absent").toBe(true);
  });

  it("a predicate true from the first byte pins offset 0", () => {
    // The whole screen is always 'present' → the bug was there from byte 0.
    const result = autoBisect(tl, () => true);
    expect(result.culprit?.byteOffset).toBe(0);
  });

  it("a predicate never true pins the final byte (honest endpoint)", () => {
    // Violates the present-at-end assumption; binary search still returns a
    // defined boundary rather than throwing. [LAW:no-silent-failure]
    const stream = paneStreamBytes(tl.recording, PANE);
    const result = autoBisect(tl, () => false);
    expect(result.culprit?.byteOffset).toBe(stream.length - 1);
  });
});

// --- naming the offending sequence -----------------------------------------

describe("culpritSequence", () => {
  // "AB" (text, 0-1) then ESC[31m (CSI, 2-6) then "CD" (text, 7-8).
  const stream = bytes("AB\x1b[31mCD");

  it("names the whole CSI sequence a byte inside it belongs to", () => {
    const seq = culpritSequence(stream, 4); // the '1' inside ESC[31m
    expect(seq?.event.kind).toBe("csi");
    expect(seq?.start).toBe(2);
    expect(seq?.end).toBe(7);
    expect([...(seq?.raw ?? [])]).toEqual([...bytes("\x1b[31m")]);
  });

  it("the flipping byte (the final 'm') still names the whole sequence", () => {
    const seq = culpritSequence(stream, 6); // 'm', the byte that completes SGR
    expect(seq?.event.kind).toBe("csi");
    expect(seq?.start).toBe(2);
  });

  it("a byte in a plain text run names that run", () => {
    expect(culpritSequence(stream, 0)?.event.kind).toBe("text");
    expect(culpritSequence(stream, 7)?.event.kind).toBe("text");
  });

  it("returns null outside the stream (no clamped lie)", () => {
    expect(culpritSequence(stream, -1)).toBeNull();
    expect(culpritSequence(stream, stream.length)).toBeNull();
  });
});
