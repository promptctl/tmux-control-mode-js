// examples/web-multiplexer/web/recording-capture.ts
//
// The shared capture substrate for the seed+record showcase demos — the .9
// scrollback time machine and the .10 moment diff. Both freeze a pane's history
// the same way: at the instant Record is pressed they seed every pane with a
// `capture-pane -e -p -S - -E -` snapshot (its full scrollback PLUS visible
// screen, re-encoded by tmux as SGR-bearing rows), then record the forward
// firehose. This module owns the verbatim-identical half of that: how panes are
// listed, how one pane is seeded, the size/pane policy caps, and the small
// helpers both stores fold over.
//
// [LAW:one-source-of-truth] one definition of "list the panes", "seed a pane",
//   and "where the caps live" — the two stores import these rather than each
//   re-stating the same parsing rule and the same constants (which would drift).
// [LAW:decomposition] capture is ONE concern (this module); presentation —
//   scrubbing a single playhead vs diffing two — is the store's. The firehose
//   buffering + phase state machine deliberately stays in each store, because the
//   two demos genuinely diverge there (a playback clock vs a static diff); only
//   the identical pieces are lifted, not a forced base class over different
//   shapes. [LAW:no-mode-explosion]
// [LAW:effects-at-boundaries] the only IO here is `captureSeeds`, and it takes
//   the bridge as a parameter; everything else is pure.

import type { TmuxBridge } from "./bridge.ts";
import type { PaneGeometry } from "./session-recording-engine.ts";
import {
  parseCaptureReply,
  type ScrollbackSnapshot,
} from "./scrollback-engine.ts";

/**
 * Soft cap on a single recording's captured forward bytes — a showcase clip is
 * meant to be scrubbed, not an unbounded log. Past this the owning store
 * auto-stops and surfaces it. [LAW:no-silent-failure]
 */
export const MAX_RECORDING_BYTES = 16 * 1024 * 1024;

/**
 * Cap on how many panes get seeded at record-start. Seeding is an O(panes ×
 * scrollback) burst of `capture-pane` calls; the truncation is reported, never
 * silent. [LAW:no-silent-failure]
 */
export const MAX_SEEDED_PANES = 24;

/** One pane as reported by `list-panes -a`: id + the geometry to seed it on. */
export interface PaneInfo {
  readonly paneId: number;
  readonly geometry: PaneGeometry;
}

/** Monotonic wall clock for capture + playback timing. */
export function now(): number {
  return performance.now();
}

/** First key of a map in insertion order, or null when empty. */
export function firstKey(m: ReadonlyMap<number, unknown>): number | null {
  for (const k of m.keys()) return k;
  return null;
}

/** Parse `%<id> <cols> <rows>` rows from `list-panes -a -F`. */
export function parsePaneList(lines: readonly string[]): PaneInfo[] {
  const out: PaneInfo[] = [];
  for (const line of lines) {
    const m = /^%?(\d+)\s+(\d+)\s+(\d+)/.exec(line.trim());
    if (m === null) continue;
    const paneId = Number(m[1]);
    const cols = Number(m[2]);
    const rows = Number(m[3]);
    if (cols > 0 && rows > 0) out.push({ paneId, geometry: { cols, rows } });
  }
  return out;
}

/**
 * The outcome of one seed pass: the per-pane snapshots, and whether the pane cap
 * clipped the set. `truncated` is returned (not set as a side effect) so each
 * store can surface it through its own observable. [LAW:no-silent-failure]
 */
export interface SeedCapture {
  readonly seeds: Map<number, ScrollbackSnapshot>;
  readonly truncated: boolean;
}

/**
 * Seed every pane in parallel at record-start: `list-panes` to enumerate, then a
 * `capture-pane -e -p -S - -E -` per pane (capped at `MAX_SEEDED_PANES`).
 * Best-effort per pane — a pane that vanishes or errors is skipped (logged under
 * `label`, never swallowed into a wrong seed). [LAW:no-silent-failure] A failed
 * `list-panes` returns an empty, honestly-untruncated capture rather than a
 * partial lie.
 */
export async function captureSeeds(
  bridge: TmuxBridge,
  label: string,
): Promise<SeedCapture> {
  const seeds = new Map<number, ScrollbackSnapshot>();
  let panes: PaneInfo[];
  try {
    const list = await bridge.execute(
      "list-panes -a -F '#{pane_id} #{pane_width} #{pane_height}'",
    );
    panes = parsePaneList(list.output);
  } catch (err: unknown) {
    console.warn(`${label}: list-panes failed`, err);
    return { seeds, truncated: false };
  }
  const truncated = panes.length > MAX_SEEDED_PANES;
  if (truncated) panes = panes.slice(0, MAX_SEEDED_PANES);
  await Promise.all(
    panes.map(async (p) => {
      try {
        const r = await bridge.execute(
          `capture-pane -e -p -S - -E - -t %${p.paneId}`,
        );
        seeds.set(p.paneId, parseCaptureReply(r.output, p.geometry, p.paneId));
      } catch (err: unknown) {
        console.warn(`${label}: capture-pane %${p.paneId} failed`, err);
      }
    }),
  );
  return { seeds, truncated };
}
