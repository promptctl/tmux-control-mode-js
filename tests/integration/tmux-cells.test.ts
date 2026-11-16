// tests/integration/tmux-cells.test.ts
//
// TMUX_CELLS against a real tmux: each text is printed in a tmux pane and
// written to an xterm.js terminal counting cells with TMUX_CELLS, and the
// cursor ends in the same cell in both. xterm.js is @xterm/headless, whose
// input handler is the browser terminal's own. The tmux must be one the
// table counts as: the release it was generated from or later, built with
// utf8proc, default options.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Terminal } from "@xterm/headless";
import { killTmuxServer } from "../helpers/reap-test-sockets.js";
import { readUntil, tmux, uniqueSocket } from "../helpers/integration.js";
import { TMUX_CELLS } from "../../src/window-terminal/render/tmux-cells.js";
import { TABLE_TMUX_VERSION } from "../../src/window-terminal/render/cell-width-table.js";
import {
  meetsTmuxVersion,
  parseTmuxVersionValue,
} from "../../src/tmux-compat.js";
import { runningTmuxVersion } from "../helpers/running-tmux.js";

const RUN_INTEGRATION = process.env.TMUX_INTEGRATION === "1";
// [LAW:verifiable-goals] An older tmux joins and counts differently; the
// table's own release is the floor, so a newer tmux that drifts fails.
const TABLE_VERSION = parseTmuxVersionValue(TABLE_TMUX_VERSION);
if (TABLE_VERSION === null) {
  throw new Error(
    `cell-width-table.ts: no tmux version in ${TABLE_TMUX_VERSION}`,
  );
}
const COUNTS_AS_TABLE =
  RUN_INTEGRATION && meetsTmuxVersion(runningTmuxVersion(), TABLE_VERSION);

const COLS = 400;
const cp = (...cps: number[]): string => String.fromCodePoint(...cps);
const ZWJ = cp(0x200d);
const FAMILY = "👨‍👩‍👧‍👦"; // 25 bytes

const SAMPLES: Readonly<Record<string, string>> = {
  ascii: "hello",
  "an emoji (U+1F36B)": "a🍫b",
  "VS16 after a text-presentation emoji": "⚠️ warn ❤️ ☀️",
  "VS16 after ASCII": "a" + cp(0xfe0f) + "b",
  "an emoji newer than Unicode 11 (U+1FAE0)": "🫠x",
  "a skin tone": "👍🏽 ok",
  "a flag (two regional indicators)": "🇺🇸 us",
  "a lone regional indicator": "🇺x",
  "three regional indicators": "🇺🇸🇬x",
  "a ZWJ family": FAMILY + " fam",
  "two ZWJ families joined": FAMILY + ZWJ + FAMILY + "x",
  "a cell of 31 bytes, then ZWJ and an emoji":
    FAMILY + ZWJ + cp(0x20d0) + ZWJ + "👩x",
  "a cell of 32 bytes, then ZWJ and an emoji":
    FAMILY + ZWJ + cp(0x301, 0x301) + ZWJ + "👩x",
  "a cell of 32 bytes, then an emoji": FAMILY + ZWJ + cp(0x301, 0x301) + "👩x",
  "a one-cell cell of 32 bytes, then VS16":
    cp(0xe9) + cp(0x301).repeat(15) + cp(0xfe0f) + "x",
  "a one-cell cell of 32 bytes, then ZWJ and an emoji":
    cp(0xe9) + cp(0x301).repeat(15) + ZWJ + "👩x",
  "a regional indicator pair after a ZWJ sequence": "👨" + ZWJ + "🇺🇸x",
  "a combining accent": "e" + cp(0x301) + "x",
  CJK: "漢字かな",
  "Hangul jamo": cp(0x1100, 0x1161, 0x11a8) + "x" + cp(0x1161) + "y",
  "private use (a powerline glyph)": cp(0xe0b0) + "x",
  "a Hangul filler": "a" + cp(0x3164) + "b",
};

// Every codepoint of the blocks where terminals' widths differ most, 128 to
// a line after an "x" (xterm cannot follow tmux with a zero-width codepoint
// in column 0; see TMUX_CELLS), alone and each followed by VS16.
const SWEEP: readonly (readonly [number, number])[] = [
  [0x00a0, 0x33ff],
  [0xa960, 0xa97f],
  [0xd7b0, 0xd7ff],
  [0xe000, 0xe0ff],
  [0xfe00, 0xffff],
  [0x1f000, 0x1fbff],
];

function sweepLines(): [string, string][] {
  const lines: [string, string][] = [];
  for (const [first, last] of SWEEP) {
    for (let c = first; c <= last; c += 128) {
      const cps = Array.from(
        { length: Math.min(c + 127, last) - c + 1 },
        (_, i) => c + i,
      );
      const name = `U+${c.toString(16)}..U+${cps.at(-1)!.toString(16)}`;
      lines.push([name, "x" + cp(...cps)]);
      lines.push([
        `${name}, each with VS16`,
        "x" + cps.map((p) => cp(p, 0xfe0f)).join(""),
      ]);
    }
  }
  return lines;
}

// The cell the cursor ends in, as "x,y".
async function xtermCursor(text: string): Promise<string> {
  const term = new Terminal({ cols: COLS, rows: 5, allowProposedApi: true });
  term.unicode.register(TMUX_CELLS);
  term.unicode.activeVersion = TMUX_CELLS.version;
  await new Promise<void>((resolve) => term.write(text, resolve));
  const { cursorX, cursorY } = term.buffer.active;
  term.dispose();
  return `${cursorX},${cursorY}`;
}

describe.skipIf(!COUNTS_AS_TABLE)("TMUX_CELLS against tmux", () => {
  const socket = uniqueSocket("tmux-cells");
  let dir = "";
  let files = 0;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "tmux-cells-"));
    tmux(socket, [
      "new-session",
      "-d",
      "-x",
      `${COLS}`,
      "-y",
      "5",
      "sleep 600",
    ]);
  });
  afterAll(() => {
    killTmuxServer(socket);
    rmSync(dir, { recursive: true, force: true });
  });

  // A pane prints the text and a marker; the cursor is read once the marker
  // shows.
  async function tmuxCursor(text: string): Promise<string> {
    const file = join(dir, `${files++}.txt`);
    writeFileSync(file, text);
    const pane = tmux(socket, [
      "new-window",
      "-d",
      "-P",
      "-F",
      "#{pane_id}",
      `cat '${file}'; sleep 600`,
    ]);
    await readUntil(
      () => tmux(socket, ["capture-pane", "-p", "-t", pane]),
      (screen) => screen.includes("|"),
      `tmux pane ${pane} to print ${JSON.stringify(text.slice(0, 20))}`,
    );
    const cursor = tmux(socket, [
      "display",
      "-p",
      "-t",
      pane,
      "#{cursor_x},#{cursor_y}",
    ]);
    tmux(socket, ["kill-pane", "-t", pane]);
    return cursor;
  }

  for (const [name, text] of Object.entries(SAMPLES)) {
    it(`puts the cursor where tmux does after ${name}`, async () => {
      expect(await xtermCursor(text + "|")).toBe(await tmuxCursor(text + "|"));
    });
  }

  it("puts the cursor where tmux does after every codepoint of the swept blocks", async () => {
    const wrong: string[] = [];
    for (const [name, text] of sweepLines()) {
      const [want, got] = [
        await tmuxCursor(text + "|"),
        await xtermCursor(text + "|"),
      ];
      if (got !== want) wrong.push(`${name}: tmux ${want}, xterm ${got}`);
    }
    expect(wrong).toEqual([]);
  }, 120_000);
});
