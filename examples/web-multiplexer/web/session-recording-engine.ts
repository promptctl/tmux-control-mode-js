// examples/web-multiplexer/web/session-recording-engine.ts
//
// The pure core of the record/replay demo: an immutable, timestamped byte log
// of one capture session, plus the reconstruction math that turns a scrub
// position into "the bytes to feed a terminal to reach that moment". Zero IO,
// zero MobX, zero DOM — every function here is a deterministic projection of
// its arguments, so the whole module is unit-testable against synthetic chunks.
//
// This is the RECORDING INFRASTRUCTURE that the downstream history demos build
// on: scrollback time machine (.9), diff-two-moments (.10), bisect-a-TUI-bug
// (.11) are all `bytesUpTo` against a shared `Recording` — .10 renders two
// reconstructions, .11 binary-searches `toMs`. Keep this model honest and
// general so those reduce to calls, not re-derivations. [LAW:carrying-cost]
//
// [LAW:effects-at-boundaries] The wall clock that stamps `tMs`, the firehose
//   that supplies bytes, and the terminal that renders them all live in the
//   store/view. This module only computes over the data they hand it.
// [FRAMING:representation] A recording IS its bytes — they stay `Uint8Array`
//   end to end, never round-tripped through a lossy Latin-1 string. The model
//   is exactly as expressive as "an ordered log of (pane, time, bytes)".

/** A pane's character grid geometry, captured once so replay can size faithfully. */
export interface PaneGeometry {
  readonly cols: number;
  readonly rows: number;
}

/**
 * One captured run of bytes from one pane at a relative offset into the
 * recording. `tMs` is milliseconds since the recording began (monotonic, ≥0);
 * `bytes` are the raw firehose bytes, owned by the recording (the producer's
 * buffer is copied at capture so the log is immutable).
 */
export interface RecordedChunk {
  readonly paneId: number;
  readonly tMs: number;
  readonly bytes: Uint8Array;
}

/** Per-pane aggregate + geometry, derived once at `buildRecording`. */
export interface RecordedPane {
  readonly paneId: number;
  readonly byteCount: number;
  readonly chunkCount: number;
  /** Geometry captured at first sighting; null when the query never resolved. */
  readonly geometry: PaneGeometry | null;
}

/**
 * The frozen artifact of one capture session: every chunk in capture order,
 * the total span, and the distinct panes seen. Immutable — produced by
 * `buildRecording`, never mutated after.
 */
export interface Recording {
  readonly chunks: readonly RecordedChunk[];
  /** `tMs` of the last byte (0 for an empty recording). */
  readonly durationMs: number;
  /** Distinct panes, in first-appearance order, with byte/chunk totals. */
  readonly panes: readonly RecordedPane[];
}

/** The empty recording — the honest "nothing captured yet" value, not a null. */
export const EMPTY_RECORDING: Recording = {
  chunks: [],
  durationMs: 0,
  panes: [],
};

/**
 * Freeze a capture buffer into an immutable `Recording`. `chunks` arrive in
 * monotonic `tMs` order (one wall clock stamps them); `geometry` carries the
 * size queried per pane during capture. Pure: same inputs → same recording.
 *
 * [LAW:one-source-of-truth] The per-pane aggregates and duration are DERIVED
 *   here from the chunk log, never tracked as a second authority that could
 *   drift from it.
 */
export function buildRecording(
  chunks: readonly RecordedChunk[],
  geometry: ReadonlyMap<number, PaneGeometry>,
): Recording {
  let durationMs = 0;
  // First-appearance order + running aggregates in one pass.
  const order: number[] = [];
  const byteCount = new Map<number, number>();
  const chunkCount = new Map<number, number>();
  for (const c of chunks) {
    if (c.tMs > durationMs) durationMs = c.tMs;
    if (!byteCount.has(c.paneId)) {
      order.push(c.paneId);
      byteCount.set(c.paneId, 0);
      chunkCount.set(c.paneId, 0);
    }
    byteCount.set(c.paneId, (byteCount.get(c.paneId) ?? 0) + c.bytes.length);
    chunkCount.set(c.paneId, (chunkCount.get(c.paneId) ?? 0) + 1);
  }
  const panes: RecordedPane[] = order.map((paneId) => ({
    paneId,
    byteCount: byteCount.get(paneId) ?? 0,
    chunkCount: chunkCount.get(paneId) ?? 0,
    geometry: geometry.get(paneId) ?? null,
  }));
  return { chunks: [...chunks], durationMs, panes };
}

/** Join byte runs into one buffer in order. */
function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/**
 * Bytes for `paneId` with `tMs ≤ toMs`, concatenated in capture order. Feed
 * this into a freshly-cleared terminal to reconstruct the pane's screen at
 * `toMs` — the seek primitive for a backward jump or the first paint.
 */
export function bytesUpTo(
  rec: Recording,
  paneId: number,
  toMs: number,
): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const c of rec.chunks) {
    if (c.paneId === paneId && c.tMs <= toMs) parts.push(c.bytes);
  }
  return concatBytes(parts);
}

/**
 * Bytes for `paneId` with `fromMs < tMs ≤ toMs` — the forward delta that
 * advances a terminal already at `fromMs` to `toMs` without re-seeking from
 * zero. `fromMs` is exclusive so a chunk written when the playhead reached
 * `fromMs` is never written twice: `bytesUpTo(a) ++ bytesBetween(a, b)` equals
 * `bytesUpTo(b)` exactly, for any a ≤ b.
 */
export function bytesBetween(
  rec: Recording,
  paneId: number,
  fromMs: number,
  toMs: number,
): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const c of rec.chunks) {
    if (c.paneId === paneId && c.tMs > fromMs && c.tMs <= toMs) {
      parts.push(c.bytes);
    }
  }
  return concatBytes(parts);
}

/**
 * `paneId`'s entire forward byte stream, concatenated in capture order — every
 * byte the pane emitted after record-start, as one buffer. This is the axis the
 * .11 bisect binary-searches: a position in it is a byte offset, finer than the
 * chunk/time grain (one chunk carries one `tMs`, so time cannot address a point
 * mid-chunk). `paneStreamBytes(rec, p).length` is the bad-end of the search.
 */
export function paneStreamBytes(rec: Recording, paneId: number): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const c of rec.chunks) {
    if (c.paneId === paneId) parts.push(c.bytes);
  }
  return concatBytes(parts);
}

/**
 * Where one byte offset into `paneStreamBytes(rec, paneId)` came from: the index
 * of the chunk it falls in, that chunk's arrival `tMs`, and the offset within
 * the chunk. Ties a bisect culprit byte back to WHEN it arrived and which
 * `%output` chunk carried it — the .8 "who wrote this byte?" provenance, keyed
 * by stream offset instead of grid cell.
 *
 * Returns null when `byteOffset` is outside `[0, streamLength)` — an honest "no
 * such byte" rather than a clamped lie. [LAW:no-silent-failure] The half-open
 * convention matches the bisect: offset N names the Nth byte (0-based), so the
 * end-of-stream sentinel `streamLength` has no owning chunk.
 */
export interface StreamLocation {
  readonly chunkIndex: number;
  readonly tMs: number;
  readonly offsetInChunk: number;
}

export function locateOffset(
  rec: Recording,
  paneId: number,
  byteOffset: number,
): StreamLocation | null {
  if (byteOffset < 0) return null;
  let consumed = 0;
  let chunkIndex = 0;
  for (const c of rec.chunks) {
    if (c.paneId !== paneId) continue;
    if (byteOffset < consumed + c.bytes.length) {
      return { chunkIndex, tMs: c.tMs, offsetInChunk: byteOffset - consumed };
    }
    consumed += c.bytes.length;
    chunkIndex += 1;
  }
  return null;
}

/**
 * Bucket `paneId`'s bytes into `bucketCount` equal time bins over
 * `[0, durationMs]`, returning bytes-per-bin. Powers the scrub bar's activity
 * sparkline — "where the action is" in the recording. A byte at exactly
 * `durationMs` lands in the last bin (the right edge is inclusive).
 *
 * Returns all-zero bins for an empty / zero-duration recording rather than
 * dividing by zero — the honest "no activity" projection. [LAW:no-silent-failure]
 * the caller can tell a flat sparkline (real, captured silence) from an absent
 * one (`bucketCount ≤ 0` → empty array).
 */
export function activityHistogram(
  rec: Recording,
  paneId: number,
  bucketCount: number,
): readonly number[] {
  if (bucketCount <= 0) return [];
  const bins = new Array<number>(bucketCount).fill(0);
  if (rec.durationMs <= 0) return bins;
  for (const c of rec.chunks) {
    if (c.paneId !== paneId) continue;
    const frac = c.tMs / rec.durationMs;
    const idx = Math.min(bucketCount - 1, Math.floor(frac * bucketCount));
    bins[idx] += c.bytes.length;
  }
  return bins;
}

/**
 * The pane to replay by default: the one that produced the most bytes (the
 * busiest is the most interesting to scrub). Null only for an empty recording.
 */
export function busiestPane(rec: Recording): number | null {
  let best: RecordedPane | null = null;
  for (const p of rec.panes) {
    if (best === null || p.byteCount > best.byteCount) best = p;
  }
  return best === null ? null : best.paneId;
}
