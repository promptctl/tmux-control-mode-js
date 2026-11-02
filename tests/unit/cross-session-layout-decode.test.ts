// tests/unit/cross-session-layout-decode.test.ts
// Pure decode-logic tests for the cross-session layout relay (no tmux, no
// I/O) — see tests/integration/cross-session-layout.test.ts for the
// real-tmux end-to-end repro.

import { describe, it, expect } from "vitest";
import {
  decodeEntries,
  diffAgainstLastProcessed,
} from "../../src/cross-session-layout.js";

describe("decodeEntries", () => {
  it("decodes a single well-formed entry", () => {
    const { entries, skips } = decodeEntries("$1:@2,");
    expect(entries).toEqual([{ sessionId: 1, windowId: 2 }]);
    expect(skips).toEqual([]);
  });

  it("decodes multiple entries from one same-tick burst", () => {
    const { entries, skips } = decodeEntries("$1:@2,$3:@4,$5:@6,");
    expect(entries).toEqual([
      { sessionId: 1, windowId: 2 },
      { sessionId: 3, windowId: 4 },
      { sessionId: 5, windowId: 6 },
    ]);
    expect(skips).toEqual([]);
  });

  it("returns nothing for an empty remainder", () => {
    expect(decodeEntries("")).toEqual({ entries: [], skips: [] });
  });

  it("skips a CAP-truncation-sheared leading fragment and recovers the next real entry", () => {
    // Reproduces the live finding: CAP=10 truncation left ":@1,$2:@2," —
    // the first fragment is missing its `$` sigil entirely.
    const { entries, skips } = decodeEntries(":@1,$2:@2,");
    expect(skips).toEqual([{ skippedBytes: 4 }]);
    expect(entries).toEqual([{ sessionId: 2, windowId: 2 }]);
  });

  it("does not misparse a sheared fragment as a plausible-but-wrong id", () => {
    // A fragment that still starts with `$` but is missing its trailing
    // window id must not be accepted as a match for the NEXT entry's `$`.
    const { entries, skips } = decodeEntries("$1:@,$2:@2,");
    expect(skips).toEqual([{ skippedBytes: 5 }]);
    expect(entries).toEqual([{ sessionId: 2, windowId: 2 }]);
  });

  it("stops without a diagnostic on an incomplete trailing entry (no comma yet)", () => {
    const { entries, skips } = decodeEntries("$1:@2,$3:@4");
    expect(entries).toEqual([{ sessionId: 1, windowId: 2 }]);
    expect(skips).toEqual([]);
  });
});

describe("diffAgainstLastProcessed", () => {
  it("returns only the new suffix when the value extends what was last processed", () => {
    expect(diffAgainstLastProcessed("$1:@2,$3:@4,", "$1:@2,")).toBe(
      "$3:@4,",
    );
  });

  it("returns the whole value on first delivery (empty lastProcessedValue)", () => {
    expect(diffAgainstLastProcessed("$1:@2,", "")).toBe("$1:@2,");
  });

  it("returns the whole value when a trim or CAP truncation moved the buffer", () => {
    // Trim ran: buffer is now shorter than what was last processed.
    expect(diffAgainstLastProcessed("", "$1:@2,")).toBe("");
    // CAP truncation: buffer no longer starts with the old prefix.
    expect(diffAgainstLastProcessed(":@1,$2:@2,", "$9:@9,")).toBe(
      ":@1,$2:@2,",
    );
  });

  it("returns empty when the delivered value exactly repeats what was already processed", () => {
    expect(diffAgainstLastProcessed("$1:@2,", "$1:@2,")).toBe("");
  });
});
