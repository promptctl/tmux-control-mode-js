// examples/web-multiplexer/web/moment-diff-engine.ts
//
// The pure core of the "diff two moments in pane history" demo: take a pane's
// recorded timeline and two points in recorded time, reconstruct the screen at
// each, and report cell-by-cell + cursor what changed between them. Useful for
// debugging a TUI — "what did this redraw actually touch?".
//
// It is residue of two prior layers, not a re-derivation of either:
//   - the faithful screen at moment t for a REAL pane is emulate(seed ++
//     bytesUpTo(t)), NOT emulate(bytesUpTo(t)) — the firehose holds only bytes
//     written AFTER record-start, so a pane with pre-existing content
//     reconstructs WRONG without the seed (the .5 gap the .9 seed closes).
//     `scrollback-engine.momentBytes({kind:"live", tMs}, tl)` ALREADY produces
//     exactly `clear ++ seed ++ bytesUpTo(t)`, so this module asks it for the
//     bytes rather than reassembling them. [LAW:one-source-of-truth] one
//     authority for "how a moment looks"; .9 and .10 reconstruct identically.
//   - per-cell access (char/fg/bg/cursor) requires an OWNED VT emulator: xterm is
//     a lossy projection (bytes in, grid out, the mapping discarded). So this
//     feeds those bytes into .8's `emulate()` to get an `AttributionGrid` and
//     diffs the grids. [LAW:single-enforcer] one VT emulator across .8/.10.
//
// WHY SEED BOTH SIDES WITH THE SAME SEED: with one shared seed the diff is
// PURELY the forward delta between the two times — exactly what .10 wants to
// show. Seed only one side (the .5 mistake) and every pre-existing cell reads as
// "added", burying the real change. [LAW:no-silent-failure]
//
// [LAW:effects-at-boundaries] Zero IO, zero MobX, zero DOM. The capture-pane
//   seed, the firehose, and the wall clock all live in the store; this module is
//   a deterministic projection of the Timeline it is handed, exhaustively
//   unit-tested against synthetic seeds + recordings.

import {
  type AttributedCell,
  type AttributionGrid,
  type SourceChunk,
  emulate,
} from "./byte-attribution-engine.ts";
import { type Timeline, momentBytes } from "./scrollback-engine.ts";

/**
 * What happened to one screen cell between the two moments, as a discriminated
 * value rather than a status flag + nullable before/after the view must
 * re-validate. [LAW:types-are-the-program] each variant carries exactly the
 * cells it has, so the renderer reads `after` on `added`/`changed` and `before`
 * on `removed` with no possibility of a null where a cell is promised.
 *
 * The accept/reject table over (before, after) — written before the predicate so
 * every input shape has exactly one verdict [enumeration-gap]:
 *   (null,   null)              → same    (blank both moments)
 *   (null,   cell)              → added   (blank → written)
 *   (cell,   null)              → removed (written → erased/blank)
 *   (a, b) where appearsEqual   → same    (written, unchanged appearance)
 *   (a, b) where !appearsEqual  → changed (written, different appearance)
 */
export type CellChange =
  | { readonly kind: "same"; readonly cell: AttributedCell | null }
  | { readonly kind: "added"; readonly after: AttributedCell }
  | { readonly kind: "removed"; readonly before: AttributedCell }
  | {
      readonly kind: "changed";
      readonly before: AttributedCell;
      readonly after: AttributedCell;
    };

/** Cursor position at each moment, plus whether it moved. */
export interface CursorDiff {
  readonly before: { readonly row: number; readonly col: number };
  readonly after: { readonly row: number; readonly col: number };
  readonly moved: boolean;
}

/** How many cells fall in each change bucket — the at-a-glance headline. */
export interface DiffSummary {
  readonly same: number;
  readonly added: number;
  readonly removed: number;
  readonly changed: number;
}

/**
 * The full diff of two moments at one geometry: a `CellChange` per screen cell
 * (row-major, length `rows*cols`), the cursor move, and the bucket counts. The
 * grids are the same size by construction — both reconstructed at the same
 * snapshot geometry — so there is no size-mismatch case to represent.
 */
export interface MomentDiff {
  readonly cols: number;
  readonly rows: number;
  readonly cells: readonly CellChange[];
  readonly cursor: CursorDiff;
  readonly summary: DiffSummary;
}

/**
 * Two cells have the same APPEARANCE — the only equality a visual diff cares
 * about. Deliberately excludes provenance (chunkId/tMs/byteOffset/streamOffset):
 * two distinct moments are written by different bytes at different times, so a
 * provenance-sensitive equality would mark every written cell "changed" and the
 * diff would be noise. [FRAMING:representation] the diff represents what the
 * screen LOOKS like, not which byte produced it.
 */
function appearsEqual(a: AttributedCell, b: AttributedCell): boolean {
  return (
    a.char === b.char && a.fg === b.fg && a.bg === b.bg && a.bold === b.bold
  );
}

/** Classify one cell position. The accept/reject table from `CellChange`, once. */
export function cellChange(
  before: AttributedCell | null,
  after: AttributedCell | null,
): CellChange {
  // Guards ordered so each branch narrows the operand it returns — no cast.
  if (before === null) {
    return after === null
      ? { kind: "same", cell: null }
      : { kind: "added", after };
  }
  if (after === null) return { kind: "removed", before };
  if (appearsEqual(before, after)) return { kind: "same", cell: after };
  return { kind: "changed", before, after };
}

/**
 * Reconstruct the pane's screen at recorded time `tMs` as an owned grid: the
 * bytes are `clear ++ seed ++ bytesUpTo(tMs)` (via .9's `momentBytes`), folded
 * by .8's emulator at the snapshot geometry. The grid carries per-cell style and
 * the cursor — everything the diff compares. Same Timeline + same `tMs` → same
 * grid, every time.
 */
export function gridAtMoment(tl: Timeline, tMs: number): AttributionGrid {
  const bytes = momentBytes({ kind: "live", tMs }, tl);
  // One synthetic chunk: the diff reads char/style/cursor, not provenance, so the
  // chunk's id/offset are immaterial here — `cellChange` ignores them.
  const chunk: SourceChunk = { chunkId: 0, tMs, baseOffset: 0, bytes };
  return emulate([chunk], {
    cols: tl.snapshot.geometry.cols,
    rows: tl.snapshot.geometry.rows,
  });
}

/**
 * Diff the pane's screen at `beforeMs` against `afterMs`. Both moments are
 * reconstructed from the SAME seed, so the result is purely the forward delta
 * between the two times. [LAW:dataflow-not-control-flow] one fold over the cell
 * array classifies every position the same way; the regime lives in the
 * `CellChange` value, not in branches the view must mirror.
 */
export function diffMoments(
  tl: Timeline,
  beforeMs: number,
  afterMs: number,
): MomentDiff {
  const before = gridAtMoment(tl, beforeMs);
  const after = gridAtMoment(tl, afterMs);
  const { cols, rows } = before;
  const cells: CellChange[] = [];
  const summary = { same: 0, added: 0, removed: 0, changed: 0 };
  for (let i = 0; i < cols * rows; i++) {
    const change = cellChange(before.cells[i], after.cells[i]);
    cells.push(change);
    summary[change.kind] += 1;
  }
  const cursor: CursorDiff = {
    before: { row: before.cursorRow, col: before.cursorCol },
    after: { row: after.cursorRow, col: after.cursorCol },
    moved:
      before.cursorRow !== after.cursorRow ||
      before.cursorCol !== after.cursorCol,
  };
  return { cols, rows, cells, cursor, summary };
}
