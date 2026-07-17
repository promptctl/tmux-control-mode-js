// packages/pane-terminal/tests/bench/g7-reconnect-burst.bench.ts
//
// GATE 7 — Reconnect with N attached streams:
//          ENFORCED: visible stream reseeds first and paints in < 100ms;
//          SKIPPED (tmux-test-gates-e33.6): total burst < 50ms serialization.
//
// Validates O6 from the design doc: reseeds dispatch in priority order
// (visible-attached → other-attached → detached) over a single tmux pipe,
// so the *first* visible stream paints fast even when the fleet is large.
// The 50ms "total burst" budget covers FakeTmuxClient-side serialization of
// every capture-pane request — not real tmux throughput, which is gate 1's
// domain.
//
// Status: GREEN as of 8w9.4. Updated in 8w9.5 to use BufferingSink as the
// canonical fixture; visibility is now owned by the sink (per design doc
// O6) rather than the stream, which is why we model offscreen panes as
// `new BufferingSink({ visible: false })`.
//
// The scenario is driven once (beforeAll) and asserted by two separate
// gates so a noise-dominated metric can't poison a deterministic one
// [LAW:decomposition]. The ordering + first-paint gate is enforced; the
// aggregate total-burst gate is `it.skip` pending re-specification — it
// measures 32× macrotask scheduler latency, not serialization, and flakes
// under GC/load contention. See tmux-test-gates-e33.6. [FRAMING:representation]

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { FakeTmuxClient } from "../../src/bench/index.js";
import { PaneStream } from "../../src/stream/index.js";
import { BufferingSink } from "../../src/sink/index.js";

const FIRST_PAINT_BUDGET_MS = 100;
const TOTAL_BURST_BUDGET_MS = 50;
const ATTACHED_STREAM_COUNT = 8;
// One stream's sink is `visible:true` so the priority lane is meaningfully
// exercised; the rest are `visible:false` (still attached, lower priority).
const VISIBLE_INDEX = 3;

// Wrap BufferingSink to record the wall-clock time of each seed() call so
// the gate can assert ordering and first-paint latency. Subclassing keeps
// the byte/text contract with the canonical sink — only the timing field
// is local.
class TimedBufferingSink extends BufferingSink {
  lastSeedAt = 0;
  override seed(...args: Parameters<BufferingSink["seed"]>): void {
    super.seed(...args);
    this.lastSeedAt = performance.now();
  }
}

async function tick(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

describe("Gate 7 — reconnect burst with attached streams", () => {
  let streams: PaneStream[] = [];
  // Measurements captured from a single reconnect-burst run so both gates
  // below describe the same run rather than re-driving the scenario twice.
  let reseedCounts: number[] = [];
  let visibleAt = 0;
  let earliestOther = 0;
  let firstPaintMs = 0;
  let totalBurstMs = 0;

  beforeAll(async () => {
    const client = new FakeTmuxClient();
    // Four lines per capture-pane response — non-trivial, won't skew timing.
    client.setCapturePaneResponse(() => "row-0\nrow-1\nrow-2\nrow-3\n");

    const sinks: TimedBufferingSink[] = [];
    for (let i = 0; i < ATTACHED_STREAM_COUNT; i++) {
      const sink = new TimedBufferingSink({
        visible: i === VISIBLE_INDEX,
      });
      const stream = new PaneStream({
        client,
        paneId: i + 1,
      });
      stream.attach(sink);
      sinks.push(sink);
      streams.push(stream);
    }
    // Drain initial seed so each sink baselines at exactly 1 seed call.
    for (let i = 0; i < ATTACHED_STREAM_COUNT * 2; i++) await tick();
    expect(sinks.every((s) => s.seedCalls.length === 1)).toBe(true);

    // Drive the reconnect. FakeTmuxClient must transition through
    // 'reconnecting' first so the next 'ready' synthesizes 'reconnected'.
    client.setConnectionState({ status: "reconnecting", attempt: 1 });
    const burstStart = performance.now();
    client.setConnectionState({ status: "ready" });

    // Run the scheduled reseed sweep to completion. Each capture-pane
    // resolves on the next macrotask (FakeTmuxClient default 0ms RTT).
    for (let i = 0; i < ATTACHED_STREAM_COUNT * 4; i++) await tick();
    const burstEnd = performance.now();

    reseedCounts = sinks.map((s) => s.seedCalls.length);
    visibleAt = sinks[VISIBLE_INDEX].lastSeedAt;
    const otherSeedTimes = sinks
      .map((s, i) => (i === VISIBLE_INDEX ? Infinity : s.lastSeedAt))
      .filter((t) => Number.isFinite(t));
    earliestOther = Math.min(...otherSeedTimes);
    firstPaintMs = visibleAt - burstStart;
    totalBurstMs = burstEnd - burstStart;
  });

  afterAll(() => {
    for (const s of streams) s.dispose();
    streams = [];
  });

  it(
    `visible-priority stream reseeds first and paints < ${FIRST_PAINT_BUDGET_MS}ms; ` +
      `${ATTACHED_STREAM_COUNT} attached streams each reseed once`,
    () => {
      // Every attached sink should have one ADDITIONAL seed call.
      expect(reseedCounts).toEqual(new Array(ATTACHED_STREAM_COUNT).fill(2));
      // Visible-priority sink should be the first to be reseeded.
      expect(
        visibleAt,
        `visible reseed (${visibleAt.toFixed(3)}ms) must precede earliest other (${earliestOther.toFixed(3)}ms)`,
      ).toBeLessThanOrEqual(earliestOther);
      expect(
        firstPaintMs,
        `first-visible paint ${firstPaintMs.toFixed(3)}ms (budget ${FIRST_PAINT_BUDGET_MS}ms)`,
      ).toBeLessThan(FIRST_PAINT_BUDGET_MS);
    },
  );

  // SKIPPED pending tmux-test-gates-e33.6. `totalBurstMs` spans 32 macrotask
  // ticks (setTimeout(0)); its wall-clock is dominated by Node's timer floor
  // and GC pauses, not the capture-pane serialization the budget names — so
  // it flakes under full-suite contention (passes in isolation, ~40% fail in
  // `bench:gate`). Do not un-skip by widening the budget; re-specify the
  // metric to measure deterministic work. [LAW:no-silent-failure]
  it.skip(`total reseed burst < ${TOTAL_BURST_BUDGET_MS}ms serialization budget`, () => {
    expect(
      totalBurstMs,
      `total burst ${totalBurstMs.toFixed(3)}ms (budget ${TOTAL_BURST_BUDGET_MS}ms)`,
    ).toBeLessThan(TOTAL_BURST_BUDGET_MS);
  });
});
