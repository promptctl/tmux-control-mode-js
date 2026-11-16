// tests/unit/window-terminal/seed-builder.test.ts
//
// Isolation tests for buildSeed — the pure tmux capture-grid reconstruction
// extracted from PaneStream.seed() (GM6 / tmux-complexity-lkg.8). It has NO
// client, async, or state dependency, so these tests call it with plain
// strings and assert only its observable contract: the seed bytes it produces
// and the cursor it parses.
//
// [LAW:behavior-not-structure] Assertions target the returned Seed value
//   (decoded bytes, cursor), never internals. The PaneStream integration tests
//   (pane-stream.test.ts) drive the same algorithm through attach(); passing
//   both proves the extraction was behavior-preserving.

import { describe, it, expect } from "vitest";
import { Terminal } from "@xterm/headless";
import { buildSeed } from "../../../src/window-terminal/engine/seed-builder.js";

const ESC = "\x1b";
// Every seed clears the screen before drawing: cursor home, SGR reset, ED 2.
const CLEAR = `${ESC}[H${ESC}[0m${ESC}[2J`;
// Seed bytes are raw (same kind as live write()); decode Latin-1 losslessly to
// inspect them as text — mirrors how a TerminalSink treats the payload.
const text = (bytes: Uint8Array): string =>
  new TextDecoder("latin1").decode(bytes);

describe("buildSeed: byte fidelity", () => {
  it("round-trips raw 8-bit bytes without UTF-8 substitution", () => {
    // An empty state line yields no cursor, no modes, no padding — so the
    // captured bytes are the clear, then exactly the screen content.
    const { captured } = buildSeed(["\x80\xff\x00"], "", 2000, 2000);
    expect(Array.from(captured.subarray(CLEAR.length))).toEqual([
      0x80, 0xff, 0x00,
    ]);
  });

  it("joins multiple capture rows with CRLF", () => {
    const { captured } = buildSeed(["a", "b", "c"], "", 0, 0);
    expect(text(captured)).toBe(CLEAR + "a\r\nb\r\nc");
  });
});

describe("buildSeed: trailing-artifact strip", () => {
  it("drops the single trailing empty row (capture-pane's trailing \\n)", () => {
    // No height reported (empty state) → no padding, so the strip is observable.
    const { captured } = buildSeed(["row-0", "row-1", ""], "", 0, 0);
    expect(text(captured)).toBe(CLEAR + "row-0\r\nrow-1");
    expect(text(captured).endsWith("\r\n")).toBe(false);
  });
});

describe("buildSeed: cursor parse", () => {
  it("parses 0-indexed cursor_x;cursor_y into {col,row}", () => {
    const { cursor } = buildSeed([], "3;5;0;0;0;0;0;0;;", 0, 0);
    expect(cursor).toEqual({ col: 3, row: 5 });
  });

  it("returns null when cursor_y is missing (Number('') would forge row 0)", () => {
    const { cursor } = buildSeed([], "5;", 0, 0);
    expect(cursor).toBeNull();
  });

  it("returns null for a wholly empty state line", () => {
    const { cursor } = buildSeed([], "", 0, 0);
    expect(cursor).toBeNull();
  });
});

describe("buildSeed: row-exact normalization", () => {
  it("pads trailing blank rows up to history+height so the grid is exact", () => {
    // pane_height=8, history_size=0, all modes 0. Two content rows → 6 padded
    // blanks → exactly 8 rows, so a bottom-anchored viewport aligns the cursor.
    const state = "0;0;0;0;0;0;0;0;8;0";
    const { captured } = buildSeed(["AA", "BB"], state, 2000, 2000);
    const rows = text(captured).split("\r\n");
    expect(rows).toHaveLength(8);
    // Middle rows carry no escapes — only row 0 (preamble) and the last row
    // (epilogue) do. So the interior is byte-clean.
    expect(rows[1]).toBe("BB");
    expect(rows[2]).toBe("");
  });

  it("caps padded history rows at min(historyLines, history_size)", () => {
    // history_size=100 but the caller only asked for 3 scrollback lines, so
    // targetRows = min(3,100) + height(2) = 5.
    const state = "0;0;0;0;0;0;0;0;2;100";
    const { captured } = buildSeed(["X"], state, 3, 3);
    expect(text(captured).split("\r\n")).toHaveLength(5);
  });

  it("degrades to strip-only when pane_height is absent (no padding)", () => {
    // A fake/older tmux that doesn't report pane_height → height NaN → no pad.
    // Mode escapes carry no CRLF, so the row count isolates the padding.
    const { captured } = buildSeed(["only-row"], "0;0;0;0;0;0;0;0;;", 5, 5);
    expect(text(captured).split("\r\n")).toHaveLength(1);
  });
});

describe("buildSeed: terminal-mode escapes", () => {
  it("emits ?1049l + CUP home before content for a main-screen pane", () => {
    // alternate_on=0 → exit alt screen + home the cursor before drawing, so a
    // reseed of a pane still in alt screen restores the main buffer at row 0.
    const { captured } = buildSeed(["hi"], "0;0;0;0;0;0;0;0;;", 0, 0);
    expect(text(captured).startsWith(`${ESC}[?1049l${ESC}[H`)).toBe(true);
  });

  it("emits ?1049h + CUP home before content for an alt-screen pane", () => {
    const { captured } = buildSeed(["hi"], "0;0;1;0;0;0;0;0;;", 0, 0);
    expect(text(captured).startsWith(`${ESC}[?1049h${ESC}[H`)).toBe(true);
  });

  it("appends input/cursor mode escapes after the content (epilogue)", () => {
    // cursor_flag=1, insert=0, app-cursor=1, keypad=1 → ?25h, 4l, ?1h, ESC=.
    const { captured } = buildSeed(["x"], "0;0;0;1;0;1;1;0;;", 0, 0);
    expect(text(captured)).toBe(
      `${ESC}[?1049l${CLEAR}${ESC}[?7l` + // preamble: main screen, clear, wrap off
        "x" +
        `${ESC}[?25h${ESC}[4l${ESC}[?1h${ESC}=`, // epilogue
    );
  });

  it("treats an empty mode field as a no-op (never forces the mode off)", () => {
    // An older tmux emits "" for an unexpanded format; "" must NOT be read as
    // "0" and actively reset the mode. Empty wrap/cursor fields → no escape.
    const { captured } = buildSeed(["x"], ";;;;;;;;;", 0, 0);
    // No modes → only the clear every seed starts with, then the content.
    expect(text(captured)).toBe(CLEAR + "x");
  });
});

describe("buildSeed: the history a seed carries", () => {
  // Cursor 0;1, main screen, no other modes reported, pane_height 3,
  // history_size 5. tmux elided the blank bottom row, so the capture holds 5
  // history rows and 2 screen rows.
  const STATE = "0;1;0;;;;;;3;5";
  const CAPTURE = ["h0", "h1", "h2", "h3", "h4", "s0", "s1", ""];
  const rows = (bytes: Uint8Array): string[] =>
    text(bytes)
      .slice(text(bytes).indexOf(CLEAR) + CLEAR.length)
      .split("\r\n");

  it("carries every captured history row, then the screen", () => {
    const { captured } = buildSeed(CAPTURE, STATE, 100, 100);
    expect(rows(captured)).toEqual([
      ...["h0", "h1", "h2", "h3", "h4"],
      ...["s0", "s1", ""],
    ]);
  });

  it("without history, carries the screen rows only, though the capture's bottom row was elided", () => {
    const { captured } = buildSeed(CAPTURE, STATE, 100, 0);
    expect(rows(captured)).toEqual(["s0", "s1", ""]);
  });
});

describe("buildSeed: seeds written to a terminal", () => {
  // @xterm/headless runs the browser terminal's own input handler, so this is
  // what an XtermSink shows.
  const DEPTH = 100;
  const HISTORY = ["h0", "h1", "h2", "h3", "h4"];
  const SCREEN = ["s0", "s1", "s2"];
  // Cursor 0;2, main screen, pane_height 3, history_size 5.
  const STATE = `0;2;0;1;0;0;0;1;${SCREEN.length};${HISTORY.length}`;
  const CAPTURE = [...HISTORY, ...SCREEN, ""];

  // Headless xterm's buffer API is proposed.
  const terminal = (): Terminal =>
    new Terminal({
      cols: 10,
      rows: SCREEN.length,
      scrollback: DEPTH,
      allowProposedApi: true,
    });

  const write = (term: Terminal, data: Uint8Array | string): Promise<void> =>
    new Promise((resolve) => term.write(data, resolve));

  const lines = (term: Terminal): string[] => {
    const buf = term.buffer.normal;
    return Array.from({ length: buf.length }, (_, i) =>
      (buf.getLine(i)?.translateToString(true) ?? "").trimEnd(),
    );
  };

  it("holds the history once after a seed with it and three without", async () => {
    // The first seed a sink is handed carries the history; each recapture
    // after it redraws the screen only (PaneStream).
    const term = terminal();
    await write(term, buildSeed(CAPTURE, STATE, DEPTH, DEPTH).captured);
    for (let i = 0; i < 3; i++) {
      await write(term, buildSeed(CAPTURE, STATE, DEPTH, 0).captured);
    }
    expect(lines(term)).toEqual([...HISTORY, ...SCREEN]);
    term.dispose();
  });

  it("leaves no tail of the rows a seed draws over", async () => {
    // capture-pane drops trailing blanks, so "x" over "abcdefgh" must not
    // leave "xbcdefgh", and a padded blank row must not keep its old text.
    const term = terminal();
    await write(term, `${ESC}[?1049habcdefgh\r\nabcdefgh\r\nabcdefgh`);
    const alt = buildSeed(["x", ""], "0;0;1;1;0;0;0;1;3;0", DEPTH, 0);
    await write(term, alt.captured);
    const buf = term.buffer.active;
    expect(
      [0, 1, 2].map((i) => buf.getLine(i)?.translateToString(true)),
    ).toEqual(["x", "", ""]);
    term.dispose();
  });

  it("erases with the default background, whatever colour the stream saved", async () => {
    // ED 2 erases with the current background, and the seed's ?1049l restores
    // the attributes a DECSC saved, so a colour saved by the live stream would
    // fill every blank cell of the seed.
    const term = terminal();
    await write(term, `${ESC}[41m${ESC}7${ESC}[0m`);
    await write(term, buildSeed(CAPTURE, STATE, DEPTH, DEPTH).captured);
    const cell = term.buffer.active.getLine(HISTORY.length + 2)?.getCell(5);
    expect(cell?.isBgDefault()).toBe(true);
    term.dispose();
  });
});
