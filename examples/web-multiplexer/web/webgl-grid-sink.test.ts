// examples/web-multiplexer/web/webgl-grid-sink.test.ts
//
// Behavior tests for WebGLGridSink as a TerminalSink: what the grid shows after
// the calls a PaneStream makes. [LAW:behavior-not-structure]

import { describe, it, expect } from "vitest";
import { WebGLGridSink } from "./webgl-grid-sink.ts";
import {
  buildSeed,
  parseSeedState,
} from "../../../src/window-terminal/engine/seed-builder.ts";

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

function row(sink: WebGLGridSink, r: number): string {
  const { cols, cells } = sink.grid;
  return cells
    .slice(r * cols, (r + 1) * cols)
    .map((c) => c?.char ?? " ")
    .join("")
    .trimEnd();
}

describe("WebGLGridSink", () => {
  it("draws a PaneStream seed's rows one per line", () => {
    // The seed's row separator saves and restores the cursor around a line
    // feed; a sink that skipped the save/restore would step two rows each.
    const sink = new WebGLGridSink({ cols: 10, rows: 5 });
    const state = parseSeedState("0;4;1;0;0;0;0;1;0;5;0;0;4;10");
    if (state === null) throw new Error("state line rejected");
    sink.seed(buildSeed(["a", "b", "c", "d", "e"], state, 0).captured, []);
    expect([0, 1, 2, 3, 4].map((r) => row(sink, r))).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
    ]);
  });

  it("a seed supersedes what the sink showed, before and after a resize", () => {
    const sink = new WebGLGridSink({ cols: 10, rows: 2 });
    sink.write(bytes("old"));
    sink.seed(bytes("new"), [bytes("!")]);
    expect(row(sink, 0)).toBe("new!");

    // A resize replays the retained bytes: the replay starts at the seed, not
    // at the bytes the seed already contains.
    sink.resize(12, 2);
    expect(row(sink, 0)).toBe("new!");
  });
});
