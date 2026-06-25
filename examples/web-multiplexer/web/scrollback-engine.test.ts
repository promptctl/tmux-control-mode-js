// examples/web-multiplexer/web/scrollback-engine.test.ts
//
// Pure-engine tests for the scrollback time machine. No tmux, no DOM — synthetic
// snapshots + recordings in, paint-bytes out. The load-bearing invariants:
//   - the two regimes MEET at t=0: the bottom history window equals the live
//     seed, so scrubbing across the boundary never jumps.
//   - `momentBytes(live, t)` = clear ++ seed ++ bytesUpTo(t): the seed (the .5
//     gap) is always laid down before the forward delta.
//   - the Moment union is honest: a frac always resolves to exactly one regime,
//     row offsets never go negative, time never goes past the duration.

import { describe, it, expect } from "vitest";
import {
  type ScrollbackSnapshot,
  type Timeline,
  parseCaptureReply,
  historyDepth,
  splitFraction,
  resolveMoment,
  seedBytes,
  momentBytes,
} from "./scrollback-engine.ts";
import {
  buildRecording,
  type PaneGeometry,
  type RecordedChunk,
} from "./session-recording-engine.ts";

const NO_GEOMETRY = new Map<number, PaneGeometry>();

function str(bytes: Uint8Array): string {
  return String.fromCharCode(...bytes);
}

function chunk(paneId: number, tMs: number, s: string): RecordedChunk {
  return {
    paneId,
    tMs,
    bytes: new Uint8Array([...s].map((c) => c.charCodeAt(0))),
  };
}

/** A snapshot from N text rows on a `cols`×`rows` grid. */
function snap(
  paneId: number,
  cols: number,
  rows: number,
  lines: readonly string[],
): ScrollbackSnapshot {
  return parseCaptureReply(lines, { cols, rows }, paneId);
}

function timeline(
  snapshot: ScrollbackSnapshot,
  chunks: readonly RecordedChunk[],
): Timeline {
  const recording = buildRecording(chunks, NO_GEOMETRY);
  return {
    snapshot,
    recording,
    paneId: snapshot.paneId,
    durationMs: recording.durationMs,
  };
}

describe("parseCaptureReply", () => {
  it("reconstructs raw bytes from latin1 byte-faithful lines (ESC survives)", () => {
    const s = snap(1, 80, 24, ["\x1b[31mred\x1b[39m", "plain"]);
    expect(str(s.lines[0])).toBe("\x1b[31mred\x1b[39m");
    expect(s.lines[0][0]).toBe(0x1b);
    expect(str(s.lines[1])).toBe("plain");
  });

  it("preserves raw UTF-8 multibyte bytes one-per-char", () => {
    // ╭ = e2 95 ad as three latin1 chars.
    const line = "â­";
    const s = snap(1, 80, 24, [line]);
    expect([...s.lines[0]]).toEqual([0xe2, 0x95, 0xad]);
  });
});

describe("historyDepth", () => {
  it("is the count of rows above the visible screen", () => {
    const s = snap(1, 80, 3, ["h1", "h2", "v1", "v2", "v3"]); // 2 history + 3 screen
    expect(historyDepth(s)).toBe(2);
  });

  it("is zero (never negative) when the capture is shorter than the screen", () => {
    const s = snap(1, 80, 24, ["only", "two"]);
    expect(historyDepth(s)).toBe(0);
  });
});

describe("splitFraction", () => {
  it("splits the bar evenly when both history and recording exist", () => {
    const tl = timeline(snap(1, 80, 2, ["h", "v1", "v2"]), [
      chunk(1, 0, "x"),
      chunk(1, 100, "y"),
    ]);
    expect(splitFraction(tl)).toBe(0.5);
  });

  it("gives the whole bar to history when nothing was recorded", () => {
    const tl = timeline(snap(1, 80, 2, ["h", "v1", "v2"]), []);
    expect(splitFraction(tl)).toBe(1);
  });

  it("gives the whole bar to time when there is no scrollback", () => {
    const tl = timeline(snap(1, 80, 24, ["v1"]), [
      chunk(1, 0, "x"),
      chunk(1, 100, "y"),
    ]);
    expect(splitFraction(tl)).toBe(0);
  });

  it("collapses to zero when neither history nor recording exists", () => {
    const tl = timeline(snap(1, 80, 24, ["v1"]), []);
    expect(splitFraction(tl)).toBe(0);
  });
});

describe("resolveMoment", () => {
  const tl = timeline(
    snap(1, 80, 2, ["h0", "h1", "h2", "v1", "v2"]), // depth 3
    [chunk(1, 0, "a"), chunk(1, 1000, "b")],
  );

  it("maps the left edge to the top of history", () => {
    expect(resolveMoment(0, tl)).toEqual({ kind: "history", topLine: 0 });
  });

  it("maps the split point to the live screen (history bottom == t=0)", () => {
    // At the boundary the history window starts at depth (bottom rows = screen).
    expect(resolveMoment(0.5, tl)).toEqual({ kind: "history", topLine: 3 });
  });

  it("maps the right edge to the end of the recording", () => {
    expect(resolveMoment(1, tl)).toEqual({ kind: "live", tMs: 1000 });
  });

  it("maps the live-region midpoint to half the duration", () => {
    expect(resolveMoment(0.75, tl)).toEqual({ kind: "live", tMs: 500 });
  });

  it("clamps out-of-range fractions", () => {
    expect(resolveMoment(-1, tl)).toEqual({ kind: "history", topLine: 0 });
    expect(resolveMoment(2, tl)).toEqual({ kind: "live", tMs: 1000 });
  });

  it("is always live when there is no scrollback", () => {
    const liveOnly = timeline(snap(1, 80, 24, ["v"]), [
      chunk(1, 0, "a"),
      chunk(1, 200, "b"),
    ]);
    expect(resolveMoment(0, liveOnly)).toEqual({ kind: "live", tMs: 0 });
    expect(resolveMoment(1, liveOnly)).toEqual({ kind: "live", tMs: 200 });
  });

  it("is always history when nothing was recorded", () => {
    const histOnly = timeline(snap(1, 80, 2, ["h0", "h1", "v1", "v2"]), []); // depth 2
    expect(resolveMoment(0, histOnly)).toEqual({ kind: "history", topLine: 0 });
    expect(resolveMoment(1, histOnly)).toEqual({ kind: "history", topLine: 2 });
  });
});

describe("seedBytes", () => {
  it("is the bottom `rows` lines joined with CR/LF, no trailing newline", () => {
    const s = snap(1, 80, 2, ["h0", "h1", "v1", "v2"]);
    expect(str(seedBytes(s))).toBe("v1\r\nv2");
  });

  it("is all lines when the capture is shorter than the screen", () => {
    const s = snap(1, 80, 5, ["a", "b"]);
    expect(str(seedBytes(s))).toBe("a\r\nb");
  });
});

describe("momentBytes", () => {
  const CLEAR = "\x1b[0m\x1b[H\x1b[2J";

  it("history paints a cleared screen then the row window", () => {
    const tl = timeline(snap(1, 80, 2, ["h0", "h1", "v1", "v2"]), []);
    expect(str(momentBytes({ kind: "history", topLine: 0 }, tl))).toBe(
      `${CLEAR}h0\r\nh1`,
    );
    expect(str(momentBytes({ kind: "history", topLine: 1 }, tl))).toBe(
      `${CLEAR}h1\r\nv1`,
    );
  });

  it("live paints clear ++ seed ++ forward delta (the .5 gap closed)", () => {
    const tl = timeline(snap(1, 80, 2, ["h0", "v1", "v2"]), [
      chunk(1, 100, "X"),
      chunk(1, 500, "Y"),
    ]);
    // At t=0 only the seed shows; the forward bytes have not landed yet.
    expect(str(momentBytes({ kind: "live", tMs: 0 }, tl))).toBe(
      `${CLEAR}v1\r\nv2`,
    );
    // At t=200 the first forward chunk is applied on top of the seed.
    expect(str(momentBytes({ kind: "live", tMs: 200 }, tl))).toBe(
      `${CLEAR}v1\r\nv2X`,
    );
    // At the end both forward chunks are applied.
    expect(str(momentBytes({ kind: "live", tMs: 500 }, tl))).toBe(
      `${CLEAR}v1\r\nv2XY`,
    );
  });

  it("the history bottom window and the live t=0 paint the same screen", () => {
    // The regimes meet seamlessly at the boundary: scrubbing across t=0 is smooth.
    const tl = timeline(snap(1, 80, 2, ["h0", "h1", "v1", "v2"]), [
      chunk(1, 0, "z"),
    ]);
    const atBoundaryHistory = momentBytes(
      { kind: "history", topLine: historyDepth(tl.snapshot) },
      tl,
    );
    const seedScreen = str(seedBytes(tl.snapshot));
    expect(str(atBoundaryHistory)).toBe(`${CLEAR}${seedScreen}`);
  });
});
