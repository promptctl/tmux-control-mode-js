// examples/web-multiplexer/web/byte-attribution-engine.test.ts
//
// The attribution emulator is the demo's load-bearing claim: "this cell was
// written by THAT byte." These tests pin both halves — the rendered grid (does
// the cursor/erase/scroll model match a real terminal?) and the provenance (does
// each cell trace to the exact chunk + offset that produced it?), including the
// hard case the live firehose forces: a sequence or grapheme split across chunks.

import { describe, it, expect } from "vitest";
import {
  AttributionEngine,
  emulate,
  type AttributionGrid,
  type SourceChunk,
} from "./byte-attribution-engine.ts";

const enc = new TextEncoder();

let nextId = 1;
/** A chunk whose bytes are the UTF-8 of `s`, at time `tMs`, after `baseOffset`. */
function chunk(s: string, tMs = 0, baseOffset = 0): SourceChunk {
  return { chunkId: nextId++, tMs, baseOffset, bytes: enc.encode(s) };
}

/** Read the grapheme at (row, col), or "" for a blank cell. */
function charAt(g: AttributionGrid, row: number, col: number): string {
  return g.cells[row * g.cols + col]?.char ?? "";
}

/** Concatenate a row's rendered glyphs, trailing blanks trimmed. */
function rowText(g: AttributionGrid, row: number): string {
  let out = "";
  for (let c = 0; c < g.cols; c++) out += charAt(g, row, c);
  return out.replace(/\s+$/u, "");
}

function cell(g: AttributionGrid, row: number, col: number) {
  return g.cells[row * g.cols + col];
}

describe("AttributionEngine — rendering", () => {
  it("writes plain text left-to-right from the origin", () => {
    const g = emulate([chunk("hello")], { cols: 20, rows: 3 });
    expect(rowText(g, 0)).toBe("hello");
    expect(g.cursorRow).toBe(0);
    expect(g.cursorCol).toBe(5);
  });

  it("CR returns to column 0; later text overwrites", () => {
    const g = emulate([chunk("hello\rHE")], { cols: 20, rows: 3 });
    expect(rowText(g, 0)).toBe("HEllo");
  });

  it("LF moves down a row, CR+LF starts a fresh line", () => {
    const g = emulate([chunk("ab\r\ncd")], { cols: 20, rows: 3 });
    expect(rowText(g, 0)).toBe("ab");
    expect(rowText(g, 1)).toBe("cd");
  });

  it("backspace moves the cursor left without erasing", () => {
    const g = emulate([chunk("abc\b\bX")], { cols: 20, rows: 3 });
    expect(rowText(g, 0)).toBe("aXc");
  });

  it("tab advances to the next 8-column stop", () => {
    const g = emulate([chunk("a\tb")], { cols: 20, rows: 2 });
    expect(charAt(g, 0, 0)).toBe("a");
    expect(charAt(g, 0, 8)).toBe("b");
  });

  it("deferred wrap: a glyph in the last column wraps only on the NEXT glyph", () => {
    const g = emulate([chunk("abc")], { cols: 3, rows: 3 });
    expect(rowText(g, 0)).toBe("abc");
    // Cursor parks at the last column with wrap pending, not yet on row 1.
    expect(g.cursorRow).toBe(0);
    const g2 = emulate([chunk("abcd")], { cols: 3, rows: 3 });
    expect(rowText(g2, 0)).toBe("abc");
    expect(charAt(g2, 1, 0)).toBe("d");
  });

  it("scrolls when LF runs off the bottom row", () => {
    const g = emulate([chunk("one\r\ntwo\r\nthree")], { cols: 10, rows: 2 });
    // 'one' scrolled off; 'two' is now the top row.
    expect(rowText(g, 0)).toBe("two");
    expect(rowText(g, 1)).toBe("three");
  });
});

describe("AttributionEngine — cursor & erase (CSI)", () => {
  it("CUP positions the cursor (1-based) before writing", () => {
    const g = emulate([chunk("\x1b[2;3HX")], { cols: 10, rows: 5 });
    expect(charAt(g, 1, 2)).toBe("X");
  });

  it("CUF / CUB / CUU / CUD move relative", () => {
    const g = emulate([chunk("A\x1b[2CB\x1b[4D\x1b[1BC")], {
      cols: 10,
      rows: 5,
    });
    expect(charAt(g, 0, 0)).toBe("A");
    expect(charAt(g, 0, 3)).toBe("B"); // A at 0, CUF 2 → col 3
    expect(charAt(g, 1, 0)).toBe("C"); // CUB 4 → col 0, CUD 1 → row 1
  });

  it("EL (erase to end of line) clears from the cursor", () => {
    const g = emulate([chunk("abcdef\r\x1b[3C\x1b[0K")], { cols: 10, rows: 2 });
    expect(rowText(g, 0)).toBe("abc");
    expect(cell(g, 0, 3)).toBeNull();
  });

  it("ED 2 clears the whole screen", () => {
    const g = emulate([chunk("junk\r\nmore\x1b[2JX")], { cols: 10, rows: 3 });
    expect(rowText(g, 0)).toBe("");
    // ED clears every prior glyph but leaves the cursor where it was (row 1,
    // col 4 after "more"), so the trailing X lands there and nothing else shows.
    expect(charAt(g, 1, 4)).toBe("X");
    expect(cell(g, 1, 0)).toBeNull();
    expect(charAt(g, 2, 0)).toBe("");
  });

  it("ECH erases N cells in place without moving the cursor", () => {
    const g = emulate([chunk("abcdef\r\x1b[2C\x1b[2X")], { cols: 10, rows: 2 });
    expect(charAt(g, 0, 1)).toBe("b");
    expect(cell(g, 0, 2)).toBeNull();
    expect(cell(g, 0, 3)).toBeNull();
    expect(charAt(g, 0, 4)).toBe("e");
  });

  it("DCH deletes characters, pulling the tail left", () => {
    const g = emulate([chunk("abcdef\r\x1b[2P")], { cols: 10, rows: 2 });
    expect(rowText(g, 0)).toBe("cdef");
  });

  it("ICH inserts blanks, pushing the tail right", () => {
    const g = emulate([chunk("abcdef\r\x1b[2@")], { cols: 10, rows: 2 });
    expect(cell(g, 0, 0)).toBeNull();
    expect(cell(g, 0, 1)).toBeNull();
    expect(charAt(g, 0, 2)).toBe("a");
  });

  it("IL / DL insert and delete whole lines", () => {
    const ins = emulate([chunk("r0\r\nr1\r\nr2\x1b[2;1H\x1b[1L")], {
      cols: 10,
      rows: 3,
    });
    expect(rowText(ins, 0)).toBe("r0");
    expect(rowText(ins, 1)).toBe(""); // blank line inserted at row 1
    expect(rowText(ins, 2)).toBe("r1"); // r1 pushed down; r2 scrolled off
  });
});

describe("AttributionEngine — SGR pen", () => {
  it("applies foreground color to subsequently-written cells", () => {
    const g = emulate([chunk("\x1b[31mR\x1b[0mN")], { cols: 10, rows: 2 });
    expect(cell(g, 0, 0)?.fg).toBe("#cd0000");
    expect(cell(g, 0, 0)?.char).toBe("R");
    expect(cell(g, 0, 1)?.fg).toBeNull();
  });

  it("tracks bold and background and resets them", () => {
    const g = emulate([chunk("\x1b[1;44mB\x1b[mP")], { cols: 10, rows: 2 });
    expect(cell(g, 0, 0)?.bold).toBe(true);
    expect(cell(g, 0, 0)?.bg).toBe("#0000ee");
    expect(cell(g, 0, 1)?.bold).toBe(false);
    expect(cell(g, 0, 1)?.bg).toBeNull();
  });

  it("decodes 256-color and truecolor extended SGR", () => {
    const g = emulate([chunk("\x1b[38;5;196mA\x1b[38;2;10;20;30mB")], {
      cols: 10,
      rows: 2,
    });
    expect(cell(g, 0, 0)?.fg).toBe(css196());
    expect(cell(g, 0, 1)?.fg).toBe("rgb(10,20,30)");
  });
});

// xterm 256-color #196 resolves to pure red via the 6x6x6 cube.
function css196(): string {
  return "rgb(255,0,0)";
}

describe("AttributionEngine — attribution (the whole point)", () => {
  it("traces each cell to its chunk, time, and byte offset", () => {
    const c1 = chunk("ab", 100, 0); // offsets 0,1
    const c2 = chunk("cd", 250, 2); // offsets 0,1 ; stream 2,3
    const g = emulate([c1, c2], { cols: 10, rows: 2 });

    expect(cell(g, 0, 0)).toMatchObject({
      char: "a",
      chunkId: c1.chunkId,
      tMs: 100,
      byteOffset: 0,
      streamOffset: 0,
    });
    expect(cell(g, 0, 2)).toMatchObject({
      char: "c",
      chunkId: c2.chunkId,
      tMs: 250,
      byteOffset: 0,
      streamOffset: 2,
    });
    expect(cell(g, 0, 3)).toMatchObject({
      char: "d",
      byteOffset: 1,
      streamOffset: 3,
    });
  });

  it("offset points past a leading escape sequence to the glyph's real byte", () => {
    // "\x1b[31m" is 5 bytes (0..4); 'X' is byte 5.
    const c = chunk("\x1b[31mX", 0, 0);
    const g = emulate([c], { cols: 10, rows: 2 });
    expect(cell(g, 0, 0)).toMatchObject({
      char: "X",
      byteOffset: 5,
      streamOffset: 5,
    });
  });

  it("overwrite attributes the cell to the LAST byte that wrote it", () => {
    const c = chunk("A\rB", 0, 0); // 'A' offset 0, CR offset 1, 'B' offset 2
    const g = emulate([c], { cols: 10, rows: 2 });
    expect(cell(g, 0, 0)).toMatchObject({ char: "B", byteOffset: 2 });
  });
});

describe("AttributionEngine — resumability across chunk splits", () => {
  it("a CSI sequence split across two chunks still positions correctly", () => {
    const eng = new AttributionEngine({ cols: 10, rows: 5 });
    eng.pushBytes(chunk("\x1b[2", 10, 0)); // CSI begins, no final yet
    eng.pushBytes(chunk(";3HX", 20, 3)); // final 'H' arrives in chunk 2
    const g = eng.snapshot();
    expect(charAt(g, 1, 2)).toBe("X");
    // 'X' was written by chunk 2 (byte offset 3 within it).
    expect(cell(g, 1, 2)).toMatchObject({ tMs: 20, byteOffset: 3 });
  });

  it("a multi-byte UTF-8 grapheme split across chunks is attributed to its FIRST byte", () => {
    // '€' = E2 82 AC. Split after the lead byte.
    const lead = new Uint8Array([0xe2]);
    const tail = new Uint8Array([0x82, 0xac]);
    const eng = new AttributionEngine({ cols: 10, rows: 2 });
    eng.pushBytes({ chunkId: 1, tMs: 5, baseOffset: 0, bytes: lead });
    eng.pushBytes({ chunkId: 2, tMs: 9, baseOffset: 1, bytes: tail });
    const g = eng.snapshot();
    expect(charAt(g, 0, 0)).toBe("€");
    // Attribution credits the chunk/time/offset of the lead byte, not the tail.
    expect(cell(g, 0, 0)).toMatchObject({
      chunkId: 1,
      tMs: 5,
      byteOffset: 0,
      streamOffset: 0,
    });
  });

  it("incremental pushBytes equals one-shot emulate of the joined stream", () => {
    const parts = ["\x1b[32m", "gr", "een\r\n", "\x1b[0mplain"];
    const oneShot = emulate([chunk(parts.join(""), 0, 0)], {
      cols: 20,
      rows: 4,
    });

    const eng = new AttributionEngine({ cols: 20, rows: 4 });
    let base = 0;
    for (const p of parts) {
      const c = chunk(p, 0, base);
      base += c.bytes.length;
      eng.pushBytes(c);
    }
    const streamed = eng.snapshot();
    expect(streamed.cells.map((c) => c?.char ?? null)).toEqual(
      oneShot.cells.map((c) => c?.char ?? null),
    );
  });
});

describe("AttributionEngine — distinguishing blank kinds", () => {
  it("a written space is attributed; an untouched cell is null", () => {
    const g = emulate([chunk("a b")], { cols: 10, rows: 2 });
    expect(cell(g, 0, 1)).toMatchObject({ char: " " }); // the typed space
    expect(cell(g, 0, 3)).toBeNull(); // never written
  });

  it("alt-screen enter clears the primary screen content", () => {
    const g = emulate([chunk("visible\x1b[?1049hA")], { cols: 10, rows: 2 });
    expect(rowText(g, 0)).toBe("A");
  });
});
