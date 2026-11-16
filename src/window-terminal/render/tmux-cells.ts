// src/window-terminal/render/tmux-cells.ts
//
// TMUX_CELLS — the xterm.js Unicode provider that puts each character in the
// cell tmux puts it in. A pane's bytes are written to xterm as the program
// sent them, and tmux keeps its own grid of them; every later cursor move
// and every capture is in tmux's columns, so xterm must count a character's
// cells as tmux does or everything after it on the line lands in the wrong
// column.
//
// tmux counts in two steps, and this provider replays both:
//   - a codepoint's width (utf8.c, utf8_width): the table in
//     cell-width-table.ts, generated from the utf8proc tmux links and tmux's
//     own override table;
//   - whether it joins the cell before it (screen-write.c,
//     screen_write_combine; utf8-combined.c): a zero-width codepoint, a
//     zero width joiner (ZWJ) or VS16 joins, and VS16 makes a one-cell
//     character two (`variation-selector-always-wide`, on by default); an
//     emoji modifier joins its base and a regional indicator its partner,
//     both two cells; whatever follows a ZWJ joins; Hangul jamo compose; and
//     a cell holds at most UTF8_SIZE bytes.
//
// Where xterm's input handler, not the provider, decides, it cannot follow
// tmux: a zero-width codepoint in column 0 gets a cell; xterm forgets the
// cell before at every escape sequence or control character, where tmux
// still joins onto it; and a character widened in the last column wraps,
// where tmux keeps it there.
//
// [LAW:one-source-of-truth] tmux is the authority on a cell's width; the
//   table is generated from its sources, never edited by hand.
// [LAW:effects-at-boundaries] Pure: xterm calls `charProperties` with what
//   it answered for the codepoint before, and this answer carries what tmux
//   knows of the cell the next one may join.

import type { IUnicodeVersionProvider } from "@xterm/xterm";
import {
  DOUBLE_WIDTH,
  MODIFIER_BASES,
  ZERO_WIDTH,
} from "./cell-width-table.js";

const ZWJ = 0x200d;
const VS16 = 0xfe0f;
const HANGUL_FILLER = 0x3164;
// tmux.h: the bytes one cell's character may hold.
const UTF8_SIZE = 32;

function inRuns(c: number, runs: readonly number[]): boolean {
  let lo = 0;
  let hi = runs.length / 2 - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (c < runs[2 * mid]) hi = mid - 1;
    else if (c > runs[2 * mid + 1]) lo = mid + 1;
    else return true;
  }
  return false;
}

function width(c: number): 0 | 1 | 2 {
  if (inRuns(c, ZERO_WIDTH)) return 0;
  return inRuns(c, DOUBLE_WIDTH) ? 2 : 1;
}

function utf8Length(c: number): number {
  return c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
}

const isRegional = (c: number): boolean => c >= 0x1f1e6 && c <= 0x1f1ff;
const isModifier = (c: number): boolean => c >= 0x1f3fb && c <= 0x1f3ff;
const modifierBases: ReadonlySet<number> = new Set(MODIFIER_BASES);

// The skin-tone role of a cell's first codepoint.
const SKIN_NONE = 0;
const SKIN_BASE = 1;
const SKIN_MODIFIER = 2;

function skinOf(c: number): number {
  if (modifierBases.has(c)) return SKIN_BASE;
  return isModifier(c) ? SKIN_MODIFIER : SKIN_NONE;
}

// utf8-combined.c, hanguljamo_get_class: each class composes onto the one
// before it.
const JAMO_NONE = 0;
const JAMO_CHOSEONG = 1;
const JAMO_JUNGSEONG = 2;
const JAMO_JONGSEONG = 3;

function jamoOf(c: number): number {
  if ((c >= 0x1100 && c <= 0x115f) || (c >= 0xa960 && c <= 0xa97c)) {
    return JAMO_CHOSEONG;
  }
  if ((c >= 0x1160 && c <= 0x11a7) || (c >= 0xd7b0 && c <= 0xd7c6)) {
    return JAMO_JUNGSEONG;
  }
  if ((c >= 0x11a8 && c <= 0x11ff) || (c >= 0xd7cb && c <= 0xd7fb)) {
    return JAMO_JONGSEONG;
  }
  return JAMO_NONE;
}

// An answer to xterm, as xterm packs it (UnicodeService): bit 0 "joins the
// cell before", bits 1-2 the cell's width (0: there is no cell), and above
// them 24 bits of the provider's own, here what tmux knows of the cell:
//   bits 3-8   the UTF-8 bytes it holds
//   bit 9      its last codepoint is a ZWJ
//   bits 10-11 the regional indicators in it, at most 2, if its first
//              codepoint is one (tmux pairs no other)
//   bits 12-13 its first codepoint's skin-tone role
//   bits 14-15 its last codepoint's jamo class
//   bit 16     tmux joins nothing onto it
const widthOf = (p: number): number => (p >> 1) & 3;
const bytesOf = (p: number): number => (p >> 3) & 0x3f;
const endsInZwj = (p: number): boolean => ((p >> 9) & 1) === 1;
const regionalOf = (p: number): number => (p >> 10) & 3;
const skinRoleOf = (p: number): number => (p >> 12) & 3;
const jamoClassOf = (p: number): number => (p >> 14) & 3;
const SEALED = 1 << 16;
const isSealed = (p: number): boolean => (p & SEALED) !== 0;

function answer(
  joins: boolean,
  cells: number,
  bytes: number,
  zwj: boolean,
  regional: number,
  skin: number,
  jamo: number,
): number {
  return (
    Number(joins) |
    (cells << 1) |
    (bytes << 3) |
    (Number(zwj) << 9) |
    (regional << 10) |
    (skin << 12) |
    (jamo << 14)
  );
}

function newCell(c: number, cells: number): number {
  return answer(
    false,
    cells,
    utf8Length(c),
    false,
    isRegional(c) ? 1 : 0,
    skinOf(c),
    jamoOf(c),
  );
}

// tmux drops the codepoint. xterm cannot drop one, so it joins the cell
// before without changing what tmux knows of it or how wide it is. In
// column 0 there is no cell before, and xterm gives the codepoint one.
function dropped(before: number): number {
  return before | 1;
}

function joined(before: number, c: number, wide: boolean): number {
  const cells = wide && widthOf(before) === 1 ? 2 : widthOf(before);
  const bytes = bytesOf(before) + utf8Length(c);
  // tmux keeps a cell's byte count in five bits and its width as width + 1
  // in the bits above (utf8.c, UTF8_SET_SIZE, UTF8_SET_WIDTH), so a cell of
  // UTF8_SIZE bytes reads back holding none and two wide. Two cells wide, it
  // is joined onto still, with no codepoint left for the next one to pair
  // with; one cell wide, tmux joins nothing onto it again.
  if (bytes === UTF8_SIZE) {
    return (
      answer(true, cells, 0, false, 0, SKIN_NONE, JAMO_NONE) |
      (cells === 2 ? 0 : SEALED)
    );
  }
  const regional = regionalOf(before);
  return answer(
    true,
    cells,
    bytes,
    c === ZWJ,
    regional === 0 ? 0 : Math.min(regional + (isRegional(c) ? 1 : 0), 2),
    skinRoleOf(before),
    jamoOf(c),
  );
}

// utf8_should_combine, both ways round: two lone regional indicators, or a
// modifier base and a skin tone in either order.
function pairs(before: number, c: number): boolean {
  if (isRegional(c)) return regionalOf(before) === 1;
  const skin = skinRoleOf(before);
  return (
    (skin === SKIN_BASE && isModifier(c)) ||
    (skin === SKIN_MODIFIER && modifierBases.has(c))
  );
}

// A printable ASCII character: a cell of its own, one wide, one byte.
const ASCII_CELL = answer(false, 1, 1, false, 0, SKIN_NONE, JAMO_NONE);

// [HOT-PATH] xterm calls this for every character a pane prints.
function charProperties(c: number, before: number): number {
  if (c >= 0x20 && c < 0x7f) return ASCII_CELL;
  if (c === HANGUL_FILLER) return dropped(before);
  const w = width(c);
  const zero = c === ZWJ || c === VS16 || w === 0;
  // tmux joins only onto a cell that takes it, and never an ASCII character.
  if (c < 0x80 || widthOf(before) === 0 || isSealed(before)) {
    return zero ? dropped(before) : newCell(c, w);
  }
  let wide = c === VS16;
  if (!zero) {
    const jamo = jamoOf(c);
    if (jamo === JAMO_CHOSEONG) return newCell(c, w);
    if (jamo !== JAMO_NONE) {
      if (jamoClassOf(before) !== jamo - 1) return dropped(before);
    } else if (pairs(before, c)) {
      wide = true;
    } else if (!endsInZwj(before)) {
      return newCell(c, w);
    }
  }
  if (bytesOf(before) + utf8Length(c) > UTF8_SIZE) {
    return zero ? dropped(before) : newCell(c, w);
  }
  return joined(before, c, wide);
}

/** xterm.js's Unicode provider for tmux's cell widths. */
export const TMUX_CELLS: IUnicodeVersionProvider = {
  version: "tmux",
  wcwidth: width,
  charProperties,
};
