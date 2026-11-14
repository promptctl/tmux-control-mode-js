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

// One list-panes line in listPanesCommand()'s field order, any field
// overridden by name.
const PANE_FIELDS = {
  sessionId: "$1",
  sessionName: "main",
  windowId: "@0",
  windowName: "zsh",
  paneId: "%0",
  dead: "0",
  cwd: "/tmp",
  pid: "123",
  startCommand: "zsh",
  currentCommand: "zsh",
  width: "80",
  height: "24",
};
function paneLine(fields: Partial<typeof PANE_FIELDS> = {}): string {
  return Object.values({ ...PANE_FIELDS, ...fields }).join("\t");
}

describe("parsePaneRecordLine", () => {
  it("parses a running pane's line", () => {
    expect(parsePaneRecordLine(paneLine())).toEqual({
      sessionId: 1,
      sessionName: "main",
      windowId: 0,
      windowName: "zsh",
      paneId: 0,
      process: {
        state: "running",
        pid: 123,
        cwd: "/tmp",
        currentCommand: "zsh",
      },
      startCommand: "zsh",
      width: 80,
      height: 24,
    });
  });

  // What tmux 3.8 reports for `new-window -E`: no pid, no path, and the
  // default shell's name as the current command.
  it("parses an empty pane (no pid, not dead) as empty, with no pid, cwd or command", () => {
    const line = paneLine({
      cwd: "",
      pid: "",
      startCommand: "",
      currentCommand: "bash",
    });
    expect(parsePaneRecordLine(line)?.process).toEqual({ state: "empty" });
  });

  // What tmux 3.7 reports for `split-window -I`: pid 0, which no process has.
  it("parses an empty pane whose pid tmux renders as 0 as empty", () => {
    const line = paneLine({ cwd: "", pid: "0", currentCommand: "bash" });
    expect(parsePaneRecordLine(line)?.process).toEqual({ state: "empty" });
  });

  it("parses a dead pane as dead, whether tmux kept its pid (3.7) or not (3.8)", () => {
    for (const pid of ["", "619"]) {
      const line = paneLine({
        dead: "1",
        cwd: "",
        pid,
        currentCommand: "sleep",
      });
      expect(parsePaneRecordLine(line)?.process).toEqual({ state: "dead" });
    }
  });

  it("parses a running pane whose cwd tmux cannot read as cwd null", () => {
    expect(parsePaneRecordLine(paneLine({ cwd: "" }))?.process).toEqual({
      state: "running",
      pid: 123,
      cwd: null,
      currentCommand: "zsh",
    });
  });

  it("decodes a cwd escaped by encoder.ts's escapeFreeTextField back to its literal tab/backslash", () => {
    // Original cwd (what tmux actually cd'd into): /tmp/a\b<TAB>c — one
    // literal backslash, one literal tab.
    const originalCwd = `/tmp/a${BACKSLASH}b${TAB}c`;
    // What escapeFreeTextField's two-step substitution produces on the wire
    // (see protocol/encoder.ts): the backslash doubles first, then the real
    // tab becomes the two-byte sequence backslash+t, so the escaped cwd holds
    // no literal tab to desync the split.
    const encodedCwd = `/tmp/a${BACKSLASH}${BACKSLASH}b${BACKSLASH}tc`;
    const record = parsePaneRecordLine(paneLine({ cwd: encodedCwd }));
    expect(record?.process).toEqual({
      state: "running",
      pid: 123,
      cwd: originalCwd,
      currentCommand: "zsh",
    });
  });

  it("decodes a current command escaped by escapeFreeTextField back to its literal tab/backslash", () => {
    const encoded = `a${BACKSLASH}${BACKSLASH}b${BACKSLASH}tc`;
    const record = parsePaneRecordLine(paneLine({ currentCommand: encoded }));
    expect(record?.process).toEqual({
      state: "running",
      pid: 123,
      cwd: "/tmp",
      currentCommand: `a${BACKSLASH}b${TAB}c`,
    });
  });

  it("decodes a cwd with only a trailing escaped backslash (no tab) correctly", () => {
    const encodedCwd = `/tmp/x${BACKSLASH}${BACKSLASH}`;
    const record = parsePaneRecordLine(paneLine({ cwd: encodedCwd }));
    expect(record?.process).toMatchObject({ cwd: `/tmp/x${BACKSLASH}` });
  });

  it("reads a line that keeps a trailing \\r run (CRLF transport noise)", () => {
    expect(parsePaneRecordLine(`${paneLine()}\r\r`)?.height).toBe(24);
  });

  it.each([
    ["a wrong field count", "$1\tmain\t@0"],
    ["a pane_dead other than 0 or 1", paneLine({ dead: "" })],
    ["a pid that is not an unsigned integer", paneLine({ pid: "12abc" })],
    ["an id without its sigil", paneLine({ paneId: "0" })],
    ["an id with another id's sigil", paneLine({ windowId: "$0" })],
    ["a size that is not an unsigned integer", paneLine({ width: "x" })],
  ])("returns null for %s", (_, line) => {
    expect(parsePaneRecordLine(line)).toBeNull();
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

  it("returns null for an id or size that is not an unsigned integer, never NaN", () => {
    expect(parseWindowRecordLine("$1\tmain\t@x\tzsh\t80\t24")).toBeNull();
    expect(parseWindowRecordLine("$1\tmain\t@0\tzsh\t80\t-1")).toBeNull();
  });
});

describe("parseSessionRecordLine", () => {
  it("returns null for a count that is not an unsigned integer, never NaN", () => {
    expect(parseSessionRecordLine("$1\tmain\t3\tx")).toBeNull();
    expect(parseSessionRecordLine("$1\tmain\t\t0")).toBeNull();
  });

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
      floating: false,
    });
  });

  it("reads the floating flag, and an empty one (older tmux) as tiled", () => {
    expect(parsePaneListLine("%5 @2 $1 1")?.floating).toBe(true);
    expect(parsePaneListLine("%5 @2 $1 0")?.floating).toBe(false);
    expect(parsePaneListLine("%5 @2 $1 ")?.floating).toBe(false);
    expect(parsePaneListLine("%5 @2 $1 1\r")?.floating).toBe(true);
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
      floating: false,
    });
  });

  // Regression: a doubled-up CRLF transport can leave a run of \r's, not
  // just one (parser.ts's processLine() already tolerates an arbitrary
  // run). A single-\r-tolerant anchor would fail to match "...$1\r\r" and
  // return null, which — per this function's own doc comment — silently
  // wipes the pane topology.
  it("tolerates a doubled trailing \\r\\r too", () => {
    expect(parsePaneListLine("%5 @2 $1\r\r")).toEqual({
      paneId: 5,
      windowId: 2,
      sessionId: 1,
      floating: false,
    });
  });

  it("does not parse an id past Number.MAX_SAFE_INTEGER", () => {
    expect(parsePaneListLine("%9007199254740993 @2 $1")).toBeNull();
  });
});

describe("listPanesCommand", () => {
  it("wraps pane_current_path and pane_current_command in the escape modifier", () => {
    const cmd = listPanesCommand();
    const escaped = (field: string) =>
      `#{s/${TAB}/${BACKSLASH}${BACKSLASH}t/:#{s/${BACKSLASH}${BACKSLASH}/${BACKSLASH.repeat(4)}/:#{${field}}}}`;
    expect(cmd).toContain(escaped("pane_current_path"));
    expect(cmd).toContain(escaped("pane_current_command"));
    expect(cmd).toContain("\t#{pane_id}\t#{pane_dead}\t");
    // pane_start_command appears unwrapped — tmux already escapes it (see
    // encoder.ts's doc comment).
    expect(cmd).toContain("\t#{pane_start_command}\t");
  });
});
