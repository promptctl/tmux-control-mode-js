// packages/pane-terminal/tests/bench/g7-reconnect-burst.bench.ts
//
// GATE 7 — Reconnect with N attached streams:
//          first visible stream paints in < 100ms;
//          total burst < 50ms tmux serialization.
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

import { describe, it, expect } from "vitest";
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
  it(
    `first-visible reseed < ${FIRST_PAINT_BUDGET_MS}ms; ` +
      `total reseed burst < ${TOTAL_BURST_BUDGET_MS}ms; ` +
      `${ATTACHED_STREAM_COUNT} attached streams`,
    async () => {
      const client = new FakeTmuxClient();
      // Four lines per capture-pane response — non-trivial, won't skew timing.
      client.setCapturePaneResponse(() => "row-0\nrow-1\nrow-2\nrow-3\n");

      const sinks: TimedBufferingSink[] = [];
      const streams: PaneStream[] = [];
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

      // Every attached sink should have one ADDITIONAL seed call.
      for (let i = 0; i < ATTACHED_STREAM_COUNT; i++) {
        expect(sinks[i].seedCalls.length).toBe(2);
      }

      // Visible-priority sink should be the first to be reseeded.
      const visibleAt = sinks[VISIBLE_INDEX].lastSeedAt;
      const otherSeedTimes = sinks
        .map((s, i) => (i === VISIBLE_INDEX ? Infinity : s.lastSeedAt))
        .filter((t) => Number.isFinite(t));
      const earliestOther = Math.min(...otherSeedTimes);
      expect(
        visibleAt,
        `visible reseed (${visibleAt.toFixed(3)}ms) must precede earliest other (${earliestOther.toFixed(3)}ms)`,
      ).toBeLessThanOrEqual(earliestOther);

      const firstPaintMs = visibleAt - burstStart;
      const totalBurstMs = burstEnd - burstStart;
      expect(
        firstPaintMs,
        `first-visible paint ${firstPaintMs.toFixed(3)}ms (budget ${FIRST_PAINT_BUDGET_MS}ms)`,
      ).toBeLessThan(FIRST_PAINT_BUDGET_MS);
      expect(
        totalBurstMs,
        `total burst ${totalBurstMs.toFixed(3)}ms (budget ${TOTAL_BURST_BUDGET_MS}ms)`,
      ).toBeLessThan(TOTAL_BURST_BUDGET_MS);

      for (const s of streams) s.dispose();
    },
  );
});
