// examples/web-multiplexer/web/webgl-grid-sink.test.ts
//
// Behavior tests for WebGLGridSink as a TerminalSink: what the grid shows after
// the calls a PaneStream makes. [LAW:behavior-not-structure]

import { describe, it, expect } from "vitest";
import { WebGLGridSink } from "./webgl-grid-sink.ts";

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
