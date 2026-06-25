// examples/web-multiplexer/web/regex-match-engine.test.ts
import { describe, it, expect } from "vitest";
import { RegexMatchEngine } from "./regex-match-engine.ts";

describe("RegexMatchEngine", () => {
  it("emits nothing while no pattern is set, even on matching text", () => {
    const eng = new RegexMatchEngine(100);
    expect(eng.pushBytes(0, "ERROR here\n")).toEqual([]);
    expect(eng.matches).toEqual([]);
  });

  it("matches a completed line and reports the exact span", () => {
    const eng = new RegexMatchEngine(100);
    eng.setPattern(/ERROR/);
    const added = eng.pushBytes(7, "an ERROR occurred\n");
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      paneId: 7,
      text: "an ERROR occurred",
      matchStart: 3,
      matchLen: 5,
    });
  });

  it("only matches once a line's newline has arrived (no partial lines)", () => {
    const eng = new RegexMatchEngine(100);
    eng.setPattern(/WARN/);
    expect(eng.pushBytes(1, "this is a WARN")).toEqual([]); // no newline yet
    const added = eng.pushBytes(1, "ING line\n");
    expect(added).toHaveLength(1);
    expect(added[0].text).toBe("this is a WARNING line");
  });

  it("reassembles a match split across chunk boundaries", () => {
    const eng = new RegexMatchEngine(100);
    eng.setPattern(/needle/);
    expect(eng.pushBytes(2, "haystack nee")).toEqual([]);
    const added = eng.pushBytes(2, "dle haystack\n");
    expect(added).toHaveLength(1);
    expect(added[0].text).toBe("haystack needle haystack");
    expect(added[0].matchStart).toBe(9);
  });

  it("strips ANSI before matching, so the span indexes plain text", () => {
    const eng = new RegexMatchEngine(100);
    eng.setPattern(/red/);
    const added = eng.pushBytes(0, "\x1b[31mred\x1b[0m alert\n");
    expect(added).toHaveLength(1);
    expect(added[0].text).toBe("red alert");
    expect(added[0].matchStart).toBe(0);
    expect(added[0].matchLen).toBe(3);
  });

  it("honors RegExp flags (case-insensitive) supplied by the caller", () => {
    const eng = new RegexMatchEngine(100);
    eng.setPattern(/error/i);
    expect(eng.pushBytes(0, "Fatal ERROR\n")).toHaveLength(1);
  });

  it("is not made stateful by a stray global flag", () => {
    const eng = new RegexMatchEngine(100);
    eng.setPattern(/x/g);
    // Without lastIndex reset, the second line would be skipped.
    expect(eng.pushBytes(0, "x one\n")).toHaveLength(1);
    expect(eng.pushBytes(0, "x two\n")).toHaveLength(1);
  });

  it("keeps matches from multiple panes in one chronological feed", () => {
    const eng = new RegexMatchEngine(100);
    eng.setPattern(/hit/);
    eng.pushBytes(1, "hit alpha\n");
    eng.pushBytes(2, "hit beta\n");
    eng.pushBytes(1, "hit alpha2\n");
    const ids = eng.matches.map((m) => m.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b)); // monotonic
    expect(eng.matches.map((m) => m.paneId)).toEqual([1, 2, 1]);
    expect(eng.tappedPaneCount).toBe(2);
  });

  it("bounds the feed to its capacity, evicting oldest first", () => {
    const eng = new RegexMatchEngine(3);
    eng.setPattern(/n/);
    for (let i = 0; i < 6; i++) eng.pushBytes(0, `line${i} n\n`);
    expect(eng.matches).toHaveLength(3);
    expect(eng.matches.map((m) => m.text)).toEqual([
      "line3 n",
      "line4 n",
      "line5 n",
    ]);
  });

  it("resets the feed when the pattern changes (grep-from-now semantics)", () => {
    const eng = new RegexMatchEngine(100);
    eng.setPattern(/a/);
    eng.pushBytes(0, "alpha\n");
    expect(eng.matches).toHaveLength(1);
    eng.setPattern(/b/);
    expect(eng.matches).toEqual([]); // prior matches dropped
    eng.pushBytes(0, "bravo\n");
    expect(eng.matches).toHaveLength(1);
    expect(eng.matches[0].text).toBe("bravo");
  });

  it("truncates pathologically long lines before matching", () => {
    const eng = new RegexMatchEngine(100);
    eng.setPattern(/A/);
    const huge = "A".repeat(20000);
    const added = eng.pushBytes(0, `${huge}\n`);
    expect(added).toHaveLength(1);
    expect(added[0].text.length).toBe(8192);
  });

  it("clear() drops matches and per-pane carry-over", () => {
    const eng = new RegexMatchEngine(100);
    eng.setPattern(/z/);
    eng.pushBytes(0, "partial z"); // no newline — carried
    eng.pushBytes(1, "zed\n");
    expect(eng.matches).toHaveLength(1);
    eng.clear();
    expect(eng.matches).toEqual([]);
    expect(eng.tappedPaneCount).toBe(0);
  });
});
