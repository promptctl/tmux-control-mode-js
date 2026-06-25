// examples/web-multiplexer/web/reader-engine.test.ts
//
// Exhaustive coverage of the Terminal Reader pure core (tmux-showcase-bhx.23):
// word-wrapping, paragraph reflow, and per-pane line accumulation. The ticket
// is "exercises parsing completeness", so these tests pin the wrap/reflow
// contract — word boundaries, over-long words, blank-run collapse, continuation
// tagging — and the engine's chunk-boundary line assembly + ANSI stripping +
// per-pane isolation + cap eviction. [LAW:behavior-not-structure]

import { describe, it, expect } from "vitest";
import { ReaderEngine, reflow, wrapLine, type ReaderSegment } from "./reader-engine.ts";

describe("wrapLine", () => {
  it("returns the line unchanged when it fits", () => {
    expect(wrapLine("hello world", 40)).toEqual(["hello world"]);
  });

  it("wraps at word boundaries, never mid-word for words that fit", () => {
    expect(wrapLine("the quick brown fox", 9)).toEqual(["the quick", "brown fox"]);
  });

  it("packs greedily up to but not over the width", () => {
    // "aaa bbb" is exactly 7; width 7 keeps them together, width 6 splits.
    expect(wrapLine("aaa bbb", 7)).toEqual(["aaa bbb"]);
    expect(wrapLine("aaa bbb", 6)).toEqual(["aaa", "bbb"]);
  });

  it("hard-splits a single word longer than the width into width-sized pieces", () => {
    expect(wrapLine("abcdefgh", 3)).toEqual(["abc", "def", "gh"]);
  });

  it("hard-splits an over-long word without inserting a space inside it", () => {
    const out = wrapLine("supercalifragilistic", 5);
    expect(out).toEqual(["super", "calif", "ragil", "istic"]);
    expect(out.join("")).toBe("supercalifragilistic");
  });

  it("normalizes tabs and internal whitespace runs to single spaces", () => {
    expect(wrapLine("a\t\tb   c", 40)).toEqual(["a b c"]);
  });

  it("returns a single empty segment for a blank or whitespace-only line", () => {
    expect(wrapLine("", 40)).toEqual([""]);
    expect(wrapLine("   \t ", 40)).toEqual([""]);
  });

  it("guards a non-positive width to at least one column", () => {
    expect(wrapLine("ab", 0)).toEqual(["a", "b"]);
  });
});

describe("reflow", () => {
  function texts(segs: ReaderSegment[]): string[] {
    return segs.filter((s): s is Extract<ReaderSegment, { kind: "text" }> => s.kind === "text").map((s) => s.text);
  }

  it("is empty for no lines", () => {
    expect(reflow([], 40)).toEqual([]);
  });

  it("tags wrapped tails as continuation, first segment as not", () => {
    const segs = reflow(["the quick brown fox jumps"], 9);
    const textSegs = segs.filter((s) => s.kind === "text");
    expect(textSegs.map((s) => (s.kind === "text" ? s.continuation : null))).toEqual([
      false,
      true,
      true,
    ]);
  });

  it("numbers segments back to their 1-based source line", () => {
    const segs = reflow(["alpha", "beta gamma delta", "x"], 11);
    const lines = segs
      .filter((s): s is Extract<ReaderSegment, { kind: "text" }> => s.kind === "text")
      .map((s) => s.sourceLine);
    // line 1 → 1 seg, line 2 ("beta gamma delta" @11) → 2 segs, line 3 → 1 seg
    expect(lines).toEqual([1, 2, 2, 3]);
  });

  it("collapses a run of blank lines to a single break between text", () => {
    const segs = reflow(["a", "", "", "", "b"], 40);
    expect(segs.map((s) => s.kind)).toEqual(["text", "break", "text"]);
  });

  it("drops leading and trailing blank runs", () => {
    const segs = reflow(["", "", "only", "", ""], 40);
    expect(segs.map((s) => s.kind)).toEqual(["text"]);
    expect(texts(segs)).toEqual(["only"]);
  });

  it("never emits two breaks in a row", () => {
    const segs = reflow(["a", "", "", "b", "", "c"], 40);
    expect(segs.map((s) => s.kind)).toEqual([
      "text",
      "break",
      "text",
      "break",
      "text",
    ]);
  });

  it("assigns positional, monotonic, unique ids", () => {
    const segs = reflow(["a b c d", "", "e"], 3);
    const ids = segs.map((s) => s.id);
    expect(ids).toEqual([...ids].sort((x, y) => x - y));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("re-wraps purely when the width changes (no other state)", () => {
    const lines = ["the quick brown fox"];
    expect(texts(reflow(lines, 40))).toEqual(["the quick brown fox"]);
    expect(texts(reflow(lines, 9))).toEqual(["the quick", "brown fox"]);
  });
});

describe("ReaderEngine", () => {
  it("assembles lines across chunk boundaries and strips ANSI", () => {
    const eng = new ReaderEngine(100);
    // A red "hi" split across two chunks, then a newline.
    eng.pushBytes(1, "\x1b[31mhi");
    eng.pushBytes(1, " there\x1b[0m\nnext\n");
    expect(eng.linesFor(1)).toEqual(["hi there", "next"]);
  });

  it("buffers a trailing partial line until its newline arrives", () => {
    const eng = new ReaderEngine(100);
    eng.pushBytes(1, "complete\npartial");
    expect(eng.linesFor(1)).toEqual(["complete"]);
    eng.pushBytes(1, " line\n");
    expect(eng.linesFor(1)).toEqual(["complete", "partial line"]);
  });

  it("keeps panes isolated", () => {
    const eng = new ReaderEngine(100);
    eng.pushBytes(1, "one\n");
    eng.pushBytes(2, "two\n");
    expect(eng.linesFor(1)).toEqual(["one"]);
    expect(eng.linesFor(2)).toEqual(["two"]);
    expect(eng.tappedPaneIds).toEqual([1, 2]);
    expect(eng.tappedPaneCount).toBe(2);
  });

  it("evicts oldest lines past the per-pane cap (FIFO)", () => {
    const eng = new ReaderEngine(3);
    for (let i = 0; i < 6; i++) eng.pushBytes(1, `line${i}\n`);
    expect(eng.linesFor(1)).toEqual(["line3", "line4", "line5"]);
    expect(eng.lineCountFor(1)).toBe(3);
  });

  it("reports zero / empty for an untapped pane", () => {
    const eng = new ReaderEngine(100);
    expect(eng.linesFor(99)).toEqual([]);
    expect(eng.lineCountFor(99)).toBe(0);
  });

  it("clears all accumulated state", () => {
    const eng = new ReaderEngine(100);
    eng.pushBytes(1, "a\n");
    eng.clear();
    expect(eng.tappedPaneCount).toBe(0);
    expect(eng.linesFor(1)).toEqual([]);
  });

  it("feeds straight into reflow for a pane", () => {
    const eng = new ReaderEngine(100);
    eng.pushBytes(1, "the quick brown fox\n\nnext para\n");
    const segs = reflow(eng.linesFor(1), 9);
    // "the quick"/"brown fox" (2 segs), a break, then "next para" (1 seg).
    expect(segs.map((s) => s.kind)).toEqual([
      "text",
      "text",
      "break",
      "text",
    ]);
  });
});
