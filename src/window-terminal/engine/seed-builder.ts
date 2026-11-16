// src/window-terminal/engine/seed-builder.ts
//
// `buildSeed` — the pure tmux capture-grid reconstruction. Given the raw
// `capture-pane` output, the `display-message` state reply, and the requested
// scrollback depth, it produces the exact byte sequence (`captured`) plus
// cursor position (`cursor`) a `TerminalSink.seed()` replays to paint a freshly
// attached pane so its cursor and viewport line up with tmux's grid, and the
// size (`size`) that grid was captured at.
//
// [LAW:decomposition] This is a tmux-specific grid algorithm — flag→escape
//   selection, blank-row padding, DEC private-mode synthesis, Latin-1→bytes.
//   Its change-reason is "tmux's capture/display wire shape," entirely separate
//   from PaneStream's idle→seeding→live lifecycle state machine. Cutting it out
//   leaves a part testable with plain strings — no client, no async, no state.
// [LAW:effects-at-boundaries] Pure: strings in, one value out. Every effect
//   (the RPCs that produce the inputs, the sink.seed() that consumes the
//   output, the lastSeed cache) stays in PaneStream at the boundary.

import type { Grid, SeedCursor } from "./terminal-sink.js";

/**
 * The replayable snapshot of a pane: the raw seed bytes, the cursor to home to
 * after writing them, and the size they were captured at (`null` when tmux did
 * not report one). Also the shape PaneStream caches for re-attach.
 */
export interface Seed {
  readonly captured: Uint8Array;
  readonly cursor: SeedCursor | null;
  readonly size: Grid | null;
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
 * @param stateLine — the `display-message` reply carrying cursor position, the
 *   terminal modes and scroll region the grid content can't encode, and the
 *   grid dimensions.
 * @param historyLines — the scrollback depth the caller requested in the
 *   capture (`-S -<N>`); caps the padded history-row count.
 */
export function buildSeed(
  captureOutput: readonly string[],
  stateLine: string,
  historyLines: number,
): Seed {
  const { cursor, size, height, historySize, preamble, epilogue } =
    parseSeedState(stateLine);

  // [LAW:dataflow-not-control-flow] The cursor lands correctly by making the
  // seed the exact shape tmux's grid has — not by adjusting the CUP. The sink
  // writes the seed, then a viewport-relative CUP. xterm anchors its viewport
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
  const historyRows = Number.isFinite(historySize)
    ? Math.min(historyLines, historySize)
    : 0;
  const targetRows = Number.isFinite(height) ? historyRows + height : 0;
  const lines =
    stripped.length < targetRows
      ? stripped.concat(new Array(targetRows - stripped.length).fill(""))
      : stripped;
  const screen = lines.join("\r\n");

  // Restore terminal modes around the screen content: alt-screen + wrap
  // before drawing (they affect layout), input/cursor modes after. The CUP
  // the sink appends from `cursor` lands last, so it reflects the final
  // restored state.
  //
  // The capture text arrives as Latin-1 (one code unit per raw byte — see the
  // transport). Convert back to the exact byte sequence so the sink receives
  // RAW BYTES, identical in kind to the live `write()` path; the renderer is
  // the single decoding authority. We never UTF-8-decode terminal data. The
  // mode escapes are ASCII, so they encode 1:1.
  const captured = latin1ToBytes(preamble + screen + epilogue);

  return { captured, cursor, size };
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

interface SeedState {
  readonly cursor: SeedCursor | null;
  readonly size: Grid | null;
  /** Visible grid height (`pane_height`); `NaN` if tmux didn't report it. */
  readonly height: number;
  /** Scrollback line count (`history_size`); `NaN` if not reported. */
  readonly historySize: number;
  /** Mode-setting escapes applied BEFORE the screen content (layout-affecting). */
  readonly preamble: string;
  /** Mode-setting escapes applied AFTER the screen content (input/cursor). */
  readonly epilogue: string;
}

// tmux flag values are "1"/"0"; map each to its DEC private-mode set/reset
// sequence. [LAW:dataflow-not-control-flow] The escape is selected by the
// flag VALUE through a table — no per-flag branching beyond the lookup.
// A missing OR empty field is a no-op (leave terminal state unchanged): an
// older tmux that doesn't expand a format yields "", which must NOT be read as
// "0" and actively force the mode off. Degrades like pane_height/history_size.
function mode(flag: string | undefined, onSeq: string, offSeq: string): string {
  if (flag === undefined || flag === "") return "";
  return flag === "1" ? onSeq : offSeq;
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
const CLEAR = `${ESC}[r${ESC}[H${ESC}[0m${ESC}[2J${ESC}[3J`;

// DECSTBM for tmux's 0-indexed scroll region. A field that is missing, empty
// or not an integer leaves the region as the clear set it, like mode(): an
// escape built from it would print as text.
function region(upper: string | undefined, lower: string | undefined): string {
  const [top, bottom] = [upper, lower].map((v) =>
    v === undefined || v === "" ? NaN : Number(v),
  );
  return Number.isInteger(top) && Number.isInteger(bottom)
    ? `${ESC}[${top + 1};${bottom + 1}r`
    : "";
}

function parseSeedState(line: string): SeedState {
  // Reply layout (see stateCmd): cursor_x;cursor_y;alternate_on;cursor_flag;
  // insert_flag;keypad_cursor_flag;keypad_flag;wrap_flag;pane_height;
  // history_size;scroll_region_upper;scroll_region_lower;pane_width.
  // cursor_x/y and the region rows are 0-indexed; the mode flags are 0/1;
  // pane_width, pane_height and history_size are grid dimensions.
  const f = line.split(";");
  const cx = Number(f[0]);
  const cy = Number(f[1]);
  // Both coordinate fields must be present: Number("") is 0, so a missing
  // cursor_y (e.g. "5;") would otherwise pass Number.isInteger and emit a
  // bogus {col:5,row:0}, misplacing the CUP.
  const cursor =
    f[0] !== undefined &&
    f[0] !== "" &&
    f[1] !== undefined &&
    f[1] !== "" &&
    Number.isInteger(cx) &&
    Number.isInteger(cy)
      ? { col: cx, row: cy }
      : null;
  // NaN when absent (e.g. a fake/older tmux) — the seed normalization treats
  // NaN as "skip", degrading to the strip-only behaviour rather than padding.
  const height = dimension(f[8]);
  const size = parseGrid(f[12], f[8]);
  const historySize = f[9] !== undefined && f[9] !== "" ? Number(f[9]) : NaN;

  // Before content: establish the correct screen buffer, clear it, then set
  // autowrap — all of which affect how screen content lays out.
  //   On a reseed, ?1049l exits a stale alt screen before drawing main-screen
  //   content; ?1049h enters alt screen before drawing alt-screen content.
  // [LAW:one-source-of-truth] tmux holds the pane's history; a seed replaces
  //   the buffer it draws into with tmux's copy. On the main screen that is
  //   the scrollback and the screen, so however often a pane is recaptured,
  //   its history is there once; the alternate screen has no scrollback.
  // [LAW:dataflow-not-control-flow] The clear is the same bytes for every
  //   seed; the flags select only the screen buffer and the modes.
  const preamble =
    mode(f[2], `${ESC}[?1049h`, `${ESC}[?1049l`) + // alt / main screen
    CLEAR +
    mode(f[7], `${ESC}[?7h`, `${ESC}[?7l`); // DECAWM autowrap

  // After content: the scroll region and the input/cursor modes that the
  // captured grid can't carry. DECSTBM homes the cursor; the sink's CUP
  // follows the epilogue.
  const epilogue =
    region(f[10], f[11]) +
    mode(f[3], `${ESC}[?25h`, `${ESC}[?25l`) + // DECTCEM cursor visibility
    mode(f[4], `${ESC}[4h`, `${ESC}[4l`) + // IRM insert mode
    mode(f[5], `${ESC}[?1h`, `${ESC}[?1l`) + // DECCKM application cursor keys
    mode(f[6], `${ESC}=`, `${ESC}>`); // DECKPAM/DECKPNM keypad mode

  return { cursor, size, height, historySize, preamble, epilogue };
}
