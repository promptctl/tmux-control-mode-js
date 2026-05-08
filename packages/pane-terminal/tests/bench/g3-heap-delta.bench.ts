// packages/pane-terminal/tests/bench/g3-heap-delta.bench.ts
//
// GATE 3 — 24 detached streams + 100KB/s aggregate output:
//          heap delta over the simulated window < 2MB.
//
// "Zero allocation in hot path" is the second clause of this requirement.
// Heap-delta is the runtime check (this file). The static check — no
// allocation expressions inside `// [HOT-PATH]`-marked function bodies — is
// the ESLint rule `no-allocation-in-hot-path` (see ../unit/hot-path-rule.test.ts).
// Two enforcements for one constraint because neither alone is sufficient:
// V8 has no public allocation counter per function, and a long-running heap
// trace cannot prove a *specific* function never allocates.
//
// Status: GREEN as of 8w9.4 — `bench:gate` sets `NODE_OPTIONS=--expose-gc`
// in this package's package.json, so CI gets the explicit GC the heap-delta
// measurement needs. Manual `vitest run` against this file falls back to
// "skip with reason" if --expose-gc is absent; without it, generational
// behaviour makes the comparison too noisy to gate on.

import { describe, it, expect } from "vitest";
import { FakeTmuxClient } from "../../src/bench/index.js";
import { PaneStream } from "../../src/stream/index.js";
import type { PaneStreamClient } from "../../src/stream/index.js";

const HEAP_BUDGET_BYTES = 2 * 1024 * 1024;
const STREAM_COUNT = 24;
const BYTES_PER_SECOND = 100 * 1024;
const DURATION_S = 60;
// One byte event per stream per "tick"; we choose tick rate so total
// throughput across all streams averages BYTES_PER_SECOND. The bench loop
// runs in real time but the per-iteration sleep is collapsed to next tick —
// 60s of simulated traffic, far less wall time.
const TICKS_PER_SECOND = 50;
const TOTAL_TICKS = DURATION_S * TICKS_PER_SECOND;
const BYTES_PER_TICK = Math.ceil(BYTES_PER_SECOND / TICKS_PER_SECOND);
const BYTES_PER_STREAM_PER_TICK = Math.ceil(BYTES_PER_TICK / STREAM_COUNT);

interface ExposedGc {
  (): void;
}

function getGc(): ExposedGc | null {
  // Node exposes `global.gc` only when launched with --expose-gc. Vitest
  // honours this through its `pool: forks` worker too.
  const candidate = (globalThis as { gc?: unknown }).gc;
  return typeof candidate === "function" ? (candidate as ExposedGc) : null;
}

describe("Gate 3 — heap delta over 60s of detached output", () => {
  const gc = getGc();

  it.skipIf(gc === null)(
    `heap delta < ${HEAP_BUDGET_BYTES} bytes after ${DURATION_S}s @ ${BYTES_PER_SECOND}B/s × ${STREAM_COUNT} streams`,
    () => {
      const runGc = gc!;
      const client = new FakeTmuxClient();

      // Construct N detached streams (no attach() means no sink, state
      // stays 'idle'; the byte handler still runs and bumps activity
      // counters — that's the [HOT-PATH] this gate exercises).
      const streams: PaneStream[] = [];
      for (let i = 0; i < STREAM_COUNT; i++) {
        streams.push(
          new PaneStream({
            client: client as unknown as PaneStreamClient,
            paneId: i + 1,
          }),
        );
      }

      // Pre-allocate one chunk per stream and reuse — mirrors what the
      // real transport layer does (parser yields slices into its buffer).
      // Allocation in the chunk MUST be outside the loop, otherwise the
      // gate would measure our own allocation pressure rather than
      // PaneStream's.
      const chunks: Uint8Array[] = streams.map(
        () => new Uint8Array(BYTES_PER_STREAM_PER_TICK),
      );

      // Stabilise the baseline: drive the system once so any one-shot
      // lazy initialisation (RegExp caches, timer slot allocation) has
      // already happened, then GC and sample.
      for (let s = 0; s < STREAM_COUNT; s++) {
        client.injectOutput(s + 1, chunks[s]);
      }
      runGc();
      runGc();
      const baseline = process.memoryUsage().heapUsed;

      for (let t = 0; t < TOTAL_TICKS; t++) {
        for (let s = 0; s < STREAM_COUNT; s++) {
          client.injectOutput(s + 1, chunks[s]);
        }
      }

      runGc();
      runGc();
      const after = process.memoryUsage().heapUsed;
      const delta = after - baseline;

      for (const stream of streams) stream.dispose();

      expect(
        delta,
        `heap delta ${delta} bytes (budget ${HEAP_BUDGET_BYTES})`,
      ).toBeLessThan(HEAP_BUDGET_BYTES);
    },
  );

  it("declares the SKIP reason when --expose-gc is not present", () => {
    if (gc !== null) return;
    // [LAW:verifiable-goals] When the gate cannot be measured deterministically
    // it must say so loudly rather than silently passing. CI wires --expose-gc
    // in the bench:gate script.
    expect(true).toBe(true);
    // eslint-disable-next-line no-console
    console.warn(
      "[gate-3] skipped: launch node with --expose-gc to enable the heap-delta gate.",
    );
  });
});
