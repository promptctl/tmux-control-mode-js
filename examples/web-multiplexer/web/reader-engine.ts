// examples/web-multiplexer/web/reader-engine.ts
//
// ReaderEngine — the pure core of Terminal Reader mode: turn a pane's raw byte
// stream into clean, reflowed, readable prose. It strips ANSI/control noise
// (reusing `ansi-text.ts`), accumulates the stripped logical lines per pane, and
// — via the pure `reflow` function — word-wraps a pane's lines to a chosen page
// width so a long log or man page reads as a calm column instead of a cramped,
// terminal-width-hard-wrapped grid.
//
// [LAW:effects-at-boundaries] Zero IO, zero MobX, no DOM. Given raw pane byte
//   chunks (Latin-1 decoded) it accumulates stripped lines; given lines + a
//   width it returns display segments. Inputs are bytes/values, outputs are
//   values — exhaustively unit-testable in isolation.
// [LAW:one-source-of-truth] The per-pane stripped logical lines are canonical.
//   The wrapped display segments are a PURE DERIVATION of (lines, width) — never
//   stored — so changing the page width re-wraps without re-ingesting a byte.
// [LAW:dataflow-not-control-flow] Every assembled line runs the same
//   expand → classify → wrap pipeline. A blank line is the `break` variant of a
//   represented union, not a skipped branch; "nothing read yet" is the
//   empty-array case.
// [LAW:types-are-the-program] A `ReaderSegment` is either rendered `text` (with
//   an honest `continuation` flag for the tail of a wrapped line) or a paragraph
//   `break`. "A blank that is also text" is unrepresentable, so the view never
//   branches on "is this line empty".
//
// LIMITATION (recorded honestly, like `ansi-text.ts` — [LAW:no-silent-failure]):
// reflow NORMALIZES whitespace (tabs and internal runs collapse to single
// spaces) because that is what "reflow as prose" means. So column-aligned
// tables and significant indentation are flattened — reader mode is for
// prose-like output (logs, man pages, READMEs), not for preserving a grid. A
// rendered *table* is the Structured Data Sniffer's job; faithful screen
// reconstruction is the Time Machine's. Reader mode trades layout fidelity for
// readability, deliberately.

import { LineAssembler } from "./ansi-text.ts";

/**
 * One display unit produced by reflowing a pane's lines to a page width. Either
 * a piece of rendered text — `continuation` is true for every wrapped segment
 * after the first, so the view can mark a soft-wrapped tail — or a paragraph
 * `break` standing for a run of blank source lines. `id` is positional within a
 * single reflow result (a stable React key); `sourceLine` is the 1-based index
 * of the logical line a `text` segment came from.
 */
export type ReaderSegment =
  | {
      readonly kind: "text";
      readonly id: number;
      readonly sourceLine: number;
      readonly continuation: boolean;
      readonly text: string;
    }
  | { readonly kind: "break"; readonly id: number };

/**
 * Greedy word-wrap one logical line to `<= width` columns at whitespace
 * boundaries. Whitespace (spaces and tabs) is normalized to single spaces; a
 * single word longer than the width is hard-split into width-sized pieces. An
 * empty / whitespace-only line returns `[""]`, so a blank stays one segment.
 * Always returns at least one segment.
 */
export function wrapLine(line: string, width: number): string[] {
  const w = Math.max(1, Math.floor(width));
  const words = line.split(/[ \t]+/).filter((s) => s.length > 0);
  if (words.length === 0) return [""];

  const out: string[] = [];
  let cur = "";
  for (const word of words) {
    for (const piece of hardSplit(word, w)) {
      if (cur === "") {
        cur = piece;
      } else if (cur.length + 1 + piece.length <= w) {
        cur += ` ${piece}`;
      } else {
        out.push(cur);
        cur = piece;
      }
    }
  }
  if (cur !== "") out.push(cur);
  return out.length > 0 ? out : [""];
}

/** Break a single over-long word into `<= width` pieces (never inserts spaces). */
function hardSplit(word: string, width: number): string[] {
  if (word.length <= width) return [word];
  const pieces: string[] = [];
  for (let i = 0; i < word.length; i += width) {
    pieces.push(word.slice(i, i + width));
  }
  return pieces;
}

/**
 * Reflow a pane's stripped logical lines into display segments wrapped to
 * `width` columns. Each non-blank line is word-wrapped (its first segment is a
 * fresh paragraph line, the rest are `continuation`s); each run of blank lines
 * collapses to a single `break`. Leading and trailing blank runs are dropped so
 * the reader starts and ends on real text.
 *
 * Pure derivation of (lines, width): same input always yields the same
 * segments, and re-running at a new width re-wraps with no other state.
 */
export function reflow(
  lines: readonly string[],
  width: number,
): ReaderSegment[] {
  const out: ReaderSegment[] = [];
  let id = 0;
  let pendingBreak = false;
  let emittedText = false;

  lines.forEach((raw, idx) => {
    if (raw.trim() === "") {
      // A blank line is a paragraph break — but only between real text, and
      // only one per run. [LAW:dataflow-not-control-flow] absence is a value.
      if (emittedText) pendingBreak = true;
      return;
    }
    if (pendingBreak) {
      out.push({ kind: "break", id: id++ });
      pendingBreak = false;
    }
    emittedText = true;
    const wrapped = wrapLine(raw, width);
    wrapped.forEach((text, w) => {
      out.push({
        kind: "text",
        id: id++,
        sourceLine: idx + 1,
        continuation: w > 0,
        text,
      });
    });
  });

  return out;
}

/**
 * Stateful accumulator: assembles each pane's raw byte chunks into stripped
 * logical lines (the ANSI/control stripping + chunk-boundary line reassembly is
 * owned by `LineAssembler`), bounded by a per-pane cap. The reflow itself is the
 * pure `reflow` function above, which the store/view calls over `linesFor`.
 */
export class ReaderEngine {
  private readonly panes = new Map<number, PaneLines>();

  /** @param perPaneCap max stripped lines retained per pane (FIFO eviction). */
  constructor(private readonly perPaneCap: number) {}

  /**
   * Feed one raw pane byte chunk (Latin-1 decoded). Completed lines (those whose
   * terminating `\n` has arrived) are stripped and appended; a trailing partial
   * line stays buffered in the assembler until its newline lands.
   */
  pushBytes(paneId: number, latin1Chunk: string): void {
    const ps = this.paneFor(paneId);
    for (const line of ps.asm.push(latin1Chunk)) ps.lines.push(line);
    if (ps.lines.length > this.perPaneCap) {
      ps.lines.splice(0, ps.lines.length - this.perPaneCap);
    }
  }

  /** The stripped logical lines accumulated for a pane (empty if untapped). */
  linesFor(paneId: number): readonly string[] {
    return this.panes.get(paneId)?.lines ?? [];
  }

  /** Number of stripped lines retained for a pane. */
  lineCountFor(paneId: number): number {
    return this.panes.get(paneId)?.lines.length ?? 0;
  }

  /** Panes that have fed bytes, in first-seen order. */
  get tappedPaneIds(): readonly number[] {
    return [...this.panes.keys()];
  }

  /** Number of distinct panes tapped since the firehose opened. */
  get tappedPaneCount(): number {
    return this.panes.size;
  }

  /** Drop all accumulated lines and per-pane carry-over (e.g. on disconnect). */
  clear(): void {
    this.panes.clear();
  }

  private paneFor(paneId: number): PaneLines {
    let ps = this.panes.get(paneId);
    if (ps === undefined) {
      ps = { asm: new LineAssembler(), lines: [] };
      this.panes.set(paneId, ps);
    }
    return ps;
  }
}

interface PaneLines {
  readonly asm: LineAssembler;
  readonly lines: string[];
}
