// src/window-terminal/engine/seed-builder.ts
//
// `buildSeed` — the pure tmux capture-grid reconstruction. Given the raw
// `capture-pane` output, the pane state `parseSeedState` reads from the
// `display-message` reply, and the requested scrollback depth, it produces
// the exact byte sequence (`captured`) a `TerminalSink.seed()` replays to
// paint a freshly attached pane so its cursor and viewport line up with
// tmux's grid, and the size (`size`) that grid was captured at.
//
// [LAW:decomposition] This is a tmux-specific grid algorithm — flag→escape
//   selection, blank-row padding, DEC private-mode synthesis, Latin-1→bytes.
//   Its change-reason is "tmux's capture/display wire shape," entirely separate
//   from PaneStream's idle→seeding→live lifecycle state machine. Cutting it out
//   leaves a part testable with plain strings — no client, no async, no state.
// [LAW:effects-at-boundaries] Pure: replies in, one value out. Every effect
//   (the RPCs that produce the inputs, the sink.seed() that consumes the
//   output, the lastSeed cache) stays in PaneStream at the boundary.

import type { Grid } from "./terminal-sink.js";

/**
 * The replayable snapshot of a pane: the raw seed bytes, which leave the
 * cursor where tmux had it, and the size they were captured at. Also the
 * shape PaneStream caches for re-attach.
 */
export interface Seed {
  readonly captured: Uint8Array;
  readonly size: Grid;
}

/**
 * The pane state a capture cannot carry, as tmux reported it with the capture
 * (see `parseSeedState`). Coordinates and scroll-region rows are 0-indexed.
 */
export interface SeedState {
  readonly cursor: { readonly col: number; readonly row: number };
  readonly size: Grid;
  /** Scrollback line count (`history_size`). */
  readonly historySize: number;
  readonly alternateScreen: boolean;
  readonly cursorVisible: boolean;
  readonly insertMode: boolean;
  readonly applicationCursorKeys: boolean;
  readonly applicationKeypad: boolean;
  readonly autowrap: boolean;
  /** DECOM: cursor addressing is relative to the scroll region. */
  readonly originMode: boolean;
  readonly scrollRegion: { readonly top: number; readonly bottom: number };
}

/**
 * A grid's size from tmux's decimal width and height fields (`pane_width`,
 * `pane_height`); `null` unless both are positive integers written in digits.
 */
export function parseGrid(
  width: string | undefined,
  height: string | undefined,
): Grid | null {
  const [cols, rows] = [dimension(width), dimension(height)];
  return Number.isNaN(cols) || Number.isNaN(rows) ? null : { cols, rows };
}

// One grid dimension: a positive integer written in digits, else NaN.
function dimension(field: string | undefined): number {
  const n = /^\d+$/.test(field ?? "") ? Number(field) : NaN;
  return n > 0 ? n : NaN;
}

/**
 * Reconstruct a pane's seed bytes from a tmux capture.
 *
 * @param captureOutput — `capture-pane -peqN` output, one string per screen row
 *   (Latin-1 code units, one per raw byte). No `-J`, so line count equals the
 *   screen row count — the row-exact normalization below depends on that.
 * @param state — the pane state taken with the capture: cursor position, the
 *   terminal modes and scroll region the grid content can't encode, and the
 *   grid dimensions.
 * @param historyLines — the scrollback depth the caller requested in the
 *   capture (`-S -<N>`); caps the padded history-row count.
 */
export function buildSeed(
  captureOutput: readonly string[],
  state: SeedState,
  historyLines: number,
): Seed {
  const { size, historySize } = state;

  // [LAW:dataflow-not-control-flow] The cursor lands correctly by making the
  // seed the exact shape tmux's grid has — not by adjusting the CUP. The seed
  // ends with a viewport-relative CUP. xterm anchors its viewport
  // to the bottom of the buffer, so the viewport's top aligns with tmux's
  // visible-screen top ONLY when the seed ends with exactly `pane_height`
  // rows. capture-pane (no -J) emits one line per screen row plus a trailing
  // \n after the last row, which the parser turns into a spurious "" tail.
  // But tmux also elides trailing blank rows ambiguously: a genuine blank
  // bottom row is indistinguishable from that artifact. Stripping one "" can
  // therefore drop a real blank row, leaving the seed a row short — then the
  // bottom-anchored viewport pulls a scrollback row up into view and the
  // cursor renders one row above its true position.
  //
  // Fix: strip the single trailing artifact, then PAD trailing blank rows
  // back up to the true grid height — `min(historyLines, history_size)`
  // history rows plus `pane_height` visible rows. The visible screen is then
  // exactly `pane_height` rows by construction and the CUP is correct.
  const stripped =
    captureOutput.length > 0 && captureOutput[captureOutput.length - 1] === ""
      ? captureOutput.slice(0, -1)
      : captureOutput.slice();
  const targetRows = Math.min(historyLines, historySize) + size.rows;
  const lines =
    stripped.length < targetRows
      ? stripped.concat(new Array(targetRows - stripped.length).fill(""))
      : stripped;
  // The draw scrolls every line in by the start of the cursor's row, so the
  // save there outlives the rest of the draw: the rows from the cursor's down
  // are joined by bare CR LF, which scrolls nothing and saves nothing.
  const row = cursorRow(state);
  const at = lines.length - size.rows + row;
  const screen =
    lines
      .slice(0, at)
      .map((line) => line + NEWLINE)
      .join("") +
    scrollIn(size.rows - 1 - row, row) +
    lines.slice(at).join("\r\n");

  // Restore terminal modes around the screen content: alt-screen + wrap
  // before drawing (they affect layout), input/cursor modes after.
  //
  // The capture text arrives as Latin-1 (one code unit per raw byte — see the
  // transport). Convert back to the exact byte sequence so the sink receives
  // RAW BYTES, identical in kind to the live `write()` path; the renderer is
  // the single decoding authority. We never UTF-8-decode terminal data. The
  // mode escapes are ASCII, so they encode 1:1.
  const captured = latin1ToBytes(
    preamble(state) + screen + epilogue(state, row, lines[at]),
  );

  return { captured, size };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

// Inverse of the transport's Latin-1 byte container: each code unit (0x00-0xFF)
// becomes exactly one byte. Lossless — NOT a semantic decode. UTF-8 multibyte
// sequences in the captured screen survive as their original consecutive bytes,
// to be decoded by the renderer.
function latin1ToBytes(s: string): Uint8Array {
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i) & 0xff;
  return bytes;
}

// tmux flag values are "1"/"0"; each selects its DEC private-mode set/reset
// sequence. [LAW:dataflow-not-control-flow] The escape is selected by the
// flag's value, never by whether the mode is written: every seed sets every
// mode it restores.
function mode(on: boolean, onSeq: string, offSeq: string): string {
  return on ? onSeq : offSeq;
}

const ESC = "\x1b";
// The clear every seed starts with, after the screen-buffer switch:
//   - DECSTBM reset: under a scroll region left by the live stream, the rows
//     would scroll only inside it, and none would reach the scrollback.
//   - CUP home: ?1049l restores the cursor saved at the matching ?1049h, not
//     row 0, so content would draw mid-screen.
//   - SGR 0: an erase fills with the current background, and ?1049l's DECRC
//     restores whatever attributes ?1049h saved.
//   - ED 2: capture-pane drops trailing blanks, so a row drawn over an old one
//     would otherwise keep the old row's tail.
//   - ED 3: erases the scrollback, which the history rows then rewrite.
//   - G0 ASCII, G1 DEC Special Graphics, SI: capture-pane writes a
//     line-drawing cell as SO … SI, so G1 must hold the line-drawing set; and
//     ?1049l's DECRC restores whatever charset and shift DECSC saved.
const SI = "\x0f";
const CLEAR = `${ESC}[r${ESC}[H${ESC}[0m${ESC}[2J${ESC}[3J${ESC}(B${ESC})0${SI}`;

// Between rows: a line feed that scrolls in a line with the default
// background, then the next row's start under the pen the last row left.
// capture-pane carries one pen across its lines, writing only what changes,
// and xterm fills a line a feed scrolls in with the current background, so a
// bare CRLF after a row ending on a coloured cell paints the next row's tail.
// Save and restore cursor keep the pen across the feed with SGR 49 in force,
// and CUD reaches the new line whether or not the feed scrolled. CSI s/u, not
// ESC 7/8: every TerminalSink here implements them, the demo's
// AttributionEngine included.
//   The save overwrites the cursor a program saved before the reseed, which
//   tmux does not report; a DECRC after a reseed lands at the start of the
//   cursor's row (see `scrollIn`).
const NEWLINE = `${ESC}[s${ESC}[49m\n${ESC}[u\r${ESC}[B`;

// At the start of the cursor's row: save the pen and shift the capture has in
// force there, feed in every line the screen still lacks with the default
// background, then take the pen back and return to the row's start. Every row
// from here down lands on a line already in the screen, so the save survives
// for the epilogue to reprint the cursor's row with. The viewport sits on the
// bottom of the buffer, so the CUP addresses the cursor's row however many
// lines a full scrollback trimmed.
function scrollIn(feeds: number, row: number): string {
  return `${ESC}[s${ESC}[49m${"\n".repeat(feeds)}${ESC}[u${ESC}[${row + 1};1H`;
}

// The screen row the seed leaves the cursor on: tmux's. tmux can hold the
// cursor outside the region with DECOM on (its DECSTBM homes to the screen's
// top-left), but xterm.js clamps the cursor into the region under DECOM, so
// the seed takes the nearest row it can hold.
function cursorRow(s: SeedState): number {
  const frame = s.originMode
    ? s.scrollRegion
    : { top: 0, bottom: s.size.rows - 1 };
  return Math.min(Math.max(s.cursor.row, frame.top), frame.bottom);
}

// Before content: establish the correct screen buffer, clear it, then set
// autowrap — all of which affect how screen content lays out.
//   On a reseed, ?1049l exits a stale alt screen before drawing main-screen
//   content; ?1049h enters alt screen before drawing alt-screen content.
// [LAW:one-source-of-truth] tmux holds the pane's history; a seed replaces
//   the buffer it draws into with tmux's copy. On the main screen that is
//   the scrollback and the screen, so however often a pane is recaptured,
//   its history is there once; the alternate screen has no scrollback.
// [LAW:dataflow-not-control-flow] The clear is the same bytes for every
//   seed; the state selects only the screen buffer and the modes.
function preamble(s: SeedState): string {
  return (
    mode(s.alternateScreen, `${ESC}[?1049h`, `${ESC}[?1049l`) +
    CLEAR +
    mode(s.autowrap, `${ESC}[?7h`, `${ESC}[?7l`) // DECAWM
  );
}

// After content: the scroll region, the cursor where tmux has it, then the
// modes the captured grid can't carry. DECSTBM and DECOM both home the
// cursor, so the cursor comes after them; its CUP is 1-indexed and, under
// DECOM, relative to the region's top row.
//   tmux reports cursor_x == pane_width while a wrap is pending: the program
//   printed into the last column, and its next character starts the next
//   row. Only printing there pends a wrap — a CUP or SCORC clamps to the last
//   column — so the seed reprints the cursor's row under the pen and shift
//   `scrollIn` saved at its start. IRM comes after, so the reprint overwrites.
//   [LAW:dataflow-not-control-flow] Every seed draws the same way; tmux's
//   cursor column selects only the bytes that place the cursor.
//   SI and SGR 0 end the shift and pen the capture's last cell left set:
//   capture-pane writes no reset after it, and tmux reports neither the
//   program's shift nor its pen, so the live stream gets tmux's initial ones.
//   G1 stays the line-drawing set, which a curses program designates once
//   at startup and then reaches with SO. Neither clears a pending wrap.
function epilogue(s: SeedState, row: number, cursorLine: string): string {
  const cup = (col: number): string =>
    `${ESC}[${row - (s.originMode ? s.scrollRegion.top : 0) + 1};${col}H`;
  return (
    `${ESC}[${s.scrollRegion.top + 1};${s.scrollRegion.bottom + 1}r` +
    mode(s.originMode, `${ESC}[?6h`, `${ESC}[?6l`) + // DECOM
    (s.cursor.col === s.size.cols
      ? `${ESC}[u${cup(1)}${cursorLine}` // SCORC, CUP, the row again
      : cup(s.cursor.col + 1)) +
    mode(s.cursorVisible, `${ESC}[?25h`, `${ESC}[?25l`) + // DECTCEM
    mode(s.insertMode, `${ESC}[4h`, `${ESC}[4l`) + // IRM
    mode(s.applicationCursorKeys, `${ESC}[?1h`, `${ESC}[?1l`) + // DECCKM
    mode(s.applicationKeypad, `${ESC}=`, `${ESC}>`) + // DECKPAM/DECKPNM
    `${SI}${ESC}[0m` // SGR 0
  );
}

// The state reply's grammar: tmux's formats, in the order the reply carries
// them. Counts and rows are decimal digits and flags 0/1; a pane's size is
// `parseGrid`'s alone. tmux >= 3.2 expands every one of these formats.
const COUNT = /^\d+$/;
const FLAG = /^[01]$/;
const SIZE = /^/;
const STATE_FIELDS = {
  cursor_x: COUNT,
  cursor_y: COUNT,
  alternate_on: FLAG,
  cursor_flag: FLAG,
  insert_flag: FLAG,
  keypad_cursor_flag: FLAG,
  keypad_flag: FLAG,
  wrap_flag: FLAG,
  origin_flag: FLAG,
  pane_height: SIZE,
  history_size: COUNT,
  scroll_region_upper: COUNT,
  scroll_region_lower: COUNT,
  pane_width: SIZE,
};

export type SeedStateField = keyof typeof STATE_FIELDS;

/** The state reply's formats, in the order `SEED_STATE_FORMAT` asks for them. */
export const SEED_STATE_FIELDS = Object.keys(
  STATE_FIELDS,
) as readonly SeedStateField[];

// [LAW:one-source-of-truth] The format PaneStream asks tmux for and the
//   grammar `parseSeedState` reads are both STATE_FIELDS.
/** The `display-message` format whose reply `parseSeedState` reads. */
export const SEED_STATE_FORMAT = SEED_STATE_FIELDS.map((f) => `#{${f}}`).join(
  ";",
);

/**
 * The pane state from the `display-message` reply PaneStream takes with each
 * capture; `null` when the reply is not `SEED_STATE_FORMAT`'s shape (any field
 * missing, empty or malformed, a zero dimension, or a cursor or scroll region
 * off the screen), which only a malformed reply can be.
 *
 * [LAW:parse-dont-validate] A `SeedState` holds every field the seed needs, so
 *   nothing downstream asks whether one is there.
 */
export function parseSeedState(line: string): SeedState | null {
  const values = line.split(";");
  if (
    values.length !== SEED_STATE_FIELDS.length ||
    !SEED_STATE_FIELDS.every((f, i) => STATE_FIELDS[f].test(values[i]))
  ) {
    return null;
  }
  const f = Object.fromEntries(
    SEED_STATE_FIELDS.map((name, i) => [name, values[i]]),
  ) as Record<SeedStateField, string>;
  const size = parseGrid(f.pane_width, f.pane_height);
  const cursor = { col: Number(f.cursor_x), row: Number(f.cursor_y) };
  const scrollRegion = {
    top: Number(f.scroll_region_upper),
    bottom: Number(f.scroll_region_lower),
  };
  // The cursor is on the screen; its column is the width while a wrap is
  // pending. A region spans two rows or more (tmux refuses a one-row
  // DECSTBM) or is the whole screen. The epilogue's DECSTBM and DECOM-relative
  // CUP rely on both.
  if (
    size === null ||
    cursor.row >= size.rows ||
    cursor.col > size.cols ||
    scrollRegion.bottom >= size.rows ||
    (scrollRegion.top >= scrollRegion.bottom &&
      !(scrollRegion.top === 0 && scrollRegion.bottom === size.rows - 1))
  ) {
    return null;
  }
  return {
    cursor,
    size,
    historySize: Number(f.history_size),
    alternateScreen: f.alternate_on === "1",
    cursorVisible: f.cursor_flag === "1",
    insertMode: f.insert_flag === "1",
    applicationCursorKeys: f.keypad_cursor_flag === "1",
    applicationKeypad: f.keypad_flag === "1",
    autowrap: f.wrap_flag === "1",
    originMode: f.origin_flag === "1",
    scrollRegion,
  };
}
