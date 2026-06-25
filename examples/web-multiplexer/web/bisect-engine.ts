// examples/web-multiplexer/web/bisect-engine.ts
//
// The pure core of "bisect a TUI bug in a recorded session": git-bisect over a
// pane's recorded byte stream. You have a recording where something broke; you
// know the screen was fine at the start and broken at the end. Binary-search the
// byte offset at which it broke, then name the escape sequence that did it.
//
// THE AXIS IS THE BYTE OFFSET, NOT TIME. .9/.10 key reconstruction on recorded
// time (`tMs`), but one firehose chunk carries one timestamp, so time cannot
// address a point mid-chunk. "Find the offending escape SEQUENCE" needs
// resolution finer than a chunk, so the search runs over a position in
// `paneStreamBytes` — the pane's whole forward stream as one buffer. The
// reconstruction primitive is unchanged from .8/.10: the screen after `n` bytes
// is `emulate(seed ++ stream.slice(0, n))`. Only the prefix is sliced by byte
// instead of by time. [LAW:one-source-of-truth] the seed assembly is
// `scrollback-engine.seededPaint` (one definition of clear-then-seed-then-
// forward, shared with the time-keyed `momentBytes`); the cell grid is .8's
// owned `emulate` (xterm is lossy); the offending sequence is named by .4's
// `parseEscapes` (one ANSI tokenizer across the playground and the bisect).
//
// THE ORACLE IS A VALUE, NOT A BRANCH. The reducer `recordVerdict` narrows the
// search from one verdict ("is the bug present at the probe?"). It is blind to
// where that verdict came from: the interactive demo feeds a human's click; the
// unit tests feed `predicate(grid)`. Same engine, two oracles — the verdict's
// source never reaches the reducer. [LAW:dataflow-not-control-flow]
//
// [LAW:effects-at-boundaries] Zero IO, zero MobX, zero DOM. The capture-pane
//   seed and the firehose live in the store; this module is a deterministic
//   projection of the Timeline + verdicts it is handed, unit-tested against
//   synthetic seeds + recordings.

import {
  type AttributionGrid,
  type SourceChunk,
  emulate,
} from "./byte-attribution-engine.ts";
import {
  type PaneGeometry,
  paneStreamBytes,
} from "./session-recording-engine.ts";
import {
  type ScrollbackSnapshot,
  type Timeline,
  seededPaint,
} from "./scrollback-engine.ts";
import { type EscapeEvent, parseEscapes } from "./escape-parse-engine.ts";

// ---------------------------------------------------------------------------
// Reconstruction at a byte offset
// ---------------------------------------------------------------------------

/**
 * Reconstruct the pane's screen after the first `byteOffset` forward bytes have
 * landed on the seed, as an owned grid. `stream` is the pane's whole forward
 * buffer (`paneStreamBytes`), passed in so a bisect that probes it many times
 * concatenates it once. `byteOffset` is clamped to `[0, stream.length]`: 0 is
 * the seed alone (the known-good end), `stream.length` is the final screen (the
 * known-bad end). Same inputs → same grid.
 */
export function gridFromStream(
  snap: ScrollbackSnapshot,
  geometry: PaneGeometry,
  stream: Uint8Array,
  byteOffset: number,
): AttributionGrid {
  const n = Math.max(0, Math.min(stream.length, Math.round(byteOffset)));
  const bytes = seededPaint(snap, stream.subarray(0, n));
  // One synthetic chunk: bisect reads char/style/cursor, never provenance, so
  // the chunk's id/offset are immaterial — the grid is a pure screen state.
  const chunk: SourceChunk = { chunkId: 0, tMs: 0, baseOffset: 0, bytes };
  return emulate([chunk], geometry);
}

/** `gridFromStream` for a whole Timeline — concatenates the pane stream itself. */
export function gridAtOffset(
  tl: Timeline,
  byteOffset: number,
): AttributionGrid {
  const stream = paneStreamBytes(tl.recording, tl.paneId);
  return gridFromStream(tl.snapshot, tl.snapshot.geometry, stream, byteOffset);
}

// ---------------------------------------------------------------------------
// The bisect state machine
// ---------------------------------------------------------------------------

/** The verdict on one probe: is the bug present on the reconstructed screen? */
export type Verdict = "present" | "absent";

/**
 * A live binary search over byte offsets, exactly git-bisect's invariant made a
 * type: `lo` is the highest offset proven bug-ABSENT, `hi` the lowest proven
 * bug-PRESENT, and the culprit lies in `(lo, hi]`. [LAW:types-are-the-program]
 * the only constructor is `startBisect`, so `0 ≤ lo ≤ hi` holds by construction
 * and no callsite can mint a state with the ends crossed.
 */
export interface BisectState {
  readonly lo: number;
  readonly hi: number;
}

/**
 * Begin a bisect over a `streamLength`-byte forward stream: bug absent at offset
 * 0 (the seed alone), present at `streamLength` (the final screen) — the two
 * endpoints the user asserts by recording a session that broke. `streamLength`
 * is clamped to ≥ 0; a 0-length stream starts already-converged with no culprit
 * (there are no forward bytes to blame). [LAW:no-silent-failure]
 */
export function startBisect(streamLength: number): BisectState {
  const len = Math.max(0, Math.round(streamLength));
  return { lo: 0, hi: len };
}

/**
 * The search has narrowed to an adjacent pair (`hi - lo ≤ 1`) — there is no
 * offset strictly between the ends left to probe. A 1-gap pins the culprit byte;
 * a 0-gap is the degenerate empty stream.
 */
export function isConverged(state: BisectState): boolean {
  return state.hi - state.lo <= 1;
}

/**
 * The offset to reconstruct and judge next: the midpoint of the open interval
 * `(lo, hi)`. Defined only while unconverged; on a converged state it returns
 * `lo` (the fixpoint), but callers gate probing behind `!isConverged`.
 */
export function probeOffset(state: BisectState): number {
  return state.lo + Math.floor((state.hi - state.lo) / 2);
}

/**
 * Narrow the search from a verdict on `probeOffset(state)`: "absent" lifts the
 * good floor to the probe, "present" lowers the bad ceiling to it. Each step
 * halves the interval. On an already-converged state there is nothing to narrow,
 * so the state is its own fixpoint — `autoBisect`'s loop and the store's gated
 * controls never call it there, so this is the unreachable-by-construction
 * identity, not a swallowed verdict. [LAW:no-silent-failure]
 */
export function recordVerdict(
  state: BisectState,
  verdict: Verdict,
): BisectState {
  if (isConverged(state)) return state;
  const probe = probeOffset(state);
  return verdict === "absent"
    ? { lo: probe, hi: state.hi }
    : { lo: state.lo, hi: probe };
}

/**
 * The convergence: the offending byte sits at `byteOffset` — the last byte of
 * the good prefix is `goodOffset`, and adding the byte at `goodOffset` (the
 * forward stream is 0-based, so `stream[goodOffset]`) is what flipped the screen
 * to bad at `badOffset = goodOffset + 1`. Null until `isConverged` with a real
 * 1-byte gap (the empty-stream 0-gap has no byte to blame).
 */
export interface Culprit {
  readonly goodOffset: number;
  readonly badOffset: number;
  readonly byteOffset: number;
}

export function culprit(state: BisectState): Culprit | null {
  if (state.hi - state.lo !== 1) return null;
  return { goodOffset: state.lo, badOffset: state.hi, byteOffset: state.lo };
}

// ---------------------------------------------------------------------------
// Predicate-driven bisect — the deterministic test entry
// ---------------------------------------------------------------------------

/** One step of an automated bisect: the offset probed and the verdict it drew. */
export interface BisectStep {
  readonly offset: number;
  readonly verdict: Verdict;
}

/** A completed automated bisect: the convergence plus every probe it visited. */
export interface AutoBisectResult {
  readonly culprit: Culprit | null;
  readonly steps: readonly BisectStep[];
}

/**
 * Run a bisect to completion using `predicate` as the oracle — `predicate(grid)`
 * answers "is the bug present on this reconstructed screen?". This is the same
 * reducer the interactive demo drives, with the human replaced by a pure
 * function, so it is fully deterministic: the prime unit-test entry.
 *
 * Binary search is exact when the predicate is MONOTONIC over the stream (once
 * the bug appears it stays — git-bisect's own assumption). For a non-monotonic
 * predicate it still returns a valid adjacent (absent, present) boundary where
 * the predicate flips, just not necessarily the only one. [LAW:no-silent-failure]
 * the result is honest about what binary search can promise; it never pretends a
 * non-monotonic stream has a unique transition.
 */
export function autoBisect(
  tl: Timeline,
  predicate: (grid: AttributionGrid) => boolean,
): AutoBisectResult {
  const stream = paneStreamBytes(tl.recording, tl.paneId);
  const { snapshot } = tl;
  const geometry = snapshot.geometry;
  const steps: BisectStep[] = [];
  let state = startBisect(stream.length);
  while (!isConverged(state)) {
    const offset = probeOffset(state);
    const present = predicate(
      gridFromStream(snapshot, geometry, stream, offset),
    );
    const verdict: Verdict = present ? "present" : "absent";
    steps.push({ offset, verdict });
    state = recordVerdict(state, verdict);
  }
  return { culprit: culprit(state), steps };
}

// ---------------------------------------------------------------------------
// Naming the offending sequence
// ---------------------------------------------------------------------------

/** The bytes encompassing a culprit, and the parsed event they form. */
export interface OffendingSequence {
  /** The tokenized event the culprit byte falls in (CSI, OSC, text run, …). */
  readonly event: EscapeEvent;
  /** Byte offset of the sequence's first byte in the stream. */
  readonly start: number;
  /** Byte offset one past the sequence's last byte (half-open). */
  readonly end: number;
  /** The raw sequence bytes — `stream.slice(start, end)`. */
  readonly raw: Uint8Array;
}

/** The byte span an `EscapeEvent` occupies; a bare C0 control byte is 1 byte. */
function eventByteLength(e: EscapeEvent): number {
  return "byteLength" in e ? e.byteLength : 1;
}

/**
 * Name the escape sequence (or text run / control byte) that the culprit byte
 * belongs to, by tokenizing the stream with .4's `parseEscapes` and walking the
 * events until one spans `byteOffset`. Returns the whole sequence — not just the
 * one flipping byte — because "the offending escape sequence" is the unit a human
 * debugs (`ESC [ 2 J`, not its trailing `J`). Null when `byteOffset` lands
 * outside the stream. [LAW:one-source-of-truth] reuses the single ANSI tokenizer
 * rather than re-scanning for sequence boundaries here.
 */
export function culpritSequence(
  stream: Uint8Array,
  byteOffset: number,
): OffendingSequence | null {
  if (byteOffset < 0 || byteOffset >= stream.length) return null;
  let offset = 0;
  for (const event of parseEscapes(stream)) {
    const len = eventByteLength(event);
    if (byteOffset < offset + len) {
      const end = offset + len;
      return { event, start: offset, end, raw: stream.slice(offset, end) };
    }
    offset += len;
  }
  return null;
}
