// examples/web-multiplexer/web/trigram-index.test.ts
import { describe, it, expect } from "vitest";
import { TrigramIndex } from "./trigram-index.ts";

/** Resolve candidates against real text, mirroring SearchStore's verify step. */
function search(
  index: TrigramIndex,
  docs: Map<number, string>,
  needle: string,
  caseSensitive = false,
): number[] {
  const cand = index.candidates(needle);
  const ids = cand === null ? [...docs.keys()] : [...cand];
  const ndl = caseSensitive ? needle : needle.toLowerCase();
  return ids
    .filter((id) => {
      const text = docs.get(id);
      if (text === undefined) return false;
      const hay = caseSensitive ? text : text.toLowerCase();
      return hay.includes(ndl);
    })
    .sort((a, b) => a - b);
}

function build(lines: Record<number, string>): {
  index: TrigramIndex;
  docs: Map<number, string>;
} {
  const index = new TrigramIndex();
  const docs = new Map<number, string>();
  for (const [id, text] of Object.entries(lines)) {
    index.addDoc(Number(id), text);
    docs.set(Number(id), text);
  }
  return { index, docs };
}

describe("TrigramIndex", () => {
  it("narrows to candidates that verify as real substring matches", () => {
    const { index, docs } = build({
      1: "npm install failed",
      2: "build succeeded",
      3: "npm run test",
    });
    expect(search(index, docs, "npm")).toEqual([1, 3]);
    expect(search(index, docs, "install")).toEqual([1]);
  });

  it("returns no candidates when a needle trigram was never indexed", () => {
    const { index } = build({ 1: "hello world" });
    // 'zzz' never appears → guaranteed empty, no full scan needed.
    expect(index.candidates("zzz")).toEqual(new Set());
  });

  it("returns null for needles shorter than a trigram (caller must scan)", () => {
    const { index } = build({ 1: "abc" });
    expect(index.candidates("ab")).toBeNull();
    expect(index.candidates("a")).toBeNull();
  });

  it("matches case-insensitively by default, case-sensitively on request", () => {
    const { index, docs } = build({ 1: "ERROR: boom", 2: "no error here" });
    expect(search(index, docs, "error")).toEqual([1, 2]);
    expect(search(index, docs, "error", true)).toEqual([2]);
    expect(search(index, docs, "ERROR", true)).toEqual([1]);
  });

  it("candidates are a superset — order-scrambled trigrams still verify out", () => {
    const { index, docs } = build({ 1: "abcxyz" });
    // 'abc' and 'xyz' trigrams both present individually, but "abcz" is not a
    // real substring. Candidate may include doc 1; verify must reject it.
    expect(search(index, docs, "abcz")).toEqual([]);
  });

  it("removeDoc drops a line from future results", () => {
    const { index, docs } = build({ 1: "deletable line", 2: "keep this" });
    expect(search(index, docs, "line")).toEqual([1]);
    index.removeDoc(1, "deletable line");
    docs.delete(1);
    expect(search(index, docs, "line")).toEqual([]);
  });

  it("removeDoc only prunes a trigram posting when no doc references it", () => {
    const { index } = build({ 1: "shared", 2: "shared" });
    const before = index.trigramCount;
    index.removeDoc(1, "shared");
    // 'sha','har','are','red' still referenced by doc 2 → count unchanged.
    expect(index.trigramCount).toBe(before);
    index.removeDoc(2, "shared");
    expect(index.trigramCount).toBe(0);
  });
});
