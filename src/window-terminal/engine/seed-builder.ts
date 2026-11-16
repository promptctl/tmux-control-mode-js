// src/window-terminal/engine/seed-builder.ts
//
// `buildSeed` — the pure tmux capture-grid reconstruction. Given the raw
// `capture-pane` output, the `display-message` state reply, and the requested
// scrollback depth, it produces the exact byte sequence (`captured`) plus
// cursor position (`cursor`) a `TerminalSink.seed()` replays to paint a freshly
// attached pane so its cursor and viewport line up with tmux's grid.
//
// [LAW:decomposition] This is a tmux-specific grid algorithm — flag→escape
//   selection, blank-row padding, DEC private-mode synthesis, Latin-1→bytes.
//   Its change-reason is "tmux's capture/display wire shape," entirely separate
//   from PaneStream's idle→seeding→live lifecycle state machine. Cutting it out
//   leaves a part testable with plain strings — no client, no async, no state.
// [LAW:effects-at-boundaries] Pure: strings in, one value out. Every effect
//   (the RPCs that produce the inputs, the sink.seed() that consumes the
//   output, the lastSeed cache) stays in PaneStream at the boundary.

import type { SeedCursor } from "./terminal-sink.js";

/**
 * The replayable snapshot of a pane: the raw seed bytes plus the cursor to home
 * to after writing them. Also the shape PaneStream caches for re-attach.
 */
export interface Seed {
  readonly captured: Uint8Array;
  readonly cursor: SeedCursor | null;
}

/**
 * Reconstruct a pane's seed bytes from a tmux capture.
 *
 * @param captureOutput — `capture-pane -peqN` output, one string per screen row
 *   (Latin-1 code units, one per raw byte). No `-J`, so line count equals the
 *   screen row count — the row-exact normalization below depends on that.
 * @param stateLine — the `display-message` reply carrying cursor position, the
 *   terminal modes the grid content can't encode, and the grid dimensions.
 * @param historyLines — the scrollback depth the caller requested in the
 *   capture (`-S -<N>`); caps the padded history-row count.
 */
export function buildSeed(
  captureOutput: readonly string[],
  stateLine: string,
  historyLines: number,
): Seed {
  const { cursor, height, historySize, preamble, epilogue } =
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

  return { captured, cursor };
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
// Cursor home, SGR reset, erase the screen (ED 2), erase the scrollback (ED 3).
const CLEAR = `${ESC}[H`;

function parseSeedState(line: string): SeedState {
  // Reply layout (see stateCmd): cursor_x;cursor_y;alternate_on;cursor_flag;
  // insert_flag;keypad_cursor_flag;keypad_flag;wrap_flag;pane_height;
  // history_size. cursor_x/y are 0-indexed; the middle fields are 0/1 mode
  // flags; the trailing two are grid dimensions.
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
  const height = f[8] !== undefined && f[8] !== "" ? Number(f[8]) : NaN;
  const historySize = f[9] !== undefined && f[9] !== "" ? Number(f[9]) : NaN;

  // Before content: establish the screen buffer, clear it, then set
  //   autowrap — all of which affect how screen content lays out.
  //   On a reseed, ?1049l exits a stale alt screen before drawing main-screen
  //   content; ?1049h enters alt screen before drawing alt-screen content.
  // A seed is the pane's whole picture, so every seed clears what the
  //   terminal shows before drawing it:
  //   - CUP home: ?1049l restores the cursor ?1049h saved, not row 0.
  //   - SGR 0: ED 2 erases with the current background, and ?1049l's DECRC
  //     restores whatever attributes ?1049h saved.
  //   - ED 2: capture-pane drops trailing blanks, so a row drawn over an old
  //     one would otherwise keep the old row's tail.
  //   - ED 3, after ED 2 so a renderer that scrolls the erased screen into the
  //     scrollback loses that too: the seed's history replaces the scrollback
  //     rather than stacking another copy under it. On the alt screen it
  //     erases the alt buffer's scrollback, which is empty, and the main
  //     screen's scrollback waits for the program to exit.
  // [LAW:dataflow-not-control-flow] The clear is the same bytes for every
  //   seed; the flags select only the screen buffer and the modes.
  const preamble =
    mode(f[2], `${ESC}[?1049h`, `${ESC}[?1049l`) + // alt / main screen
    CLEAR +
    mode(f[7], `${ESC}[?7h`, `${ESC}[?7l`); // DECAWM autowrap

  // After content: input/cursor modes that the captured grid can't carry.
  const epilogue =
    mode(f[3], `${ESC}[?25h`, `${ESC}[?25l`) + // DECTCEM cursor visibility
    mode(f[4], `${ESC}[4h`, `${ESC}[4l`) + // IRM insert mode
    mode(f[5], `${ESC}[?1h`, `${ESC}[?1l`) + // DECCKM application cursor keys
    mode(f[6], `${ESC}=`, `${ESC}>`); // DECKPAM/DECKPNM keypad mode

  return { cursor, height, historySize, preamble, epilogue };
}
