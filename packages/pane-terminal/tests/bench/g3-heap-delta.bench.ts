// packages/pane-terminal/tests/bench/g3-heap-delta.bench.ts
//
// GATE 3 — 24 detached streams + 100KB/s aggregate output:
//          heap delta over 60s < 2MB.
//
// "Zero allocation in hot path" is the second clause of this requirement.
// Heap-delta is the runtime check (this file). The static check — no
// allocation expressions inside `// [HOT-PATH]`-marked function bodies — is
// the ESLint rule `no-allocation-in-hot-path` (see ../unit/hot-path-rule.test.ts).
// Two enforcements for one constraint because neither alone is sufficient:
// V8 has no public allocation counter per function, and a long-running heap
// trace cannot prove a *specific* function never allocates.
//
// Status: RED (intentional). Requires:
//   - tmux-pane-terminal-8w9.4 (PaneStream — detached counter path with
//     [HOT-PATH] marker on the byte-arrival callback).
//
// Verification when green: 24 PaneStream instances, FakeTmuxClient emits
// 100KB/s of synthetic bytes split across them for 60 simulated seconds
// (`vi.useFakeTimers()` advances the clock; real time is much shorter).
// Heap is sampled before and after with explicit GC; delta < 2MB.

import { describe, it, expect } from "vitest";
import { FakeTmuxClient } from "../../src/bench/index.js";

const HEAP_BUDGET_BYTES = 2 * 1024 * 1024;
const STREAM_COUNT = 24;
const BYTES_PER_SECOND = 100 * 1024;
const DURATION_S = 60;

describe("Gate 3 — heap delta over 60s of detached output", () => {
  it(`heap delta < ${HEAP_BUDGET_BYTES} bytes after ${DURATION_S}s @ ${BYTES_PER_SECOND}B/s × ${STREAM_COUNT} streams`, () => {
    const client = new FakeTmuxClient();
    void client;
    expect.fail(
      `gate stub: budget=${HEAP_BUDGET_BYTES}B heap delta. ` +
        "Requires PaneStream detached-counter path (8w9.4) with " +
        "// [HOT-PATH] marker on the byte-arrival callback.",
    );
  });
});
