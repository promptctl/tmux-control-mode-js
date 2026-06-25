// examples/web-multiplexer/web/session-recording-engine.test.ts
//
// Pure-engine tests for the record/replay model. No tmux, no DOM — every case
// is synthetic chunks in, reconstructed bytes out. The load-bearing invariant
// (asserted directly below) is COMPOSITION: bytesUpTo(a) ++ bytesBetween(a, b)
// === bytesUpTo(b), which is what lets the view paint forward deltas during
// playback and re-seek only on a backward jump.

import { describe, it, expect } from "vitest";
import {
  EMPTY_RECORDING,
  buildRecording,
  bytesUpTo,
  bytesBetween,
  activityHistogram,
  busiestPane,
  type RecordedChunk,
  type PaneGeometry,
} from "./session-recording-engine.ts";

/** Bytes from a string's char codes — readable fixtures. */
function b(s: string): Uint8Array {
  return new Uint8Array([...s].map((c) => c.charCodeAt(0)));
}

function chunk(paneId: number, tMs: number, s: string): RecordedChunk {
  return { paneId, tMs, bytes: b(s) };
}

function str(bytes: Uint8Array): string {
  return String.fromCharCode(...bytes);
}

const NO_GEOMETRY = new Map<number, PaneGeometry>();

describe("buildRecording", () => {
  it("freezes the empty buffer into the empty recording", () => {
    const rec = buildRecording([], NO_GEOMETRY);
    expect(rec.chunks).toEqual([]);
    expect(rec.durationMs).toBe(0);
    expect(rec.panes).toEqual([]);
  });

  it("EMPTY_RECORDING is the same shape as building from no chunks", () => {
    expect(EMPTY_RECORDING.durationMs).toBe(0);
    expect(EMPTY_RECORDING.panes).toEqual([]);
    expect(EMPTY_RECORDING.chunks).toEqual([]);
  });

  it("duration is the last (max) chunk timestamp", () => {
    const rec = buildRecording(
      [chunk(1, 0, "a"), chunk(1, 250, "b"), chunk(1, 900, "c")],
      NO_GEOMETRY,
    );
    expect(rec.durationMs).toBe(900);
  });

  it("aggregates byte + chunk counts per pane in first-appearance order", () => {
    const rec = buildRecording(
      [
        chunk(7, 0, "hello"), // pane 7 first
        chunk(3, 10, "hi"), // pane 3 second
        chunk(7, 20, "!"),
      ],
      NO_GEOMETRY,
    );
    expect(rec.panes.map((p) => p.paneId)).toEqual([7, 3]);
    expect(rec.panes[0]).toMatchObject({
      paneId: 7,
      byteCount: 6,
      chunkCount: 2,
    });
    expect(rec.panes[1]).toMatchObject({
      paneId: 3,
      byteCount: 2,
      chunkCount: 1,
    });
  });

  it("attaches captured geometry to its pane, null when uncaptured", () => {
    const geometry = new Map<number, PaneGeometry>([[1, { cols: 120, rows: 40 }]]);
    const rec = buildRecording(
      [chunk(1, 0, "x"), chunk(2, 5, "y")],
      geometry,
    );
    expect(rec.panes[0].geometry).toEqual({ cols: 120, rows: 40 });
    expect(rec.panes[1].geometry).toBeNull();
  });

  it("does not alias the input chunk array", () => {
    const input = [chunk(1, 0, "a")];
    const rec = buildRecording(input, NO_GEOMETRY);
    input.push(chunk(1, 1, "b"));
    expect(rec.chunks).toHaveLength(1);
  });
});

describe("bytesUpTo", () => {
  const rec = buildRecording(
    [chunk(1, 0, "a"), chunk(1, 100, "b"), chunk(1, 200, "c"), chunk(2, 50, "Z")],
    NO_GEOMETRY,
  );

  it("includes only the target pane, in capture order", () => {
    expect(str(bytesUpTo(rec, 1, 1000))).toBe("abc");
    expect(str(bytesUpTo(rec, 2, 1000))).toBe("Z");
  });

  it("is inclusive of a chunk at exactly toMs", () => {
    expect(str(bytesUpTo(rec, 1, 100))).toBe("ab");
  });

  it("excludes chunks after toMs", () => {
    expect(str(bytesUpTo(rec, 1, 99))).toBe("a");
  });

  it("returns empty before the first chunk", () => {
    expect(bytesUpTo(rec, 1, -1)).toHaveLength(0);
  });

  it("returns empty for an unknown pane", () => {
    expect(bytesUpTo(rec, 999, 1000)).toHaveLength(0);
  });
});

describe("bytesBetween", () => {
  const rec = buildRecording(
    [chunk(1, 0, "a"), chunk(1, 100, "b"), chunk(1, 200, "c"), chunk(1, 200, "d")],
    NO_GEOMETRY,
  );

  it("is exclusive on fromMs, inclusive on toMs", () => {
    // (100, 200] excludes the chunk at 100, includes both at 200.
    expect(str(bytesBetween(rec, 1, 100, 200))).toBe("cd");
  });

  it("empty when the window spans no chunk", () => {
    expect(bytesBetween(rec, 1, 100, 100)).toHaveLength(0);
    expect(bytesBetween(rec, 1, 201, 300)).toHaveLength(0);
  });
});

describe("composition invariant", () => {
  // The property the playback driver relies on: seeking to `a` then writing the
  // forward delta to `b` lands on exactly the same bytes as seeking to `b`.
  const rec = buildRecording(
    [
      chunk(1, 0, "frame0"),
      chunk(1, 33, "\x1b[2J"),
      chunk(1, 66, "frame1"),
      chunk(1, 66, "tie"), // same-timestamp chunk straddling a boundary
      chunk(1, 120, "frame2"),
    ],
    NO_GEOMETRY,
  );

  it("bytesUpTo(a) ++ bytesBetween(a,b) === bytesUpTo(b) across many splits", () => {
    const cuts = [-1, 0, 33, 50, 66, 100, 120, 200];
    for (const a of cuts) {
      for (const b2 of cuts) {
        if (b2 < a) continue;
        const split = str(bytesUpTo(rec, 1, a)) + str(bytesBetween(rec, 1, a, b2));
        expect(split).toBe(str(bytesUpTo(rec, 1, b2)));
      }
    }
  });
});

describe("activityHistogram", () => {
  it("returns [] for a non-positive bucket count", () => {
    const rec = buildRecording([chunk(1, 0, "x")], NO_GEOMETRY);
    expect(activityHistogram(rec, 1, 0)).toEqual([]);
    expect(activityHistogram(rec, 1, -3)).toEqual([]);
  });

  it("returns all-zero bins for a zero-duration recording", () => {
    const rec = buildRecording([chunk(1, 0, "x")], NO_GEOMETRY);
    expect(activityHistogram(rec, 1, 4)).toEqual([0, 0, 0, 0]);
  });

  it("buckets bytes into equal time bins; last bin is right-inclusive", () => {
    const rec = buildRecording(
      [
        chunk(1, 0, "aa"), // bin 0
        chunk(1, 250, "bbb"), // bin 1 (250/1000 * 4 = 1.0 -> floor 1)
        chunk(1, 1000, "c"), // exactly durationMs -> clamped into last bin (3)
      ],
      NO_GEOMETRY,
    );
    const bins = activityHistogram(rec, 1, 4);
    expect(bins[0]).toBe(2);
    expect(bins[1]).toBe(3);
    expect(bins[3]).toBe(1);
  });

  it("ignores other panes' bytes", () => {
    const rec = buildRecording(
      [chunk(1, 0, "aa"), chunk(2, 500, "ZZZZZ")],
      NO_GEOMETRY,
    );
    const bins = activityHistogram(rec, 1, 2);
    expect(bins.reduce((a, x) => a + x, 0)).toBe(2);
  });
});

describe("busiestPane", () => {
  it("is null for an empty recording", () => {
    expect(busiestPane(EMPTY_RECORDING)).toBeNull();
  });

  it("picks the pane with the most bytes", () => {
    const rec = buildRecording(
      [chunk(1, 0, "ab"), chunk(2, 0, "abcdef"), chunk(3, 0, "abc")],
      NO_GEOMETRY,
    );
    expect(busiestPane(rec)).toBe(2);
  });
});
