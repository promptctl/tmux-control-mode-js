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
import { drawnSeed, seedStateLine } from "../../helpers/seed-state.js";

const ESC = "\x1b";
// Seed bytes are raw (same kind as live write()); decode Latin-1 losslessly to
// inspect them as text — mirrors how a TerminalSink treats the payload.
const text = (bytes: Uint8Array): string =>
  new TextDecoder("latin1").decode(bytes);
// The clear every seed starts with: DECSTBM reset, CUP home, SGR 0, ED 2, ED 3,
// then G0 ASCII, G1 DEC Special Graphics, SI.
const CLEAR = `${ESC}[r${ESC}[H${ESC}[0m${ESC}[2J${ESC}[3J${ESC}(B${ESC})0\x0f`;

const parsed = (line: string): SeedState => {
  const state = parseSeedState(line);
  if (state === null) throw new Error(`state line rejected: ${line}`);
  return state;
};
// A one-row main-screen pane: no padding below one row of content.
const ONE_ROW = parsed(seedStateLine({ cols: 20, rows: 1 }));
// What ONE_ROW wraps one captured row in: main screen, the clear, autowrap
// on, the cursor's row saved with nothing to scroll in; then the whole-screen
// scroll region, origin mode off, the cursor at the origin, cursor visible,
// insert/app-cursor/keypad off, SI and SGR 0.
const PREAMBLE = `${ESC}[?1049l${CLEAR}${ESC}[?7h${ESC}[s${ESC}[49m${ESC}[u${ESC}[1;1H`;
const EPILOGUE = `${ESC}[1;1r${ESC}[?6l${ESC}[1;1H${ESC}[?25h${ESC}[4l${ESC}[?1l${ESC}>\x0f${ESC}[0m`;

describe("parseSeedState", () => {
  it("reads every field of the state reply", () => {
    expect(parseSeedState("3;5;1;0;1;1;0;1;1;24;100;2;20;80")).toEqual({
      cursor: { col: 3, row: 5 },
      size: { cols: 80, rows: 24 },
      historySize: 100,
      alternateScreen: true,
      cursorVisible: false,
      insertMode: true,
      applicationCursorKeys: true,
      applicationKeypad: false,
      autowrap: true,
      originMode: true,
      scrollRegion: { top: 2, bottom: 20 },
    });
  });

  // [LAW:parse-dont-validate] Every malformed shape is a malformed reply, not
  // a picture with that field missing.
  it.each([
    ["an empty reply", ""],
    ["cursor only", "0;0"],
    ["a field short", "0;0;0;1;0;0;0;1;0;24;0;0;23"],
    ["a field over", "0;0;0;1;0;0;0;1;0;24;0;0;23;80;1"],
    ["an empty cursor_y", "5;;0;1;0;0;0;1;0;24;0;0;23;80"],
    ["a negative cursor", "-1;0;0;1;0;0;0;1;0;24;0;0;23;80"],
    ["an empty flag", "0;0;;1;0;0;0;1;0;24;0;0;23;80"],
    ["a flag that is not 0/1", "0;0;2;1;0;0;0;1;0;24;0;0;23;80"],
    ["an empty width", "0;0;0;1;0;0;0;1;0;24;0;0;23;"],
    ["an empty height", "0;0;0;1;0;0;0;1;0;;0;0;23;80"],
    ["a zero width", "0;0;0;1;0;0;0;1;0;24;0;0;23;0"],
    ["a zero height", "0;0;0;1;0;0;0;1;0;0;0;0;23;80"],
    ["an exponent", "0;0;0;1;0;0;0;1;0;24;0;0;23;8e1"],
    ["a decimal point", "0;0;0;1;0;0;0;1;0;24.0;0;0;23;80"],
    ["a leading space", "0;0;0;1;0;0;0;1;0; 24;0;0;23;80"],
    ["an empty history_size", "0;0;0;1;0;0;0;1;0;24;;0;23;80"],
    ["a region row that is not digits", "0;0;0;1;0;0;0;1;0;24;0;0;x;80"],
    ["a region whose top is below its bottom", "0;0;0;1;0;0;0;1;0;24;0;5;3;80"],
    ["a region past the pane's last row", "0;0;0;1;0;0;0;1;0;24;0;0;24;80"],
    ["a one-row region on a taller pane", "0;0;0;1;0;0;0;1;0;24;0;5;5;80"],
    ["a cursor below the pane's last row", "0;24;0;1;0;0;0;1;0;24;0;0;23;80"],
    [
      "a cursor past the pending-wrap column",
      "81;0;0;1;0;0;0;1;0;24;0;0;23;80",
    ],
    ["a trailing newline", "0;0;0;1;0;0;0;1;0;24;0;0;23;80\n"],
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
});

describe("buildSeed: trailing-artifact strip", () => {
  it("drops the single trailing empty row (capture-pane's trailing \\n)", async () => {
    const state = parsed(seedStateLine({ cols: 20, rows: 2 }));
    const { captured } = buildSeed(["row-0", "row-1", ""], state, 0);
    expect((await drawnSeed(captured, state.size)).rows).toEqual([
      "row-0",
      "row-1",
    ]);
  });
});

describe("buildSeed: cursor and size", () => {
  it("ends at the cursor, and is the pane size, the capture was taken at", async () => {
    const state = parsed(
      seedStateLine({ cols: 80, rows: 24, cursor: { col: 3, row: 5 } }),
    );
    const { captured, size } = buildSeed([], state, 0);
    expect((await drawnSeed(captured, size)).cursor).toEqual({
      col: 3,
      row: 5,
    });
    expect(size).toEqual({ cols: 80, rows: 24 });
  });
});

describe("buildSeed: row-exact normalization", () => {
  it("pads trailing blank rows up to history+height so the grid is exact", async () => {
    // pane_height=8, history_size=0. Two content rows → 6 padded blanks →
    // exactly 8 rows, so a bottom-anchored viewport aligns the cursor.
    const state = parsed(
      seedStateLine({ rows: 8, cursor: { col: 0, row: 7 } }),
    );
    const { captured } = buildSeed(["AA", "BB"], state, 2000);
    expect(await drawnSeed(captured, state.size)).toEqual({
      rows: ["AA", "BB", "", "", "", "", "", ""],
      cursor: { col: 0, row: 7 },
    });
  });

  it("caps padded history rows at min(historyLines, history_size)", async () => {
    // history_size=100 but the caller only asked for 3 scrollback lines, so
    // targetRows = min(3,100) + height(2) = 5.
    const state = parsed(seedStateLine({ rows: 2, historySize: 100 }));
    const { captured } = buildSeed(["X"], state, 3);
    expect((await drawnSeed(captured, state.size)).rows).toEqual([
      "X",
      "",
      "",
      "",
      "",
    ]);
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
    // cursor_flag=0, insert=1, app-cursor=1, keypad=1, wrap=0, origin=1,
    // region rows 0..0, cursor at the origin → ?7l before; 1;1r, ?6h, the
    // CUP, ?25l, 4h, ?1h, ESC=, SI, SGR 0 after.
    const state = parsed("0;0;0;0;1;1;1;0;1;1;0;0;0;20");
    expect(text(buildSeed(["x"], state, 0).captured)).toBe(
      `${ESC}[?1049l${CLEAR}${ESC}[?7l${ESC}[s${ESC}[49m${ESC}[u${ESC}[1;1H` +
        "x" +
        `${ESC}[1;1r${ESC}[?6h${ESC}[1;1H${ESC}[?25l${ESC}[4h${ESC}[?1h${ESC}=\x0f${ESC}[0m`,
    );
  });

  it("restores tmux's scroll region after the content, 1-indexed", () => {
    // scroll_region_upper=1, scroll_region_lower=2 (0-indexed).
    const state = parsed("0;0;0;1;0;0;0;1;0;3;0;1;2;20");
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

  it("restores origin mode, so the program's later CUP lands where tmux puts it", async () => {
    const term = newTerm();
    const seed = buildSeed(
      [...history, "s0", "s1", "s2", ""],
      {
        ...state,
        cursor: { col: 0, row: 1 },
        originMode: true,
        scrollRegion: { top: 1, bottom: 2 },
      },
      2000,
    );
    await draw(term, seed.captured);
    expect(term.modes.originMode).toBe(true);
    expect(term.buffer.active.cursorY).toBe(1);
    // Under DECOM, row 1 is the region's top: screen row 1, as in tmux.
    await draw(term, `${ESC}[1;1Hz`);
    expect(rowsOf(term)).toEqual([...history, "s0", "z1", "s2"]);
  });

  it("puts a cursor tmux holds above the region under DECOM on the region's top", async () => {
    const term = newTerm();
    // tmux's DECSTBM homes to the screen's top-left even under DECOM; xterm.js
    // can hold no row outside the region then, so the nearest is its top.
    const seed = buildSeed(
      [...history, "s0", "s1", "s2", ""],
      {
        ...state,
        cursor: { col: 0, row: 0 },
        originMode: true,
        scrollRegion: { top: 1, bottom: 2 },
      },
      2000,
    );
    expect(text(seed.captured)).toContain(`${ESC}[?6h${ESC}[1;1H`);
    await draw(term, seed.captured);
    expect(term.buffer.active.cursorY).toBe(1);
  });

  it("scrolls each row in with the default background, keeping the pen across rows", async () => {
    const term = newTerm();
    // capture-pane carries the pen: h2 ends on red and the SGR that ends it
    // comes before h3's first cell, after the line feed scrolled h3's line
    // in. Every row below h2 is default past its cells, in history and on
    // screen alike, and so are the padding rows below the capture.
    const seed = buildSeed(
      ["h0", "h1", `h2${ESC}[41mr`, `${ESC}[49mh3`, "h4", "s0", ""],
      state,
      2000,
    );
    await draw(term, seed.captured);
    const buf = term.buffer.active;
    expect(rowsOf(term)).toEqual(["h0", "h1", "h2r", "h3", "h4", "s0", "", ""]);
    expect(buf.getLine(3)?.getCell(0)?.isBgDefault()).toBe(true);
    expect(buf.getLine(3)?.getCell(1)?.isBgDefault()).toBe(true);
    for (let y = 3; y < buf.length; y++)
      expect(buf.getLine(y)?.getCell(10)?.isBgDefault()).toBe(true);
  });

  it("draws each row on its own line while xterm trims a full scrollback", async () => {
    // Five history rows into a two-row scrollback: each feed past the third
    // row trims the oldest line instead of growing the buffer.
    const term = new Terminal({
      cols: 20,
      rows: 3,
      scrollback: 2,
      allowProposedApi: true,
    });
    const seed = buildSeed([...history, "s0", "s1", "s2", ""], state, 2000);
    await draw(term, seed.captured);
    expect(rowsOf(term)).toEqual(["h3", "h4", "s0", "s1", "s2"]);
    expect(term.buffer.active.cursorY).toBe(2);
  });

  it("carries the pen into a row whose first cell continues it", async () => {
    const term = newTerm();
    // h2's red continues into h3's first cell with no SGR between them.
    const seed = buildSeed([`h2${ESC}[41mr`, "x", ""], state, 0);
    await draw(term, seed.captured);
    expect(term.buffer.active.getLine(1)?.getCell(0)?.isBgDefault()).toBe(
      false,
    );
  });

  it("draws ASCII through a line-drawing charset a DECRC restores", async () => {
    const term = newTerm();
    // DECSC saves G0 = DEC Special Graphics; the seed's ?1049l restores it.
    await draw(term, `${ESC}(0${ESC}7${ESC}(B`);
    await draw(term, buildSeed(["qq", "", ""], state, 0).captured);
    expect(rowsOf(term)[0]).toBe("qq");
  });

  it("draws the capture's SO … SI cells as line drawing", async () => {
    const term = newTerm();
    await draw(term, buildSeed(["a\x0eqq\x0fb", "", ""], state, 0).captured);
    expect(rowsOf(term)[0]).toBe("a──b");
  });

  it("hands the live stream tmux's initial shift and pen, not the capture's last", async () => {
    const term = newTerm();
    // capture-pane leaves its last cell's SGR and SO in force.
    const seed = buildSeed([`${ESC}[41mx\x0eq`, "", ""], state, 0);
    await draw(term, seed.captured);
    await draw(term, "q");
    expect(rowsOf(term)[2]).toBe("q");
    expect(term.buffer.active.getLine(2)?.getCell(0)?.isBgDefault()).toBe(true);
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

  // tmux reports cursor_x == pane_width while a wrap is pending: the program
  // printed into the last column, and its next character starts the next row.
  describe("a wrap tmux has pending", () => {
    const pending = (overrides: Partial<SeedState> = {}): SeedState => ({
      ...parsed(
        seedStateLine({
          cols: 10,
          rows: 3,
          cursor: { col: 10, row: 1 },
          historySize: 2,
        }),
      ),
      ...overrides,
    });
    const wrapTerm = (scrollback = 100): Terminal =>
      new Terminal({ cols: 10, rows: 3, scrollback, allowProposedApi: true });
    // s1 fills the row under a red the capture carried in from s0; s2 ends it.
    const capture = [
      "h0",
      "h1",
      `s0${ESC}[41m`,
      "0123456789",
      `${ESC}[49ms2`,
      "",
    ];

    it("lands the program's next character at the start of the next row", async () => {
      const term = wrapTerm();
      await draw(term, buildSeed(capture, pending(), 2000).captured);
      await draw(term, "X");
      expect(rowsOf(term)).toEqual(["h0", "h1", "s0", "0123456789", "X2"]);
      const s1 = term.buffer.active.getLine(3);
      for (let x = 0; x < 10; x++)
        expect(s1?.getCell(x)?.isBgDefault()).toBe(false);
      expect(term.buffer.active.getLine(4)?.getCell(0)?.isBgDefault()).toBe(
        true,
      );
    });

    it("reprints a row a line-drawing shift carries into as line drawing", async () => {
      const term = wrapTerm();
      const seed = buildSeed(
        ["ab\x0eqq", "qqqqqqqqqq", "\x0fz", ""],
        pending({ historySize: 0 }),
        0,
      );
      await draw(term, seed.captured);
      await draw(term, "X");
      expect(rowsOf(term)).toEqual(["ab──", "──────────", "X"]);
    });

    it("keeps the row and the wrap with insert mode on", async () => {
      const term = wrapTerm();
      await draw(
        term,
        buildSeed(capture, pending({ insertMode: true }), 2000).captured,
      );
      await draw(term, "X");
      expect(rowsOf(term)).toEqual(["h0", "h1", "s0", "0123456789", "Xs2"]);
    });

    it("keeps the rows and the wrap while xterm trims a full scrollback", async () => {
      const term = wrapTerm(1);
      await draw(term, buildSeed(capture, pending(), 2000).captured);
      await draw(term, "X");
      expect(rowsOf(term)).toEqual(["h1", "s0", "0123456789", "X2"]);
    });

    it("keeps the wrap under origin mode, on the region's row", async () => {
      const term = wrapTerm();
      const seed = buildSeed(
        capture,
        pending({ originMode: true, scrollRegion: { top: 1, bottom: 2 } }),
        2000,
      );
      await draw(term, seed.captured);
      expect(term.modes.originMode).toBe(true);
      await draw(term, "X");
      expect(rowsOf(term)).toEqual(["h0", "h1", "s0", "0123456789", "X2"]);
    });
  });
});
