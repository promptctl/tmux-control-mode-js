// examples/web-multiplexer/web/sync-engine.ts
//
// The pure core of "synchronized scrollback across linked panes" (.13): scrub ONE
// shared cursor and watch N linked panes reconstruct their screen at the SAME
// recorded instant. The whole demo turns on the coordinate it synchronizes on.
//
// A `Recording` (.5) stores every pane's chunks keyed by paneId on ONE shared
// wall clock (`tMs` since Record — one control client recorded every pane in
// every session). So the cross-pane-meaningful coordinate is recorded TIME, not
// the per-pane `[0,1]` scrub fraction the .9 time machine uses: each pane has a
// different scrollback depth, so the same fraction is a different instant in each
// pane. Sync therefore keys on `tMs`, and only `tMs` — scrollback rows are
// UNTIMESTAMPED, so "all panes at the same scrollback row" is meaningless. This
// module pins the sync cursor to the LIVE regime so that illegal state is
// unrepresentable. [LAW:types-are-the-program]
//
// WHY THIS COULD NOT EXIST WITHOUT CONTROL MODE: one client taps every pane's
// firehose across every session onto one clock, so "what did all these panes look
// like at t=4.2s?" is answerable from a single recording. With one PTY per pane
// you would have N unsynchronized clocks to reconcile.
//
// [LAW:effects-at-boundaries] Zero IO, zero MobX, zero DOM — a deterministic
//   projection of the recording + seeds it is handed, exhaustively unit-tested.
// [LAW:one-way-deps] [LAW:carrying-cost] REUSES `.9`'s `momentBytes` and `.5`'s
//   `bytesBetween` / `activityHistogram`; it never re-derives the seed assembly or
//   the forward-stream math. The .13 layer adds only the shared-cursor mapping and
//   the N-pane projection on top of the single existing authority.

import {
  type Recording,
  activityHistogram,
  bytesBetween,
} from "./session-recording-engine.ts";
import {
  type ScrollbackSnapshot,
  type Timeline,
  momentBytes,
} from "./scrollback-engine.ts";

/**
 * A synchronized group: ONE shared recording, the per-pane seed snapshots taken
 * at record-start, and which panes are linked into lockstep playback. Every
 * linked pane reconstructs at the same shared `tMs`. The shared duration is
 * DERIVED from the recording (`groupDuration`), never stored as a second
 * authority that could drift. [LAW:one-source-of-truth]
 */
export interface SyncGroup {
  readonly recording: Recording;
  readonly snapshots: ReadonlyMap<number, ScrollbackSnapshot>;
  readonly linked: ReadonlySet<number>;
}

/** The recording's shared span — the right edge of the synchronized time axis. */
export function groupDuration(group: SyncGroup): number {
  return group.recording.durationMs;
}

/**
 * The single place a `Timeline` is assembled from a pane and its (known-present)
 * seed. Both the boundary lookup (`timelineFor`) and the bulk projection
 * (`linkedTimelines`) route through here, so the Timeline shape is stated once.
 * [LAW:single-enforcer] [LAW:one-source-of-truth]
 */
function buildTimeline(
  group: SyncGroup,
  paneId: number,
  snapshot: ScrollbackSnapshot,
): Timeline {
  return {
    snapshot,
    recording: group.recording,
    paneId,
    durationMs: group.recording.durationMs,
  };
}

/**
 * Build one pane's reconstruction `Timeline`. Null when the pane has no seed: a
 * pane cannot be faithfully reconstructed without its t=0 screen (the .5 gap).
 * This is GENUINE optionality at the boundary — a caller may ask for an arbitrary
 * paneId — encoded as a discriminated `Timeline | null` for exhaustive handling,
 * not a defensive skip. [LAW:no-silent-failure]
 */
export function timelineFor(group: SyncGroup, paneId: number): Timeline | null {
  const snapshot = group.snapshots.get(paneId);
  if (snapshot === undefined) return null;
  return buildTimeline(group, paneId, snapshot);
}

/**
 * Every pane eligible to link: the seeded panes, in seed-capture order. A seed is
 * the eligibility test (it is what reconstruction needs); a seeded pane that
 * emitted no forward bytes is still eligible — it simply shows its static seed at
 * every instant, an honest "this pane was quiet" view, not an error.
 */
export function linkablePanes(group: SyncGroup): readonly number[] {
  return [...group.snapshots.keys()];
}

/**
 * The linked, renderable timelines in seed order — the surfaces the view mounts.
 * Iterates the seed map's ENTRIES, so each snapshot is in hand and every built
 * timeline is non-null by construction (no null guard, no impossible-state skip).
 * An id in the linked set that has no seed is excluded structurally: it is never
 * an entry here, so it is never considered. [LAW:dataflow-not-control-flow]
 */
export function linkedTimelines(group: SyncGroup): readonly Timeline[] {
  const out: Timeline[] = [];
  for (const [paneId, snapshot] of group.snapshots) {
    if (group.linked.has(paneId)) out.push(buildTimeline(group, paneId, snapshot));
  }
  return out;
}

/** Map a scrub fraction `[0,1]` onto the shared recorded instant `[0, durationMs]`. */
export function cursorMs(frac: number, durationMs: number): number {
  const f = Math.max(0, Math.min(1, frac));
  return f * Math.max(0, durationMs);
}

/**
 * Inverse of `cursorMs`: where a recorded instant sits on the `[0,1]` axis. A
 * zero-duration recording collapses to 0 (the bar is a single instant) rather
 * than dividing by zero. [LAW:no-silent-failure]
 */
export function cursorFrac(tMs: number, durationMs: number): number {
  if (durationMs <= 0) return 0;
  return Math.max(0, Math.min(1, tMs / durationMs));
}

/**
 * One linked pane's paint bytes at the shared instant — the seeded reconstruction
 * `clear ++ seed ++ bytesUpTo(tMs)`. THE single place the sync axis is pinned to
 * the live regime: the moment is always `{kind:"live"}`, so no callsite can ask a
 * synchronized cursor to address untimestamped scrollback. [LAW:single-enforcer]
 * Reuses `.9`'s `momentBytes`; never re-states the seed assembly.
 * [LAW:one-source-of-truth]
 */
export function paintAt(tl: Timeline, tMs: number): Uint8Array {
  return momentBytes({ kind: "live", tMs }, tl);
}

/**
 * The forward byte delta for one pane between two shared instants: what to write
 * to a terminal already showing `fromMs` to advance it to `toMs` without a full
 * re-seed. Reuses `.5`'s `bytesBetween` and its
 * `paintAt(from) ++ forwardDelta(from,to) === paintAt(to)` invariant. Only valid
 * for `fromMs <= toMs`; a backward move must re-`paintAt` from the seed.
 */
export function forwardDelta(
  tl: Timeline,
  fromMs: number,
  toMs: number,
): Uint8Array {
  return bytesBetween(tl.recording, tl.paneId, fromMs, toMs);
}

/** One pane's reconstruction within a synchronized frame. */
export interface SyncPanePaint {
  readonly paneId: number;
  readonly bytes: Uint8Array;
}

/**
 * THE synchronized frame: every linked pane's paint at ONE shared instant — the
 * value the demo is named for ("what did all these panes look like at the same
 * moment?"). The synchronization guarantee is checkable here: every entry shares
 * the one `tMs`, and each entry's bytes equal that pane's own `paintAt(tMs)`. The
 * view renders the initial frame from this and advances each surface with
 * `forwardDelta`; the engine is the single source of both. [LAW:one-source-of-truth]
 */
export function syncFrame(
  group: SyncGroup,
  tMs: number,
): readonly SyncPanePaint[] {
  return linkedTimelines(group).map((tl) => ({
    paneId: tl.paneId,
    bytes: paintAt(tl, tMs),
  }));
}

/**
 * Merged activity across all linked panes: total bytes per time bin over
 * `[0, durationMs]`. Powers the shared scrub bar's sparkline — "when were ANY of
 * the linked panes busy". Sums `.5`'s per-pane `activityHistogram`, so a flat bar
 * is real captured silence, not an absent projection, and an empty `bucketCount`
 * yields an empty array (distinguishable from captured quiet). [LAW:no-silent-failure]
 */
export function linkedActivity(
  group: SyncGroup,
  bucketCount: number,
): readonly number[] {
  if (bucketCount <= 0) return [];
  const bins = new Array<number>(bucketCount).fill(0);
  for (const paneId of group.linked) {
    const h = activityHistogram(group.recording, paneId, bucketCount);
    for (let i = 0; i < h.length; i++) bins[i] += h[i];
  }
  return bins;
}
