// examples/web-multiplexer/web/ansi-text.ts
//
// Pure helpers that turn a raw terminal byte stream (as Latin-1 text) into
// plain searchable lines. Used by SearchStore to derive the same plain-text
// corpus from the live `%output` stream that `capture-pane -p` produces for
// history backfill.
//
// [LAW:effects-at-boundaries] Zero IO, zero state shared with the world.
//   `stripAnsi` is a pure function; `LineAssembler` owns only its own
//   carry-over remainder. Both are exhaustively unit-testable in isolation.
//
// LIMITATION (recorded for the showcase): this is escape-stripping, not
// terminal emulation. A `\r`-driven in-place redraw (progress bars) or a
// cursor-addressed TUI will not reproduce byte-for-byte what `capture-pane`
// renders, because faithfully reconstructing the *screen* requires a grid
// model. Neither `@promptctl/pane-terminal` nor the protocol package exposes
// a plain-text extraction primitive today (only byte sinks, the xterm
// renderer, and `bytesToLatin1` / `decodeOctalEscapes`) — see SHOWCASE.md.
// For full-text scrollback search, line-granular stripping is the right
// fidelity/complexity trade.

// Sequenced replacements, widest-consuming first so a later pattern never
// eats the prefix of an earlier one (OSC/DCS contain the ST `ESC \`, which a
// naive lone-escape pass would otherwise truncate).
//
// eslint-disable-next-line no-control-regex -- matching control bytes is the point
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g; // OSC … (BEL | ST)
// eslint-disable-next-line no-control-regex
const DCS = /\x1bP[^\x1b]*\x1b\\/g; // DCS … ST
// eslint-disable-next-line no-control-regex
const CSI = /\x1b\[[0-9;:?]*[ -/]*[@-~]/g; // CSI: params, intermediates, final
// eslint-disable-next-line no-control-regex
const ESC_OTHER = /\x1b./g; // any remaining two-byte escape (best-effort)
// eslint-disable-next-line no-control-regex
const C0 = /[\x00-\x08\x0b-\x1f\x7f]/g; // C0 controls + DEL, keeping \t and \n

/**
 * Remove ANSI/VT escape sequences and C0 control bytes from a single line of
 * Latin-1-decoded terminal output, leaving printable text (tabs preserved).
 * `\r` is dropped as a control byte, so a `\r\n` line ending collapses to the
 * visible text.
 */
export function stripAnsi(input: string): string {
  return input
    .replace(OSC, "")
    .replace(DCS, "")
    .replace(CSI, "")
    .replace(ESC_OTHER, "")
    .replace(C0, "");
}

/**
 * Reassembles a per-pane byte stream that arrives in arbitrary `%output`
 * chunks into completed plain-text lines. A line is emitted only once its
 * terminating `\n` has been seen; the trailing partial line is carried in
 * `remainder` until more output (or a `flush()`) completes it.
 *
 * Splitting on `\n` *before* stripping is safe: ANSI sequences never contain a
 * newline, so a `\n` is always a true line boundary even mid-sequence.
 *
 * [LAW:no-ambient-temporal-coupling] Ordering across chunk boundaries is owned
 *   here as explicit state (`remainder`), not left to incidental call timing.
 */
export class LineAssembler {
  private remainder = "";

  /** Feed a decoded chunk; returns the lines it completed (possibly empty). */
  push(chunk: string): string[] {
    this.remainder += chunk;
    const out: string[] = [];
    let nl = this.remainder.indexOf("\n");
    while (nl !== -1) {
      out.push(stripAnsi(this.remainder.slice(0, nl)));
      this.remainder = this.remainder.slice(nl + 1);
      nl = this.remainder.indexOf("\n");
    }
    return out;
  }

  /** Emit any buffered partial line as a final line and clear the buffer. */
  flush(): string | null {
    if (this.remainder.length === 0) return null;
    const line = stripAnsi(this.remainder);
    this.remainder = "";
    return line;
  }
}
