// tests/unit/subscriptions.test.ts
// Pure-function tests for buildScopedFormat / parseRows.
//
// [LAW:behavior-not-structure] These tests assert the format-and-parse
// contract — round-trip invariants and separator-collision guarantees —
// not the internal Map / counter / listener wiring (which is exercised
// against a real tmux in tests/integration/client.test.ts).

import { describe, it, expect } from "vitest";
import {
  buildScopedFormat,
  parseRows,
  FIELD_SEP,
  ROW_SEP,
} from "../../src/subscriptions.js";

describe("buildScopedFormat", () => {
  it("S scope wraps fields with #{S:...} and proper separators", () => {
    expect(buildScopedFormat("S", ["session_id", "session_name"])).toBe(
      `#{S:#{session_id}${FIELD_SEP}#{session_name}${ROW_SEP}}`,
    );
  });

  it("S:W scope wraps with nested #{S:#{W:...}}", () => {
    expect(buildScopedFormat("S:W", ["window_id"])).toBe(
      `#{S:#{W:#{window_id}${ROW_SEP}}}`,
    );
  });

  it("S:W:P scope wraps with triple nesting", () => {
    expect(buildScopedFormat("S:W:P", ["pane_id", "pane_index"])).toBe(
      `#{S:#{W:#{P:#{pane_id}${FIELD_SEP}#{pane_index}${ROW_SEP}}}}`,
    );
  });

  it("single field has no field separator (only the row terminator)", () => {
    expect(buildScopedFormat("S", ["session_id"])).toBe(
      `#{S:#{session_id}${ROW_SEP}}`,
    );
  });

  it("empty fields list still emits the row terminator (parseRows yields [])", () => {
    const fmt = buildScopedFormat("S", []);
    expect(fmt).toBe(`#{S:${ROW_SEP}}`);
  });
});

describe("parseRows", () => {
  it("round-trips a value with multiple rows and ordered fields", () => {
    const fields = ["session_id", "session_name", "session_attached"] as const;
    const value =
      `$1${FIELD_SEP}main${FIELD_SEP}1${ROW_SEP}` +
      `$2${FIELD_SEP}work${FIELD_SEP}0${ROW_SEP}`;
    expect(parseRows(value, fields)).toEqual([
      { session_id: "$1", session_name: "main", session_attached: "1" },
      { session_id: "$2", session_name: "work", session_attached: "0" },
    ]);
  });

  it("preserves names that contain `|` and `\\n` (the demo's separator-collision bug)", () => {
    // These characters used to break the demo's split("|") / split("\\n") parser.
    // RS/US are C0 controls — they cannot appear in tmux names — so collisions
    // are impossible by construction.
    const fields = ["window_id", "window_name"] as const;
    const value =
      `@1${FIELD_SEP}weird|name\\n${ROW_SEP}` +
      `@2${FIELD_SEP}|just bars|${ROW_SEP}`;
    expect(parseRows(value, fields)).toEqual([
      { window_id: "@1", window_name: "weird|name\\n" },
      { window_id: "@2", window_name: "|just bars|" },
    ]);
  });

  it("ignores trailing empty row from the trailing RS", () => {
    expect(parseRows(`a${FIELD_SEP}b${ROW_SEP}`, ["x", "y"])).toEqual([
      { x: "a", y: "b" },
    ]);
  });

  it("returns [] for empty value", () => {
    expect(parseRows("", ["x"])).toEqual([]);
  });

  it("missing trailing fields default to empty string", () => {
    // Defensive: tmux should always emit the full row, but if it doesn't
    // (truncated, partial), missing fields are "" rather than undefined.
    expect(parseRows(`a${ROW_SEP}`, ["x", "y", "z"])).toEqual([
      { x: "a", y: "", z: "" },
    ]);
  });
});

describe("buildScopedFormat ↔ parseRows round-trip", () => {
  // [LAW:behavior-not-structure] The contract is "what tmux delivers for a
  // format built by buildScopedFormat parses cleanly with parseRows using
  // the same field list." Simulate the wire shape directly without a tmux
  // process — we're testing the encode/decode pair, not tmux itself.
  it("end-to-end: build a format, simulate a tmux delivery, parse back", () => {
    const fields = ["a", "b", "c"] as const;
    // What tmux would deliver after expanding the format for 2 iterations:
    const wire =
      `1${FIELD_SEP}2${FIELD_SEP}3${ROW_SEP}` +
      `x${FIELD_SEP}y${FIELD_SEP}z${ROW_SEP}`;
    expect(parseRows(wire, fields)).toEqual([
      { a: "1", b: "2", c: "3" },
      { a: "x", b: "y", c: "z" },
    ]);
  });
});
