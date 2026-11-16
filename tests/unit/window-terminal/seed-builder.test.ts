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
// Seed bytes are raw (same kind as live write()); decode Latin-1 losslessly to
// inspect them as text — mirrors how a TerminalSink treats the payload.
const text = (bytes: Uint8Array): string =>
  new TextDecoder("latin1").decode(bytes);
// The clear every seed starts with: DECSTBM reset, CUP home, SGR 0, ED 2, ED 3.
const CLEAR = `${ESC}[r${ESC}[H${ESC}[0m${ESC}[2J${ESC}[3J`;
// The seed with its clear taken off, so a test can assert the content alone.
const body = (bytes: Uint8Array): string => {
  const t = text(bytes);
  expect(t.startsWith(CLEAR)).toBe(true);
  return t.slice(CLEAR.length);
};

describe("buildSeed: byte fidelity", () => {
  it("round-trips raw 8-bit bytes without UTF-8 substitution", () => {
    // An empty state line yields no cursor, no modes, no padding — so the
    // captured bytes are the clear and then exactly the screen content.
    const { captured } = buildSeed(["\x80\xff\x00"], "", 2000);
    expect(Array.from(captured.subarray(CLEAR.length))).toEqual([
      0x80, 0xff, 0x00,
    ]);
  });

  it("joins multiple capture rows with CRLF", () => {
    const { captured } = buildSeed(["a", "b", "c"], "", 0);
    expect(body(captured)).toBe("a\r\nb\r\nc");
  });
});

describe("buildSeed: trailing-artifact strip", () => {
  it("drops the single trailing empty row (capture-pane's trailing \\n)", () => {
    // No height reported (empty state) → no padding, so the strip is observable.
    const { captured } = buildSeed(["row-0", "row-1", ""], "", 0);
    expect(body(captured)).toBe("row-0\r\nrow-1");
  });
});

describe("buildSeed: cursor parse", () => {
  it("parses 0-indexed cursor_x;cursor_y into {col,row}", () => {
    const { cursor } = buildSeed([], "3;5;0;0;0;0;0;0;;", 0);
    expect(cursor).toEqual({ col: 3, row: 5 });
  });

  it("returns null when cursor_y is missing (Number('') would forge row 0)", () => {
    const { cursor } = buildSeed([], "5;", 0);
    expect(cursor).toBeNull();
  });

  it("returns null for a wholly empty state line", () => {
    const { cursor } = buildSeed([], "", 0);
    expect(cursor).toBeNull();
  });
});

describe("buildSeed: row-exact normalization", () => {
  it("pads trailing blank rows up to history+height so the grid is exact", () => {
    // pane_height=8, history_size=0, all modes 0. Two content rows → 6 padded
    // blanks → exactly 8 rows, so a bottom-anchored viewport aligns the cursor.
    const state = "0;0;0;0;0;0;0;0;8;0";
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
    const state = "0;0;0;0;0;0;0;0;2;100";
    const { captured } = buildSeed(["X"], state, 3);
    expect(text(captured).split("\r\n")).toHaveLength(5);
  });

  it("degrades to strip-only when pane_height is absent (no padding)", () => {
    // A fake/older tmux that doesn't report pane_height → height NaN → no pad.
    // Mode escapes carry no CRLF, so the row count isolates the padding.
    const { captured } = buildSeed(["only-row"], "0;0;0;0;0;0;0;0;;", 5);
    expect(text(captured).split("\r\n")).toHaveLength(1);
  });
});

describe("buildSeed: terminal-mode escapes", () => {
  it("emits ?1049l then the clear before content for a main-screen pane", () => {
    // alternate_on=0 → exit alt screen, then clear the main buffer it returns
    // to, so a reseed of a pane still in alt screen redraws main from row 0.
    const { captured } = buildSeed(["hi"], "0;0;0;0;0;0;0;0;;", 0);
    expect(text(captured).startsWith(`${ESC}[?1049l${CLEAR}`)).toBe(true);
  });

  it("emits ?1049h then the clear before content for an alt-screen pane", () => {
    const { captured } = buildSeed(["hi"], "0;0;1;0;0;0;0;0;;", 0);
    expect(text(captured).startsWith(`${ESC}[?1049h${CLEAR}`)).toBe(true);
  });

  it("appends input/cursor mode escapes after the content (epilogue)", () => {
    // cursor_flag=1, insert=0, app-cursor=1, keypad=1 → ?25h, 4l, ?1h, ESC=.
    const { captured } = buildSeed(["x"], "0;0;0;1;0;1;1;0;;", 0);
    expect(text(captured)).toBe(
      `${ESC}[?1049l${CLEAR}${ESC}[?7l` + // preamble: main screen + clear + wrap off
        "x" +
        `${ESC}[?25h${ESC}[4l${ESC}[?1h${ESC}=`, // epilogue
    );
  });

  it("restores tmux's scroll region after the content, 1-indexed", () => {
    // scroll_region_upper=1, scroll_region_lower=2 (0-indexed).
    const { captured } = buildSeed(["x"], ";;;;;;;;;;1;2", 0);
    expect(body(captured)).toBe(`x${ESC}[2;3r`);
  });

  it("restores no scroll region from a field that is not an integer", () => {
    const { captured } = buildSeed(["x"], ";;;;;;;;;;1;x", 0);
    expect(body(captured)).toBe("x");
  });

  it("treats an empty mode field as a no-op (never forces the mode off)", () => {
    // An older tmux emits "" for an unexpanded format; "" must NOT be read as
    // "0" and actively reset the mode. Empty wrap/cursor fields → no escape.
    const { captured } = buildSeed(["x"], ";;;;;;;;;", 0);
    // No cursor, no modes → captured is the clear and then the content.
    expect(body(captured)).toBe("x");
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
  // pane_height=3, history_size=5, main screen, autowrap on.
  const state = "0;2;0;1;0;0;0;1;3;5";
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
    // As `state`, plus scroll_region_upper=1, scroll_region_lower=2.
    const seed = buildSeed(
      [...history, "s0", "s1", "s2", ""],
      `${state};1;2`,
      2000,
    );
    // The seed, then the CUP a sink writes from its cursor (row 2, col 0).
    await draw(term, seed.captured);
    await draw(term, `${ESC}[3;1H`);
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
