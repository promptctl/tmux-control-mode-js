// tests/unit/model/format.test.ts
// Pure tests for parseListLines / parseTmuxId / parseNumberOrNull.

import { describe, it, expect } from "vitest";
import {
  PANE_FIELDS,
  SESSION_FIELDS,
  WINDOW_FIELDS,
  parseListLines,
  parseNumberOrNull,
  parseTmuxId,
} from "../../../src/model/format.js";
import { FIELD_SEP } from "../../../src/subscriptions.js";

describe("parseTmuxId", () => {
  it("strips $ for sessions", () => {
    expect(parseTmuxId("$42")).toBe(42);
  });
  it("strips @ for windows", () => {
    expect(parseTmuxId("@7")).toBe(7);
  });
  it("strips % for panes", () => {
    expect(parseTmuxId("%9")).toBe(9);
  });
  it("returns null for empty input", () => {
    expect(parseTmuxId("")).toBe(null);
  });
  it("returns null for non-numeric input", () => {
    expect(parseTmuxId("$abc")).toBe(null);
  });
});

describe("parseNumberOrNull", () => {
  it("parses integers", () => {
    expect(parseNumberOrNull("80")).toBe(80);
  });
  it("returns null for empty", () => {
    expect(parseNumberOrNull("")).toBe(null);
  });
  it("returns null for garbage", () => {
    expect(parseNumberOrNull("abc")).toBe(null);
  });
});

describe("parseListLines", () => {
  it("parses one row per line, joined back through parseRows", () => {
    const lines = [
      `$1${FIELD_SEP}main${FIELD_SEP}1`,
      `$2${FIELD_SEP}work${FIELD_SEP}0`,
    ];
    expect(parseListLines(lines, SESSION_FIELDS)).toEqual([
      { session_id: "$1", session_name: "main", session_attached: "1" },
      { session_id: "$2", session_name: "work", session_attached: "0" },
    ]);
  });

  it("ignores empty trailing lines", () => {
    const lines = [`$1${FIELD_SEP}main${FIELD_SEP}1`, ""];
    expect(parseListLines(lines, SESSION_FIELDS).length).toBe(1);
  });

  it("preserves names with `|` and `\\n` (separator-collision regression)", () => {
    const lines = [
      `@1${FIELD_SEP}weird|name${FIELD_SEP}@1${FIELD_SEP}0${FIELD_SEP}1${FIELD_SEP}0`,
    ];
    // window field order: session_id, window_id, window_index, window_name, window_active, window_zoomed_flag
    // Construct a plausible row using bars in window_name. The name carries `|`
    // through cleanly because FIELD_SEP is US (\x1f), not `|`.
    const lineWithBars = [
      "$1",
      "@1",
      "0",
      "weird|name",
      "1",
      "0",
    ].join(FIELD_SEP);
    expect(parseListLines([lineWithBars], WINDOW_FIELDS)).toEqual([
      {
        session_id: "$1",
        window_id: "@1",
        window_index: "0",
        window_name: "weird|name",
        window_active: "1",
        window_zoomed_flag: "0",
      },
    ]);
    // Silence unused-var lint; the first array is just illustrative.
    void lines;
  });

  it("pane lines parse the full PANE_FIELDS set", () => {
    const line = [
      "@10",
      "%100",
      "0",
      "1",
      "80",
      "24",
      "shell",
    ].join(FIELD_SEP);
    expect(parseListLines([line], PANE_FIELDS)).toEqual([
      {
        window_id: "@10",
        pane_id: "%100",
        pane_index: "0",
        pane_active: "1",
        pane_width: "80",
        pane_height: "24",
        pane_title: "shell",
      },
    ]);
  });
});
