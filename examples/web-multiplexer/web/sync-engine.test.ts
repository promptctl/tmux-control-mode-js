// examples/web-multiplexer/web/sync-engine.test.ts
//
// Pure-engine tests for "synchronized scrollback across linked panes". No tmux,
// no DOM — synthetic seeds + a recording in, per-pane paint bytes out. The
// load-bearing invariants:
//   - THE SYNC GUARANTEE: a `syncFrame` is N panes at ONE instant — every entry
//     carries the same tMs, each entry's bytes equal that pane's own `paintAt`.
//   - THE SEEK/PLAY EQUIVALENCE: `paintAt(from) ++ forwardDelta(from,to)` equals
//     `paintAt(to)` for from <= to, so playback paints forward deltas and only
//     re-seeds on a backward jump (reuses .5's `bytesUpTo`/`bytesBetween` law).
//   - LIVE-ONLY AXIS: the cursor is recorded time; a silent seeded pane shows its
//     static seed at every instant, never an empty screen.
//   - cursor mapping + merged activity are honest projections of the recording.

import { describe, it, expect } from "vitest";
import {
  type SyncGroup,
  cursorFrac,
  cursorMs,
  forwardDelta,
  groupDuration,
  linkablePanes,
  linkedActivity,
  linkedTimelines,
  paintAt,
  syncFrame,
  timelineFor,
} from "./sync-engine.ts";
import {
  parseCaptureReply,
  type ScrollbackSnapshot,
} from "./scrollback-engine.ts";
import {
  buildRecording,
  type PaneGeometry,
  type RecordedChunk,
} from "./session-recording-engine.ts";

// --- builders --------------------------------------------------------------

const NO_GEOMETRY = new Map<number, PaneGeometry>();

function chunk(paneId: number, tMs: number, s: string): RecordedChunk {
  return {
    paneId,
    tMs,
    bytes: new Uint8Array([...s].map((c) => c.charCodeAt(0))),
  };
}

/** A seed snapshot from literal rows; the bottom `geometry.rows` are the screen. */
function seed(
  lines: string[],
  geometry: PaneGeometry,
  paneId: number,
): ScrollbackSnapshot {
  return parseCaptureReply(lines, geometry, paneId);
}

/** Latin-1 decode so byte assertions read as strings. */
function str(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += String.fromCharCode(b);
  return out;
}

// The seeded-paint assembly the engine reuses from .9 (`seededPaint`): home +
// clear + reset pen, the visible screen, then the forward delta. Mirrored here so
// the tests pin BEHAVIOUR (concrete bytes) rather than re-calling the impl.
const CLEAR = "\x1b[0m\x1b[H\x1b[2J";
const G: PaneGeometry = { cols: 10, rows: 2 };

/** A two-pane group: pane 1 busy, pane 2 quiet-then-busy, both seeded + linked. */
function twoPaneGroup(): SyncGroup {
  const snapshots = new Map<number, ScrollbackSnapshot>([
    [1, seed(["hist", "scrA", "scrB"], G, 1)], // 1 history row above the screen
    [2, seed(["topX", "topY"], G, 2)], // no history (exactly `rows` lines)
  ]);
  const recording = buildRecording(
    [chunk(1, 100, "X"), chunk(1, 200, "Y"), chunk(2, 200, "Z")],
    NO_GEOMETRY,
  );
  return { recording, snapshots, linked: new Set([1, 2]) };
}

// --- cursor mapping --------------------------------------------------------

describe("cursorMs / cursorFrac", () => {
  it("maps the fraction linearly onto [0, durationMs] and clamps", () => {
    expect(cursorMs(0, 1000)).toBe(0);
    expect(cursorMs(0.5, 1000)).toBe(500);
    expect(cursorMs(1, 1000)).toBe(1000);
    expect(cursorMs(-1, 1000)).toBe(0);
    expect(cursorMs(2, 1000)).toBe(1000);
  });

  it("round-trips an in-range instant", () => {
    expect(cursorFrac(cursorMs(0.37, 1000), 1000)).toBeCloseTo(0.37, 10);
  });

  it("collapses a zero-duration recording to a single instant, never NaN", () => {
    expect(cursorFrac(0, 0)).toBe(0);
    expect(cursorFrac(500, 0)).toBe(0);
    expect(cursorMs(0.5, 0)).toBe(0);
  });
});

// --- timelines / eligibility ----------------------------------------------

describe("timelineFor / linkablePanes / linkedTimelines", () => {
  it("builds a timeline for a seeded pane and null for an unseeded one", () => {
    const group = twoPaneGroup();
    expect(timelineFor(group, 1)?.paneId).toBe(1);
    expect(timelineFor(group, 99)).toBeNull();
  });

  it("exposes the shared duration from the recording, not a stored copy", () => {
    expect(groupDuration(twoPaneGroup())).toBe(200);
  });

  it("lists seeded panes as linkable in seed order", () => {
    expect(linkablePanes(twoPaneGroup())).toEqual([1, 2]);
  });

  it("renders only panes that are BOTH linked and seeded", () => {
    const group = { ...twoPaneGroup(), linked: new Set([1]) };
    expect(linkedTimelines(group).map((t) => t.paneId)).toEqual([1]);
  });

  it("ignores an unseeded id that somehow sits in the linked set", () => {
    const group = { ...twoPaneGroup(), linked: new Set([1, 2, 99]) };
    expect(linkedTimelines(group).map((t) => t.paneId)).toEqual([1, 2]);
  });
});

// --- paintAt: live-only seeded reconstruction ------------------------------

describe("paintAt", () => {
  it("reconstructs clear + visible screen + forward bytes up to the instant", () => {
    const tl = timelineFor(twoPaneGroup(), 1);
    expect(tl).not.toBeNull();
    if (tl === null) return;
    // Bottom `rows` seed lines are the screen: "scrA","scrB" joined CR/LF.
    expect(str(paintAt(tl, 0))).toBe(`${CLEAR}scrA\r\nscrB`);
    expect(str(paintAt(tl, 150))).toBe(`${CLEAR}scrA\r\nscrBX`);
    expect(str(paintAt(tl, 1000))).toBe(`${CLEAR}scrA\r\nscrBXY`);
  });

  it("shows a silent seeded pane's static seed at every instant", () => {
    const tl = timelineFor(twoPaneGroup(), 2);
    if (tl === null) throw new Error("pane 2 should be seeded");
    // Pane 2's only byte is at t=200, so before it the screen is just the seed.
    expect(str(paintAt(tl, 0))).toBe(`${CLEAR}topX\r\ntopY`);
    expect(str(paintAt(tl, 100))).toBe(`${CLEAR}topX\r\ntopY`);
    expect(str(paintAt(tl, 200))).toBe(`${CLEAR}topX\r\ntopYZ`);
  });
});

// --- the seek/play equivalence --------------------------------------------

describe("forwardDelta", () => {
  it("advances a pane without re-seeding: paintAt(from) ++ delta === paintAt(to)", () => {
    const tl = timelineFor(twoPaneGroup(), 1);
    if (tl === null) throw new Error("pane 1 should be seeded");
    for (const [from, to] of [
      [0, 150],
      [150, 1000],
      [0, 1000],
      [120, 120],
    ] as const) {
      const advanced = str(paintAt(tl, from)) + str(forwardDelta(tl, from, to));
      expect(advanced).toBe(str(paintAt(tl, to)));
    }
  });
});

// --- THE synchronization guarantee ----------------------------------------

describe("syncFrame", () => {
  it("is every linked pane at ONE shared instant", () => {
    const group = twoPaneGroup();
    const tMs = 150;
    const frame = syncFrame(group, tMs);
    expect(frame.map((p) => p.paneId)).toEqual([1, 2]);
    // Each entry equals that pane's own paintAt at the SAME instant — the bytes
    // the demo shows can never disagree with the seek primitive.
    for (const entry of frame) {
      const tl = timelineFor(group, entry.paneId);
      if (tl === null) throw new Error(`pane ${entry.paneId} unseeded`);
      expect(str(entry.bytes)).toBe(str(paintAt(tl, tMs)));
    }
    // Concretely: pane 1 has "X" by t=150; pane 2 is still on its seed.
    expect(str(frame[0].bytes)).toBe(`${CLEAR}scrA\r\nscrBX`);
    expect(str(frame[1].bytes)).toBe(`${CLEAR}topX\r\ntopY`);
  });

  it("includes only linked panes", () => {
    const group = { ...twoPaneGroup(), linked: new Set([2]) };
    expect(syncFrame(group, 200).map((p) => p.paneId)).toEqual([2]);
  });

  it("is empty when nothing is linked", () => {
    const group = { ...twoPaneGroup(), linked: new Set<number>() };
    expect(syncFrame(group, 200)).toEqual([]);
  });
});

// --- merged activity -------------------------------------------------------

describe("linkedActivity", () => {
  it("sums per-pane byte activity across the linked set into time bins", () => {
    const group = twoPaneGroup(); // dur=200: pane1 "X"@100,"Y"@200; pane2 "Z"@200
    const bins = linkedActivity(group, 2);
    // Bins split by frac = tMs/dur: "X"@100 → frac .5 → bin 1; "Y"@200 and
    // "Z"@200 → frac 1 → bin 1. So all 3 bytes land in the upper half.
    expect(bins).toEqual([0, 3]);
  });

  it("counts only linked panes", () => {
    const group = { ...twoPaneGroup(), linked: new Set([2]) };
    // Only pane 2's single "Z"@200 byte, landing in the last bin.
    expect(linkedActivity(group, 2)).toEqual([0, 1]);
  });

  it("returns an empty array for a non-positive bucket count", () => {
    expect(linkedActivity(twoPaneGroup(), 0)).toEqual([]);
  });
});
