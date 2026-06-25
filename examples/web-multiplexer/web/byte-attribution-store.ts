// examples/web-multiplexer/web/byte-attribution-store.ts
//
// ByteAttributionStore — the IO boundary for "Who wrote this byte?". It taps the
// same all-pane firehose the recorder uses (raw pty bytes, view-independent),
// stamps every delivery with a monotonic chunkId, an arrival time, and an
// absolute stream offset, and retains a bounded per-pane window of those chunks.
// The grid the view renders is `emulate()` over the selected pane's window — the
// pure attribution engine does the parsing/cursor/provenance work; this store
// owns only the tmux IO, the capture clock, and the retention policy.
//
// Why the firehose, not %output: "who wrote this byte" is most truthful at the
// program's actual output byte, BEFORE any emulation — and the firehose taps
// `pipe-pane`, every pane regardless of focus, so no `select-window` hijack is
// needed. The grid is reconstructed from the very bytes it attributes, so the
// cell and its provenance can never disagree. [LAW:one-source-of-truth]
//
// [LAW:effects-at-boundaries] All IO is here: the firehose subscription, the
//   wall clock stamping capture time, the geometry queries, the rebuild ticker.
//   The byte→grid projection (`emulate`) is pure and unit-tested.
// [LAW:no-ambient-temporal-coupling] One ticker is the sole authority that turns
//   accumulated bytes into a fresh grid snapshot; the view never re-emulates.
// [LAW:dataflow-not-control-flow] The grid is a full `emulate` of the retained
//   window every rebuild — the same fold each time, never an incremental special
//   case. "Frozen" is a value that gates whether the ticker rebuilds, not a
//   second code path.

import { makeAutoObservable, runInAction } from "mobx";
import type { TmuxBridge } from "./bridge.ts";
import {
  emulate,
  type AttributionGrid,
  type GridSize,
  type SourceChunk,
} from "./byte-attribution-engine.ts";

/** Default geometry when a pane's size query never resolved. */
const DEFAULT_SIZE: GridSize = { cols: 80, rows: 24 };

/**
 * Per-pane cap on retained bytes. The window must comfortably exceed a full
 * screen's worth of redraws so the reconstructed grid keeps complete provenance;
 * past it the oldest chunks are trimmed (and surfaced, never silently dropped).
 * [LAW:no-silent-failure]
 */
const MAX_BYTES_PER_PANE = 2 * 1024 * 1024;

/** Rebuild cadence for the live preview — ~8fps is smooth for a text grid. */
const REBUILD_INTERVAL_MS = 120;

/** A pane that has produced output, for the selector. */
export interface PaneStat {
  readonly paneId: number;
  readonly byteCount: number;
  readonly chunkCount: number;
  /** True once the oldest chunks were trimmed from this pane's window. */
  readonly trimmed: boolean;
}

interface PaneBuf {
  chunks: SourceChunk[];
  retainedBytes: number;
  streamBytes: number; // absolute bytes ever seen (drives baseOffset)
  trimmed: boolean;
}

function now(): number {
  return performance.now();
}

function parseGeometry(line: string | undefined): GridSize | null {
  if (line === undefined) return null;
  const m = /^(\d+);(\d+)/.exec(line.trim());
  if (m === null) return null;
  const cols = Number(m[1]);
  const rows = Number(m[2]);
  if (cols <= 0 || rows <= 0) return null;
  return { cols, rows };
}

export class ByteAttributionStore {
  /** True while the firehose taps are open (attribution mode is active). */
  active = false;
  /** Which pane the attribution grid reconstructs. */
  selectedPaneId: number | null = null;
  /** When frozen, the grid holds still so cells can be hovered steadily. */
  frozen = false;
  /** The reconstructed screen with per-cell provenance; null until first paint. */
  grid: AttributionGrid | null = null;
  /** Panes seen this session, in first-appearance order. */
  paneList: PaneStat[] = [];

  // --- non-observable capture state ---
  private readonly perPane = new Map<number, PaneBuf>();
  private readonly chunkById = new Map<number, SourceChunk>();
  private readonly geometry = new Map<number, GridSize>();
  private readonly geometryRequested = new Set<number>();
  private captureStartedAt = 0;
  private nextChunkId = 1;
  private dirty = false;
  private readonly ticker: ReturnType<typeof setInterval>;
  private readonly disposeOnFirehose: () => void;
  private readonly disposeOnState: () => void;

  constructor(private readonly bridge: TmuxBridge) {
    makeAutoObservable<
      this,
      | "bridge"
      | "perPane"
      | "chunkById"
      | "geometry"
      | "geometryRequested"
      | "captureStartedAt"
      | "nextChunkId"
      | "dirty"
      | "ticker"
      | "disposeOnFirehose"
      | "disposeOnState"
    >(this, {
      bridge: false,
      perPane: false,
      chunkById: false,
      geometry: false,
      geometryRequested: false,
      captureStartedAt: false,
      nextChunkId: false,
      dirty: false,
      ticker: false,
      disposeOnFirehose: false,
      disposeOnState: false,
    });

    this.disposeOnFirehose = bridge.onFirehose((paneId, data) =>
      this.onFirehoseBytes(paneId, data),
    );
    // A reconnect drops the previous server's taps; re-open if still active.
    this.disposeOnState = bridge.onState((state) => {
      if (state === "ready" && this.active) this.bridge.startFirehose();
    });
    this.captureStartedAt = now();
    this.ticker = setInterval(() => this.tick(), REBUILD_INTERVAL_MS);
  }

  dispose(): void {
    this.disposeOnFirehose();
    this.disposeOnState();
    clearInterval(this.ticker);
    if (this.active) this.bridge.stopFirehose();
  }

  // -------------------------------------------------------------------------
  // Firehose lifecycle (mode active)
  // -------------------------------------------------------------------------

  /** Open the firehose taps and start the capture clock. Idempotent. */
  start(): void {
    if (this.active) return;
    this.active = true;
    this.captureStartedAt = now();
    this.bridge.startFirehose();
  }

  /** Close the firehose taps — idle panes shouldn't pay the pipe-pane cost. */
  stop(): void {
    if (!this.active) return;
    this.active = false;
    this.bridge.stopFirehose();
  }

  // -------------------------------------------------------------------------
  // Capture
  // -------------------------------------------------------------------------

  private onFirehoseBytes(paneId: number, data: Uint8Array): void {
    if (!this.active) return;
    // Own the bytes immutably — the transport may reuse its backing buffer.
    const bytes = data.slice();
    let buf = this.perPane.get(paneId);
    if (buf === undefined) {
      buf = { chunks: [], retainedBytes: 0, streamBytes: 0, trimmed: false };
      this.perPane.set(paneId, buf);
    }
    const chunk: SourceChunk = {
      chunkId: this.nextChunkId++,
      tMs: now() - this.captureStartedAt,
      baseOffset: buf.streamBytes,
      bytes,
    };
    buf.chunks.push(chunk);
    buf.retainedBytes += bytes.length;
    buf.streamBytes += bytes.length;
    this.chunkById.set(chunk.chunkId, chunk);
    this.trimWindow(buf);
    this.requestGeometry(paneId);

    if (this.selectedPaneId === null) this.selectedPaneId = paneId;
    if (paneId === this.selectedPaneId) this.dirty = true;
    this.refreshPaneList();
  }

  /** Evict oldest chunks until the pane's retained window is within budget. */
  private trimWindow(buf: PaneBuf): void {
    while (buf.retainedBytes > MAX_BYTES_PER_PANE && buf.chunks.length > 1) {
      const evicted = buf.chunks.shift();
      if (evicted === undefined) break;
      buf.retainedBytes -= evicted.bytes.length;
      this.chunkById.delete(evicted.chunkId);
      buf.trimmed = true;
    }
  }

  /**
   * Query a pane's geometry once so the grid is sized faithfully. Best-effort: a
   * pane that vanishes before the reply keeps the default size.
   * [LAW:no-silent-failure] a failed query is logged, not silently mis-sized.
   */
  private requestGeometry(paneId: number): void {
    if (this.geometryRequested.has(paneId)) return;
    this.geometryRequested.add(paneId);
    void this.bridge
      .execute(
        `display-message -p -t %${paneId} '#{pane_width};#{pane_height}'`,
      )
      .then((r) => {
        const geo = parseGeometry(r.output[0]);
        if (geo !== null) {
          this.geometry.set(paneId, geo);
          if (paneId === this.selectedPaneId) this.dirty = true;
        }
      })
      .catch((err: unknown) =>
        console.warn(`attribution: geometry query for %${paneId} failed`, err),
      );
  }

  private refreshPaneList(): void {
    const list: PaneStat[] = [];
    for (const [paneId, buf] of this.perPane) {
      list.push({
        paneId,
        byteCount: buf.streamBytes,
        chunkCount: buf.chunks.length,
        trimmed: buf.trimmed,
      });
    }
    runInAction(() => {
      this.paneList = list;
    });
  }

  // -------------------------------------------------------------------------
  // View controls
  // -------------------------------------------------------------------------

  selectPane(paneId: number): void {
    if (paneId === this.selectedPaneId) return;
    this.selectedPaneId = paneId;
    this.rebuild();
  }

  toggleFreeze(): void {
    this.frozen = !this.frozen;
    if (!this.frozen) this.rebuild(); // catch the held view up to now
  }

  /** The geometry the selected pane's grid is reconstructed at. */
  sizeFor(paneId: number | null): GridSize {
    if (paneId === null) return DEFAULT_SIZE;
    return this.geometry.get(paneId) ?? DEFAULT_SIZE;
  }

  /** The retained chunk a cell points at, or null if it was trimmed away. */
  getChunk(chunkId: number): SourceChunk | null {
    return this.chunkById.get(chunkId) ?? null;
  }

  /** Whether the selected pane's window has been trimmed (older bytes gone). */
  get selectedTrimmed(): boolean {
    const id = this.selectedPaneId;
    if (id === null) return false;
    return this.perPane.get(id)?.trimmed ?? false;
  }

  // -------------------------------------------------------------------------
  // Rebuild — the single grid-producing path
  // -------------------------------------------------------------------------

  private tick(): void {
    if (this.frozen || !this.dirty) return;
    this.rebuild();
  }

  private rebuild(): void {
    this.dirty = false;
    const id = this.selectedPaneId;
    const buf = id === null ? undefined : this.perPane.get(id);
    const grid =
      buf === undefined ? null : emulate(buf.chunks, this.sizeFor(id));
    runInAction(() => {
      this.grid = grid;
    });
  }
}
