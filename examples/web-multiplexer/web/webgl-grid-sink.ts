// examples/web-multiplexer/web/webgl-grid-sink.ts
//
// WebGLGridSink — a `TerminalSink` (the pane-terminal data-out contract) that
// is NOT xterm. It is the whole thesis of this demo made concrete: the sink
// interface is renderer-agnostic, so a `PaneStream` can drive a from-scratch
// WebGL grid renderer exactly as it drives `XtermSink`. The sink turns raw pane
// bytes into a screen of cells the WebGL renderer can paint.
//
// pane-terminal gives the renderer NO cell grid — it forwards opaque bytes and
// names xterm "the single decoding authority". A non-xterm renderer must own a
// VT emulator; this sink reuses byte-attribution's `AttributionEngine` whole
// (the repo's one tested VT-grid emulator) rather than minting a second.
// [LAW:one-source-of-truth] [LAW:carrying-cost]
//
// [LAW:effects-at-boundaries] This sink is the boundary where bytes become a
//   grid; it holds no GL and no clock. The grid it exposes is pure data.

import type { SeedCursor, TerminalSink } from "@promptctl/pane-terminal/sink";
import {
  AttributionEngine,
  type GridSize,
  type SourceChunk,
} from "./byte-attribution-engine.ts";
import type { RenderGrid } from "./webgl-atlas-engine.ts";

/** Recent bytes retained per pane to replay on resize. Bounds memory; very old
 *  off-screen content is lost on a resize, which is acceptable because the grid
 *  is screen-only (cols×rows) and apps repaint on SIGWINCH. */
const REPLAY_BUFFER_BYTES = 256 * 1024;

export class WebGLGridSink implements TerminalSink {
  private size: GridSize;
  private engine: AttributionEngine;

  // Bounded replay log, only consulted on resize.
  private readonly buffer: SourceChunk[] = [];
  private bufferedBytes = 0;
  private nextChunkId = 0;
  private streamBytes = 0;

  // Cache the snapshot; recompute only when new bytes have arrived.
  private cached: RenderGrid | null = null;
  private dirty = true;
  private disposed = false;

  constructor(initial: GridSize) {
    this.size = { cols: Math.max(1, initial.cols), rows: Math.max(1, initial.rows) };
    this.engine = new AttributionEngine(this.size);
  }

  // --- TerminalSink ---------------------------------------------------------

  seed(captured: Uint8Array, _cursor: SeedCursor | null): void {
    this.ingest(captured);
  }

  write(data: Uint8Array): void {
    this.ingest(data);
  }

  resize(cols: number, rows: number): void {
    const next: GridSize = { cols: Math.max(1, cols), rows: Math.max(1, rows) };
    if (next.cols === this.size.cols && next.rows === this.size.rows) return;
    this.size = next;
    this.engine = new AttributionEngine(next);
    for (const chunk of this.buffer) this.engine.pushBytes(chunk);
    this.dirty = true;
  }

  clear(): void {
    this.buffer.length = 0;
    this.bufferedBytes = 0;
    this.engine = new AttributionEngine(this.size);
    this.dirty = true;
  }

  isVisible(): boolean {
    return true;
  }

  dispose(): void {
    this.disposed = true;
    this.buffer.length = 0;
    this.bufferedBytes = 0;
    this.cached = null;
  }

  // --- Render-facing read ---------------------------------------------------

  /** The current screen as a `RenderGrid` (an `AttributionGrid` is structurally
   *  one). Recomputed only when bytes have arrived since the last read. */
  get grid(): RenderGrid {
    if (this.cached === null || this.dirty) {
      this.cached = this.engine.snapshot();
      this.dirty = false;
    }
    return this.cached;
  }

  // --- internals ------------------------------------------------------------

  private ingest(bytes: Uint8Array): void {
    if (this.disposed || bytes.length === 0) return;
    const chunk: SourceChunk = {
      chunkId: this.nextChunkId++,
      tMs: 0, // provenance unused by this renderer; see header.
      baseOffset: this.streamBytes,
      bytes,
    };
    this.streamBytes += bytes.length;
    this.engine.pushBytes(chunk);
    this.buffer.push(chunk);
    this.bufferedBytes += bytes.length;
    while (this.bufferedBytes > REPLAY_BUFFER_BYTES && this.buffer.length > 1) {
      const evicted = this.buffer.shift();
      if (evicted !== undefined) this.bufferedBytes -= evicted.bytes.length;
    }
    this.dirty = true;
  }
}
