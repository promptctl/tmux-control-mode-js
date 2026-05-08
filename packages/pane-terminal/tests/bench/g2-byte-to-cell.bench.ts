// packages/pane-terminal/tests/bench/g2-byte-to-cell.bench.ts
//
// GATE 2 — Live byte → cell on screen p99 < 16ms (one frame at 60fps).
//
// Two-step gate. As of 8w9.4, "cell on screen" is measured at the
// `TerminalSink.write` boundary — that is the producer-side end-to-end
// latency PaneStream owns: `FakeTmuxClient.injectOutput()` → `output`
// event dispatch → PaneStream's [HOT-PATH] callback → `sink.write(bytes)`.
// When XtermSink lands in 8w9.6, this same gate broadens to measure
// inject → xterm `onWriteParsed` (true cell-on-screen). The threshold
// (16ms p99) holds across both — the producer half should sit far below
// the budget so XtermSink has headroom.

import { describe, it, expect } from "vitest";
import { FakeTmuxClient } from "../../src/bench/index.js";
import { PaneStream } from "../../src/stream/index.js";
import type { PaneStreamClient, TerminalSink } from "../../src/stream/index.js";
import type { SeedCursor } from "../../src/sink/index.js";

const P99_BUDGET_MS = 16;
const ITERATIONS = 1000;
// Mix of chunk sizes a real session sees: small mouse reports, medium
// terminal text, occasional larger blits from `ls -la` style output.
const CHUNK_SIZES = [11, 64, 256, 1024];

class TimingSink implements TerminalSink {
  // Most recent write timestamp; gate reads + clears between iterations.
  lastWriteAt = 0;
  seed(_t: string, _c: SeedCursor | null): void {
    /* no-op */
  }
  write(_bytes: Uint8Array): void {
    this.lastWriteAt = performance.now();
  }
  resize(_c: number, _r: number): void {
    /* no-op */
  }
  dispose(): void {
    /* no-op */
  }
}

function p99(samples: number[]): number {
  const sorted = samples.slice().sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99));
  return sorted[idx];
}

describe("Gate 2 — live byte → cell on screen", () => {
  it(`p99 byte-to-sink latency < ${P99_BUDGET_MS}ms across ${ITERATIONS} chunks`, async () => {
    const client = new FakeTmuxClient();
    client.setCapturePaneResponse(() => "");
    const sink = new TimingSink();
    const stream = new PaneStream({
      client: client as unknown as PaneStreamClient,
      paneId: 1,
    });
    stream.attach(sink);
    // Drain the seed Promise.all so subsequent injects land on live path.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    const samples: number[] = new Array(ITERATIONS);
    for (let i = 0; i < ITERATIONS; i++) {
      const size = CHUNK_SIZES[i % CHUNK_SIZES.length];
      const chunk = new Uint8Array(size);
      // Some non-zero content; values don't matter for latency.
      chunk[0] = 0x41;
      chunk[size - 1] = 0x42;
      const t0 = performance.now();
      client.injectOutput(1, chunk);
      // sink.write is called synchronously inside the dispatch (FakeTmuxClient
      // emits synchronously; PaneStream forwards in the same task). The
      // sample is the elapsed time from injectOutput call to sink.write
      // observing the chunk.
      samples[i] = sink.lastWriteAt - t0;
    }

    stream.dispose();
    const p99ms = p99(samples);
    expect(
      p99ms,
      `p99 byte→sink latency ${p99ms.toFixed(3)}ms (budget ${P99_BUDGET_MS}ms)`,
    ).toBeLessThan(P99_BUDGET_MS);
  });
});
