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

describe("buildSeed: byte fidelity", () => {
  it("round-trips raw 8-bit bytes without UTF-8 substitution", () => {
    // An empty state line yields no cursor, no modes, no padding — so the
    // captured bytes are exactly the screen content.
    const { captured } = buildSeed(["\x80\xff\x00"], "", 2000);
    expect(Array.from(captured)).toEqual([0x80, 0xff, 0x00]);
  });

  it("joins multiple capture rows with CRLF", () => {
    const { captured } = buildSeed(["a", "b", "c"], "", 0);
    expect(text(captured)).toBe("a\r\nb\r\nc");
  });
});

describe("buildSeed: trailing-artifact strip", () => {
  it("drops the single trailing empty row (capture-pane's trailing \\n)", () => {
    // No height reported (empty state) → no padding, so the strip is observable.
    const { captured } = buildSeed(["row-0", "row-1", ""], "", 0);
    expect(text(captured)).toBe("row-0\r\nrow-1");
    expect(text(captured).endsWith("\r\n")).toBe(false);
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
  it("emits ?1049l + CUP home before content for a main-screen pane", () => {
    // alternate_on=0 → exit alt screen + home the cursor before drawing, so a
    // reseed of a pane still in alt screen restores the main buffer at row 0.
    const { captured } = buildSeed(["hi"], "0;0;0;0;0;0;0;0;;", 0);
    expect(text(captured).startsWith(`${ESC}[?1049l${ESC}[H`)).toBe(true);
  });

  it("emits ?1049h + CUP home before content for an alt-screen pane", () => {
    const { captured } = buildSeed(["hi"], "0;0;1;0;0;0;0;0;;", 0);
    expect(text(captured).startsWith(`${ESC}[?1049h${ESC}[H`)).toBe(true);
  });

  it("appends input/cursor mode escapes after the content (epilogue)", () => {
    // cursor_flag=1, insert=0, app-cursor=1, keypad=1 → ?25h, 4l, ?1h, ESC=.
    const { captured } = buildSeed(["x"], "0;0;0;1;0;1;1;0;;", 0);
    expect(text(captured)).toBe(
      `${ESC}[?1049l${ESC}[H${ESC}[2J${ESC}[3J${ESC}[?7l` + // preamble: main screen, home, erased + wrap off
        "x" +
        `${ESC}[?25h${ESC}[4l${ESC}[?1h${ESC}=`, // epilogue
    );
  });

  it("a main-screen pane's preamble erases the screen and its scrollback before drawing", () => {
    const { captured } = buildSeed(["hi"], "0;0;0;0;0;0;0;0;;", 0);
    expect(
      text(captured).startsWith(`${ESC}[?1049l${ESC}[H${ESC}[2J${ESC}[3J`),
    ).toBe(true);
  });

  it("treats an empty mode field as a no-op (never forces the mode off)", () => {
    // An older tmux emits "" for an unexpanded format; "" must NOT be read as
    // "0" and actively reset the mode. Empty wrap/cursor fields → no escape.
    const { captured } = buildSeed(["x"], ";;;;;;;;;", 0);
    // No cursor, no modes → captured is exactly the content.
    expect(text(captured)).toBe("x");
  });
});

describe("buildSeed: a seed applied again leaves the pane's history once", () => {
  // Every recapture (resize, %continue, reconnect) hands the sink a fresh seed
  // carrying the pane's history, written over whatever the terminal shows. Each
  // seed must leave tmux's picture there once, not stack its history on the
  // scrollback an earlier seed left. @xterm/headless runs the browser
  // terminal's own input handler, so this is what an XtermSink shows.
  // The pane holds less history than the capture asks for, as most do: a
  // history deeper than the scrollback would push every earlier copy out.
  const DEPTH = 100;
  const HISTORY = ["h0", "h1", "h2", "h3", "h4"];
  const SCREEN = ["s0", "s1", "s2"];
  // Cursor 0;2, main screen, pane_height 3, history_size 5.
  const STATE = `0;2;0;1;0;0;0;1;${SCREEN.length};${HISTORY.length}`;
  const seed = buildSeed([...HISTORY, ...SCREEN, ""], STATE, DEPTH);

  // A terminal whose scrollback is the capture depth, as WindowRenderer builds
  // each pane's (one `history` number for both). Headless xterm's buffer API
  // is proposed.
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

  it("holds the history then the screen exactly once after three seeds", async () => {
    const term = terminal();
    for (let i = 0; i < 3; i++) await write(term, seed.captured);
    expect(lines(term)).toEqual([...HISTORY, ...SCREEN]);
    term.dispose();
  });

  it("replaces what the terminal showed before it, scrollback included", async () => {
    // Every byte the sink got before a seed is inside it (TerminalSink.seed),
    // so the seed's history is the truth and nothing printed earlier survives.
    const term = terminal();
    await write(term, "old0\r\nold1\r\nold2\r\nold3\r\nold4");
    await write(term, seed.captured);
    expect(lines(term)).toEqual([...HISTORY, ...SCREEN]);
    term.dispose();
  });
});
