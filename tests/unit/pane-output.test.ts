// tests/unit/pane-output.test.ts
//
// Parser-level coverage for src/pane-output.ts's listPanes/listWindows line
// grammar — in particular the tab/backslash escape round-trip on
// `pane_current_path` (tmux-pane-detail-aha.fpf): a literal tab or
// backslash in a pane's cwd must not desync the tab-split and must decode
// back to its original value, not get the record silently dropped.

import { describe, it, expect } from "vitest";
import {
  parsePaneListLine,
  parsePaneRecordLine,
  parseSessionRecordLine,
  parseWindowRecordLine,
} from "../../src/pane-output.js";
import { listPanesCommand } from "../../src/protocol/encoder.js";

const BACKSLASH = "\\";
const TAB = "\t";

describe("parsePaneRecordLine", () => {
  it("parses a plain line with no escapes", () => {
    const line = ["$1", "main", "@0", "zsh", "%0", "/tmp", "123", "zsh", "zsh", "80", "24"].join(
      "\t",
    );
    expect(parsePaneRecordLine(line)).toEqual({
      sessionId: 1,
      sessionName: "main",
      windowId: 0,
      windowName: "zsh",
      paneId: 0,
      cwd: "/tmp",
      pid: 123,
      startCommand: "zsh",
      currentCommand: "zsh",
      width: 80,
      height: 24,
    });
  });

  it("decodes a cwd escaped by encoder.ts's escapeFreeTextField back to its literal tab/backslash", () => {
    // Original cwd (what tmux actually cd'd into): /tmp/a\b<TAB>c — one
    // literal backslash, one literal tab.
    const originalCwd = `/tmp/a${BACKSLASH}b${TAB}c`;
    // What escapeFreeTextField's two-step substitution produces on the wire
    // (see protocol/encoder.ts): the backslash doubles first, then the real
    // tab becomes the two-byte sequence backslash+t.
    const encodedCwd = `/tmp/a${BACKSLASH}${BACKSLASH}b${BACKSLASH}tc`;
    const line = [
      "$1",
      "main",
      "@0",
      "zsh",
      "%0",
      encodedCwd,
      "123",
      "zsh",
      "zsh",
      "80",
      "24",
    ].join("\t");
    const record = parsePaneRecordLine(line);
    expect(record).not.toBeNull();
    expect(record!.cwd).toBe(originalCwd);
    // The record was not dropped: field count stayed exactly 11 because the
    // escaped cwd contains no literal tab to desync the split.
    expect(record!.sessionName).toBe("main");
    expect(record!.pid).toBe(123);
  });

  it("decodes a cwd with only a trailing escaped backslash (no tab) correctly", () => {
    const originalCwd = `/tmp/x${BACKSLASH}`;
    const encodedCwd = `/tmp/x${BACKSLASH}${BACKSLASH}`;
    const line = [
      "$1",
      "main",
      "@0",
      "zsh",
      "%0",
      encodedCwd,
      "123",
      "zsh",
      "zsh",
      "80",
      "24",
    ].join("\t");
    expect(parsePaneRecordLine(line)!.cwd).toBe(originalCwd);
  });

  it("still returns null for an unparseable line (wrong field count)", () => {
    expect(parsePaneRecordLine("$1\tmain\t@0")).toBeNull();
  });
});

describe("parseWindowRecordLine", () => {
  it("parses a plain line with no escapes (window_name needs none — tmux rejects tabs in it)", () => {
    const line = ["$1", "main", "@0", "zsh", "80", "24"].join("\t");
    expect(parseWindowRecordLine(line)).toEqual({
      sessionId: 1,
      sessionName: "main",
      windowId: 0,
      windowName: "zsh",
      width: 80,
      height: 24,
    });
  });
});

describe("parseSessionRecordLine", () => {
  it("parses an unattached session (count 0)", () => {
    const line = ["$1", "main", "3", "0"].join("\t");
    expect(parseSessionRecordLine(line)).toEqual({
      sessionId: 1,
      sessionName: "main",
      windowCount: 3,
      attached: false,
    });
  });

  it("parses an attached session (count > 1, not just 1)", () => {
    const line = ["$1", "main", "3", "2"].join("\t");
    expect(parseSessionRecordLine(line)).toEqual({
      sessionId: 1,
      sessionName: "main",
      windowCount: 3,
      attached: true,
    });
  });

  // Regression: response-block output no longer has a trailing \r stripped
  // (parser.ts's feed() exempts it so raw pane-capture bytes survive), so
  // this field can legitimately carry one on a CRLF transport. A strict
  // string compare (`attached !== "0"`) would misread "0\r" as attached.
  it("tolerates a trailing \\r on the attached field (CRLF transport noise)", () => {
    const line = ["$1", "main", "3", "0\r"].join("\t");
    expect(parseSessionRecordLine(line)).toEqual({
      sessionId: 1,
      sessionName: "main",
      windowCount: 3,
      attached: false,
    });
  });
});

describe("parsePaneListLine", () => {
  it("parses a plain line", () => {
    expect(parsePaneListLine("%5 @2 $1")).toEqual({
      paneId: 5,
      windowId: 2,
      sessionId: 1,
    });
  });

  // Regression: this is response-block output, where TmuxParser.feed() no
  // longer strips a trailing \r (needed for raw capture-pane byte
  // fidelity), so the last line of this list can carry one on a CRLF
  // transport. The old strict end-anchored regex failed to match, so every
  // entry returned null — topology-router.ts's bootstrap()/refreshWindow()
  // then silently wiped the whole pane topology with an empty seed/update.
  it("tolerates a trailing \\r (CRLF transport noise)", () => {
    expect(parsePaneListLine("%5 @2 $1\r")).toEqual({
      paneId: 5,
      windowId: 2,
      sessionId: 1,
    });
  });
});

describe("listPanesCommand", () => {
  it("wraps only pane_current_path in the escape modifier", () => {
    const cmd = listPanesCommand();
    expect(cmd).toContain("#{s/" + TAB + "/" + BACKSLASH + BACKSLASH + "t/:");
    expect(cmd).toContain("#{pane_current_path}");
    // pane_start_command/pane_current_command appear unwrapped — tmux
    // already escapes them internally (see encoder.ts's doc comment).
    expect(cmd).toContain("\t#{pane_start_command}\t#{pane_current_command}\t");
  });
});
