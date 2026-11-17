// tests/unit/window-terminal/seed-builder.test.ts
//
// Isolation tests for the pure tmux capture-grid reconstruction extracted
// from PaneStream.seed() (GM6 / tmux-complexity-lkg.8): `parseSeedState`
// reads the state reply, `buildSeed` turns a capture and that state into seed
// bytes. No client, async, or state dependency.
//
// [LAW:behavior-not-structure] Assertions target the returned values
//   (decoded bytes, cursor, size, accept/reject), never internals. The
//   PaneStream tests (pane-stream.test.ts) drive the same algorithm through
//   attach().

import { describe, it, expect } from "vitest";
import { Terminal } from "@xterm/headless";
import {
  buildSeed,
  parseSeedState,
  type SeedState,
} from "../../../src/window-terminal/engine/seed-builder.js";
import { seedStateLine } from "../../helpers/seed-state.js";

const ESC = "\x1b";
// Seed bytes are raw (same kind as live write()); decode Latin-1 losslessly to
// inspect them as text — mirrors how a TerminalSink treats the payload.
const text = (bytes: Uint8Array): string =>
  new TextDecoder("latin1").decode(bytes);
// The clear every seed starts with: DECSTBM reset, CUP home, SGR 0, ED 2, ED 3.
const CLEAR = `${ESC}[r${ESC}[H${ESC}[0m${ESC}[2J${ESC}[3J`;

const parsed = (line: string): SeedState => {
  const state = parseSeedState(line);
  if (state === null) throw new Error(`state line rejected: ${line}`);
  return state;
};
// A one-row main-screen pane: no padding below one row of content.
const ONE_ROW = parsed(seedStateLine({ cols: 20, rows: 1 }));
// What ONE_ROW wraps the screen in: main screen, the clear, autowrap on; then
// the whole-screen scroll region, cursor visible, insert/app-cursor/keypad
// off, the cursor at the origin.
const PREAMBLE = `${ESC}[?1049l${CLEAR}${ESC}[?7h`;
const EPILOGUE = `${ESC}[1;1r${ESC}[?25h${ESC}[4l${ESC}[?1l${ESC}>${ESC}[1;1H`;
// The seed with ONE_ROW's escapes taken off, so a test can assert the content.
const body = (bytes: Uint8Array): string => {
  const t = text(bytes);
  expect(t.startsWith(PREAMBLE)).toBe(true);
  expect(t.endsWith(EPILOGUE)).toBe(true);
  return t.slice(PREAMBLE.length, t.length - EPILOGUE.length);
};

describe("parseSeedState", () => {
  it("reads every field of the state reply", () => {
    expect(parseSeedState("3;5;1;0;1;1;0;1;24;100;2;20;80")).toEqual({
      cursor: { col: 3, row: 5 },
      size: { cols: 80, rows: 24 },
      historySize: 100,
      alternateScreen: true,
      cursorVisible: false,
      insertMode: true,
      applicationCursorKeys: true,
      applicationKeypad: false,
      autowrap: true,
      scrollRegion: { top: 2, bottom: 20 },
    });
  });

  // [LAW:parse-dont-validate] Every malformed shape is a malformed reply, not
  // a picture with that field missing.
  it.each([
    ["an empty reply", ""],
    ["cursor only", "0;0"],
    ["a field short", "0;0;0;1;0;0;0;1;24;0;0;23"],
    ["a field over", "0;0;0;1;0;0;0;1;24;0;0;23;80;1"],
    ["an empty cursor_y", "5;;0;1;0;0;0;1;24;0;0;23;80"],
    ["a negative cursor", "-1;0;0;1;0;0;0;1;24;0;0;23;80"],
    ["an empty flag", "0;0;;1;0;0;0;1;24;0;0;23;80"],
    ["a flag that is not 0/1", "0;0;2;1;0;0;0;1;24;0;0;23;80"],
    ["an empty width", "0;0;0;1;0;0;0;1;24;0;0;23;"],
    ["an empty height", "0;0;0;1;0;0;0;1;;0;0;23;80"],
    ["a zero width", "0;0;0;1;0;0;0;1;24;0;0;23;0"],
    ["a zero height", "0;0;0;1;0;0;0;1;0;0;0;23;80"],
    ["an exponent", "0;0;0;1;0;0;0;1;24;0;0;23;8e1"],
    ["a decimal point", "0;0;0;1;0;0;0;1;24.0;0;0;23;80"],
    ["a leading space", "0;0;0;1;0;0;0;1; 24;0;0;23;80"],
    ["an empty history_size", "0;0;0;1;0;0;0;1;24;;0;23;80"],
    ["a region row that is not digits", "0;0;0;1;0;0;0;1;24;0;0;x;80"],
    ["a trailing newline", "0;0;0;1;0;0;0;1;24;0;0;23;80\n"],
  ])("rejects %s", (_, line) => {
    expect(parseSeedState(line)).toBeNull();
  });
});

describe("buildSeed: byte fidelity", () => {
  it("round-trips raw 8-bit bytes without UTF-8 substitution", () => {
    const { captured } = buildSeed(["\x80\xff\x00"], ONE_ROW, 2000);
    expect(
      Array.from(
        captured.subarray(PREAMBLE.length, captured.length - EPILOGUE.length),
      ),
    ).toEqual([0x80, 0xff, 0x00]);
  });

  it("joins multiple capture rows with CRLF", () => {
    const { captured } = buildSeed(["a", "b", "c"], ONE_ROW, 0);
    expect(body(captured)).toBe("a\r\nb\r\nc");
  });
});

describe("buildSeed: trailing-artifact strip", () => {
  it("drops the single trailing empty row (capture-pane's trailing \\n)", () => {
    const { captured } = buildSeed(["row-0", "row-1", ""], ONE_ROW, 0);
    expect(body(captured)).toBe("row-0\r\nrow-1");
  });
});

describe("buildSeed: cursor and size", () => {
  it("ends at the cursor, and is the pane size, the capture was taken at", () => {
    const state = parsed(
      seedStateLine({ cols: 80, rows: 24, cursor: { col: 3, row: 5 } }),
    );
    const { captured, size } = buildSeed([], state, 0);
    // CUP is 1-indexed.
    expect(text(captured).endsWith("\x1b[6;4H")).toBe(true);
    expect(size).toEqual({ cols: 80, rows: 24 });
  });
});

describe("buildSeed: row-exact normalization", () => {
  it("pads trailing blank rows up to history+height so the grid is exact", () => {
    // pane_height=8, history_size=0. Two content rows → 6 padded blanks →
    // exactly 8 rows, so a bottom-anchored viewport aligns the cursor.
    const state = parsed(seedStateLine({ rows: 8 }));
    const { captured } = buildSeed(["AA", "BB"], state, 2000);
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
    const state = parsed(seedStateLine({ rows: 2, historySize: 100 }));
    const { captured } = buildSeed(["X"], state, 3);
    expect(text(captured).split("\r\n")).toHaveLength(5);
  });
});

describe("buildSeed: terminal-mode escapes", () => {
  it("emits ?1049l then the clear before content for a main-screen pane", () => {
    // alternate_on=0 → exit alt screen, then clear the main buffer it returns
    // to, so a reseed of a pane still in alt screen redraws main from row 0.
    const { captured } = buildSeed(["hi"], ONE_ROW, 0);
    expect(text(captured).startsWith(`${ESC}[?1049l${CLEAR}`)).toBe(true);
  });

  it("emits ?1049h then the clear before content for an alt-screen pane", () => {
    const state = parsed(seedStateLine({ rows: 1, alternate: true }));
    const { captured } = buildSeed(["hi"], state, 0);
    expect(text(captured).startsWith(`${ESC}[?1049h${CLEAR}`)).toBe(true);
  });

  it("sets each mode the state names after the content (epilogue)", () => {
    // cursor_flag=0, insert=1, app-cursor=1, keypad=1, wrap=0, region rows
    // 0..0, cursor at the origin → ?7l before; 1;1r, ?25l, 4h, ?1h, ESC=,
    // then the CUP after.
    const state = parsed("0;0;0;0;1;1;1;0;1;0;0;0;20");
    expect(text(buildSeed(["x"], state, 0).captured)).toBe(
      `${ESC}[?1049l${CLEAR}${ESC}[?7l` +
        "x" +
        `${ESC}[1;1r${ESC}[?25l${ESC}[4h${ESC}[?1h${ESC}=${ESC}[1;1H`,
    );
  });

  it("restores tmux's scroll region after the content, 1-indexed", () => {
    // scroll_region_upper=1, scroll_region_lower=2 (0-indexed).
    const state = parsed("0;0;0;1;0;0;0;1;3;0;1;2;20");
    expect(text(buildSeed(["x"], state, 0).captured)).toContain(`${ESC}[2;3r`);
  });
});

// [LAW:behavior-not-structure] The seed's contract is what a terminal shows
// after drawing it, so these write it into a real xterm.js (headless) and read
// the buffer back.
describe("buildSeed: drawn into xterm.js", () => {
  const newTerm = (): Terminal =>
    new Terminal({
      cols: 20,
      rows: 3,
      scrollback: 100,
      allowProposedApi: true,
    });
  const draw = (term: Terminal, data: string | Uint8Array): Promise<void> =>
    new Promise((resolve) => term.write(data, resolve));
  const rowsOf = (term: Terminal): string[] => {
    const buf = term.buffer.active;
    return Array.from(
      { length: buf.length },
      (_, y) => buf.getLine(y)?.translateToString(true) ?? "",
    );
  };
  // A 20x3 main-screen pane with 5 history rows, cursor on its last row.
  const state = parsed(
    seedStateLine({
      cols: 20,
      rows: 3,
      cursor: { col: 0, row: 2 },
      historySize: 5,
    }),
  );
  const history = ["h0", "h1", "h2", "h3", "h4"];

  it("holds the pane's history once, however often it is reseeded", async () => {
    const term = newTerm();
    const seed = buildSeed([...history, "s0", "s1", "s2", ""], state, 2000);
    for (let i = 0; i < 3; i++) await draw(term, seed.captured);
    expect(rowsOf(term)).toEqual([...history, "s0", "s1", "s2"]);
  });

  it("leaves no tail of an old row under a shorter new one", async () => {
    const term = newTerm();
    await draw(term, buildSeed(["long-old-row", "", ""], state, 0).captured);
    await draw(term, buildSeed(["new", "", ""], state, 0).captured);
    expect(rowsOf(term)[0]).toBe("new");
  });

  it("holds the history once under a scroll region the live stream left set", async () => {
    const term = newTerm();
    // A program set a region below the top row; rows written inside it would
    // never scroll into the scrollback.
    await draw(term, `${ESC}[2;3r`);
    const seed = buildSeed([...history, "s0", "s1", "s2", ""], state, 2000);
    for (let i = 0; i < 2; i++) await draw(term, seed.captured);
    expect(rowsOf(term)).toEqual([...history, "s0", "s1", "s2"]);
  });

  it("leaves tmux's scroll region in force, with the cursor where tmux has it", async () => {
    const term = newTerm();
    const seed = buildSeed(
      [...history, "s0", "s1", "s2", ""],
      { ...state, scrollRegion: { top: 1, bottom: 2 } },
      2000,
    );
    await draw(term, seed.captured);
    expect(term.buffer.active.cursorY).toBe(2);
    // A line feed on the region's bottom row scrolls the region alone.
    await draw(term, "\r\nnew");
    expect(rowsOf(term)).toEqual([...history, "s0", "s2", "new"]);
  });

  it("clears with the default background, not attributes DECRC restores", async () => {
    const term = newTerm();
    // A red background is current when the program enters the alt screen, so
    // ?1049h saves it and the seed's ?1049l restores it.
    await draw(term, `${ESC}[41m${ESC}[?1049h`);
    await draw(term, buildSeed(["x", "", ""], state, 0).captured);
    const cell = term.buffer.active.getLine(2)?.getCell(5);
    expect(cell?.isBgDefault()).toBe(true);
  });
});
