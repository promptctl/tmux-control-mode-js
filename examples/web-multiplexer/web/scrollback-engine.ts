// examples/web-multiplexer/web/scrollback-engine.ts
//
// The pure core of the "scrollback time machine": the math that turns a single
// scrub position into "the bytes to paint a fresh terminal so it shows the pane
// at that point on a unified history→time axis". It binds two sources:
//
//   - a SEED — a `capture-pane -e -p -S - -E -` snapshot taken the instant
//     recording began: the pane's entire scrollback PLUS its visible screen,
//     re-encoded by tmux as SGR-bearing text rows. This is everything that
//     happened BEFORE the recording — history the browser never attached to.
//   - the forward `Recording` (the .5 firehose log) — everything AFTER.
//
// Together they form one timeline you scrub bidirectionally: drag left and you
// scroll UP through captured scrollback rows (spatial); drag right and you play
// FORWARD through recorded time (temporal). The boundary between them is t=0 —
// the moment Record was pressed.
//
// WHY A SEED AT ALL (the .5 gap this closes): .5 replays only the forward
// firehose into a freshly-cleared terminal. The firehose holds only bytes
// written AFTER Record, so a pane that already had content on screen reconstructs
// WRONG — the pre-existing screen is simply absent. Seeding fixes both directions
// at once: forward reconstruction becomes `clear ++ seed ++ bytesUpTo(t)` (the
// real screen, then the delta), and backward scrub has real history to walk into.
//
// [LAW:effects-at-boundaries] Zero IO, zero MobX, zero DOM. The `capture-pane`
//   call, the firehose, the wall clock and the terminal all live in the
//   store/view; this module is a deterministic projection of the data they hand
//   it, exhaustively unit-tested against synthetic snapshots.
// [LAW:one-way-deps] Depends one-way on `session-recording-engine` — it REUSES
//   `Recording` / `bytesUpTo`, never re-deriving the forward-stream math.
//   [LAW:carrying-cost] the .5 model stays the single authority for "bytes up to
//   a moment"; .9 adds only the seed and the unified position mapping on top.

import {
  type PaneGeometry,
  type Recording,
  bytesUpTo,
} from "./session-recording-engine.ts";

/**
 * A frozen `capture-pane -e` snapshot of one pane at record-start: every
 * captured row top→bottom as raw bytes (SGR escapes intact, no trailing CR/LF —
 * the control-mode protocol frames each row as its own reply line), plus the
 * geometry the rows were laid out on. The bottom `geometry.rows` lines are the
 * pane's visible screen at t=0; everything above them is scrollback history.
 */
export interface ScrollbackSnapshot {
  readonly paneId: number;
  readonly geometry: PaneGeometry;
  readonly lines: readonly Uint8Array[];
}

/**
 * A point on the unified timeline, as a discriminated value rather than a signed
 * scalar: `history` walks scrollback rows above the live screen (`topLine` =
 * index of the window's first row, 0 = top of history); `live` advances recorded
 * time (`tMs` ≥ 0). [LAW:types-are-the-program] the regime is a discriminator,
 * so no callsite ever inspects the sign of a magic number to decide which world
 * it is in — illegal mixtures (a negative `tMs`, a "history at +3s") cannot be
 * represented.
 */
export type Moment =
  | { readonly kind: "history"; readonly topLine: number }
  | { readonly kind: "live"; readonly tMs: number };

/**
 * Everything one pane's time machine needs to render any moment: its seed
 * snapshot, the shared forward recording, and which pane to read from it.
 * `durationMs` mirrors `recording.durationMs` for convenience.
 */
export interface Timeline {
  readonly snapshot: ScrollbackSnapshot;
  readonly recording: Recording;
  readonly paneId: number;
  readonly durationMs: number;
}

/** Home the cursor, clear the screen, and reset the pen before painting a moment. */
const CLEAR = new TextEncoder().encode("\x1b[0m\x1b[H\x1b[2J");
/** Row separator fed to the sink — CR returns the cursor to column 0, LF drops a row. */
const CRLF = new TextEncoder().encode("\r\n");

/**
 * Reconstruct each byte of a latin1 byte-faithful string (the shape of
 * `CommandResponse.output` — one char per source byte, codepoint = byte value).
 * `capture-pane -e` ESC sequences and raw UTF-8 multibyte glyphs survive intact.
 */
function latin1ToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

/**
 * Freeze a `capture-pane` reply (the lines between `%begin`/`%end`) into a
 * snapshot. Pure: same reply + geometry → same snapshot.
 */
export function parseCaptureReply(
  replyLines: readonly string[],
  geometry: PaneGeometry,
  paneId: number,
): ScrollbackSnapshot {
  return {
    paneId,
    geometry,
    lines: replyLines.map(latin1ToBytes),
  };
}

/**
 * How many scrollback rows sit ABOVE the visible screen — the depth you can
 * scrub backward into. Zero when the capture is no taller than the screen (the
 * pane had no history yet). [LAW:no-silent-failure] never negative: a short
 * capture is honest "no history", not a wrapped-around count.
 */
export function historyDepth(snap: ScrollbackSnapshot): number {
  return Math.max(0, snap.lines.length - snap.geometry.rows);
}

/**
 * Where the history→live boundary (t=0) sits on the `[0,1]` scrub axis, so the UI
 * can mark it. History and the recording split the bar evenly when both exist;
 * the whole bar goes to whichever is the only one present. Degenerate "neither"
 * (empty capture, empty recording) collapses to 0 — the bar is then a single
 * live-at-zero point.
 */
export function splitFraction(tl: Timeline): number {
  const hasHistory = historyDepth(tl.snapshot) > 0;
  const hasLive = tl.durationMs > 0;
  if (hasHistory && hasLive) return 0.5;
  if (hasHistory) return 1;
  return 0;
}

/** Map a scrub fraction `[0,1]` onto the timeline's discriminated `Moment`. */
export function resolveMoment(frac: number, tl: Timeline): Moment {
  const f = Math.max(0, Math.min(1, frac));
  const split = splitFraction(tl);
  const depth = historyDepth(tl.snapshot);
  if (split > 0 && f <= split) {
    const localFrac = split === 0 ? 0 : f / split;
    return { kind: "history", topLine: Math.round(localFrac * depth) };
  }
  const span = 1 - split;
  const localFrac = span <= 0 ? 1 : (f - split) / span;
  return { kind: "live", tMs: localFrac * tl.durationMs };
}

/** Join byte runs in order, interleaving `sep` (no trailing separator). */
function joinWith(parts: readonly Uint8Array[], sep: Uint8Array): Uint8Array {
  if (parts.length === 0) return new Uint8Array(0);
  let total = 0;
  for (const p of parts) total += p.length;
  total += sep.length * (parts.length - 1);
  const out = new Uint8Array(total);
  let off = 0;
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) {
      out.set(sep, off);
      off += sep.length;
    }
    out.set(parts[i], off);
    off += parts[i].length;
  }
  return out;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  return joinWith(parts, new Uint8Array(0));
}

/**
 * The pane's visible screen at t=0: the bottom `rows` captured lines, rejoined
 * with CR/LF. This is the prefix that makes forward reconstruction faithful —
 * the real screen the program was looking at when recording began, before any
 * recorded byte lands on top of it. No trailing CR/LF (that would scroll the
 * screen up a row).
 */
export function seedBytes(snap: ScrollbackSnapshot): Uint8Array {
  const start = Math.max(0, snap.lines.length - snap.geometry.rows);
  return joinWith(snap.lines.slice(start), CRLF);
}

/**
 * The bytes to paint a FRESHLY-CLEARED terminal so it shows the pane's real
 * screen after `forward` bytes have landed on top of the seed: clear the screen,
 * lay down the seed screen (the program's view at t=0), then replay `forward`.
 * The single definition of the seeded reconstruction assembly — including the
 * `CLEAR` magic bytes — so every reconstruction that builds on a seed shares one
 * source rather than re-stating the clear sequence. [LAW:one-source-of-truth]
 *
 * `forward` is the prefix that has landed: `bytesUpTo(t)` for a time-keyed moment
 * (the live branch below), or `stream.slice(0, n)` for a byte-keyed offset (the
 * .11 bisect reconstruction). The keying lives in the caller; the assembly here
 * is identical either way.
 */
export function seededPaint(
  snap: ScrollbackSnapshot,
  forward: Uint8Array,
): Uint8Array {
  return concat([CLEAR, seedBytes(snap), forward]);
}

/**
 * The bytes to feed a FRESHLY-CLEARED terminal so it shows `moment`. The single
 * source of "how a moment looks" — both regimes reduce to clear-then-paint, so
 * the view never branches on regime to decide what to draw, only the engine
 * does, once. [LAW:dataflow-not-control-flow]
 *
 * - `history`: clear, then the window of `rows` captured rows starting at
 *   `topLine` (the bottom window equals the live screen — the regimes meet
 *   seamlessly at t=0 by construction). [LAW:one-source-of-truth]
 * - `live`: the seeded reconstruction with the forward delta `bytesUpTo(t)`.
 *
 * KNOWN LIMITATION: `capture-pane` emits one logical row per line; a row that
 * was exactly `cols` wide and soft-wrapped is rejoined here with an explicit
 * CR/LF, which the sink double-counts as a wrap + a newline. Faithful for the
 * overwhelmingly common sub-width row; a showcase-acceptable seam for full-width
 * wrapped scrollback.
 */
export function momentBytes(moment: Moment, tl: Timeline): Uint8Array {
  if (moment.kind === "history") {
    const { lines, geometry } = tl.snapshot;
    const window = lines.slice(moment.topLine, moment.topLine + geometry.rows);
    return concat([CLEAR, joinWith(window, CRLF)]);
  }
  return seededPaint(
    tl.snapshot,
    bytesUpTo(tl.recording, tl.paneId, moment.tMs),
  );
}
