// tests/unit/tmux-compat.test.ts
// Unit tests for the canonical tmux version constants module.
//
// [LAW:verifiable-goals] `src/tmux-compat.ts` is the single source of truth
// for the library's tmux version requirements. These tests are the machine
// check that the helpers behave correctly across the inputs we expect from
// `tmux -V` (suffix letters, multi-digit majors, missing versions) and
// across the comparison cases the integration gate relies on.

import { describe, it, expect } from "vitest";
import {
  MIN_TMUX_VERSION,
  REQUEST_REPORT_MIN_VERSION,
  parseTmuxVersion,
  meetsTmuxVersion,
} from "../../src/tmux-compat.js";

describe("MIN_TMUX_VERSION", () => {
  it("is 3.2 (the load-bearing floor documented in README Compatibility)", () => {
    expect(MIN_TMUX_VERSION).toEqual({ major: 3, minor: 2 });
  });
});

describe("REQUEST_REPORT_MIN_VERSION", () => {
  it("is 3.5 (refresh-client -r is rejected by tmux <3.5)", () => {
    expect(REQUEST_REPORT_MIN_VERSION).toEqual({ major: 3, minor: 5 });
  });
});

describe("parseTmuxVersion", () => {
  it.each([
    ["tmux 3.5", { major: 3, minor: 5 }],
    ["tmux 3.2", { major: 3, minor: 2 }],
    ["tmux 3.5a", { major: 3, minor: 5 }], // suffix letter ignored
    ["tmux next-3.5", { major: 3, minor: 5 }], // prerelease tag ignored
    ["3.5", { major: 3, minor: 5 }], // bare version, no prefix
    ["tmux 10.0", { major: 10, minor: 0 }], // multi-digit major
    ["tmux 3.10", { major: 3, minor: 10 }], // multi-digit minor
  ])("parses %j → %j", (input, expected) => {
    expect(parseTmuxVersion(input)).toEqual(expected);
  });

  it.each([
    [""],
    ["tmux"],
    ["no version in this string"],
  ])("returns null for %j", (input) => {
    expect(parseTmuxVersion(input)).toBeNull();
  });
});

describe("meetsTmuxVersion", () => {
  // Boundary: equal versions
  it("equal versions meet", () => {
    expect(meetsTmuxVersion({ major: 3, minor: 5 }, { major: 3, minor: 5 })).toBe(true);
  });

  // Minor over / under
  it("higher minor meets", () => {
    expect(meetsTmuxVersion({ major: 3, minor: 6 }, { major: 3, minor: 5 })).toBe(true);
  });
  it("lower minor does not meet", () => {
    expect(meetsTmuxVersion({ major: 3, minor: 4 }, { major: 3, minor: 5 })).toBe(false);
  });

  // Major over / under (minor irrelevant)
  it("higher major meets even with lower minor", () => {
    expect(meetsTmuxVersion({ major: 4, minor: 0 }, { major: 3, minor: 5 })).toBe(true);
  });
  it("lower major does not meet even with higher minor", () => {
    expect(meetsTmuxVersion({ major: 2, minor: 99 }, { major: 3, minor: 5 })).toBe(false);
  });

  // Real-world integration-gate cases
  it("tmux 3.5 meets REQUEST_REPORT_MIN_VERSION", () => {
    expect(meetsTmuxVersion({ major: 3, minor: 5 }, REQUEST_REPORT_MIN_VERSION)).toBe(true);
  });
  it("tmux 3.4 does not meet REQUEST_REPORT_MIN_VERSION (rejects -r)", () => {
    expect(meetsTmuxVersion({ major: 3, minor: 4 }, REQUEST_REPORT_MIN_VERSION)).toBe(false);
  });
  it("tmux 3.2 meets MIN_TMUX_VERSION (the documented floor)", () => {
    expect(meetsTmuxVersion({ major: 3, minor: 2 }, MIN_TMUX_VERSION)).toBe(true);
  });
});
