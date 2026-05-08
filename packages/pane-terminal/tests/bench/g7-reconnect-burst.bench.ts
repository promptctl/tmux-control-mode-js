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
// Status: GREEN as of 8w9.4. PaneStream registers with the per-client
// `ReseedScheduler`; on the fake's `'reconnected'` event the scheduler
// dispatches sequentially by priority. We count the first sink to receive
// a *fresh* seed after reconnect for the first-paint metric.

import { describe, it, expect } from "vitest";
import { FakeTmuxClient } from "../../src/bench/index.js";
import { PaneStream } from "../../src/stream/index.js";
import type { PaneStreamClient, TerminalSink } from "../../src/stream/index.js";
import type { SeedCursor } from "../../src/sink/index.js";

const FIRST_PAINT_BUDGET_MS = 100;
const TOTAL_BURST_BUDGET_MS = 50;
const ATTACHED_STREAM_COUNT = 8;
// One stream marked 'visible' so the priority lane is meaningfully
// exercised; the rest are 'hidden' (still attached, lower priority).
const VISIBLE_INDEX = 3;

class TimingSink implements TerminalSink {
  seedCount = 0;
  lastSeedAt = 0;
  seed(_t: string, _c: SeedCursor | null): void {
    this.seedCount += 1;
    this.lastSeedAt = performance.now();
  }
  write(_bytes: Uint8Array): void {
    /* no-op */
  }
  resize(_c: number, _r: number): void {
    /* no-op */
  }
  dispose(): void {
    /* no-op */
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
      // Ten lines per capture-pane response — enough to be non-trivial,
      // small enough to not skew timing.
      client.setCapturePaneResponse(() => "row-0\nrow-1\nrow-2\nrow-3\n");

      const sinks: TimingSink[] = [];
      const streams: PaneStream[] = [];
      for (let i = 0; i < ATTACHED_STREAM_COUNT; i++) {
        const sink = new TimingSink();
        const stream = new PaneStream({
          client: client as unknown as PaneStreamClient,
          paneId: i + 1,
          visibility: i === VISIBLE_INDEX ? "visible" : "hidden",
        });
        stream.attach(sink);
        sinks.push(sink);
        streams.push(stream);
      }
      // Drain initial seed so seedCount baselines at 1 per sink.
      for (let i = 0; i < ATTACHED_STREAM_COUNT * 2; i++) await tick();
      const baselineSeedCounts = sinks.map((s) => s.seedCount);
      expect(baselineSeedCounts.every((c) => c === 1)).toBe(true);

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
        expect(sinks[i].seedCount).toBe(2);
      }

      // Visible-priority sink should be the first to be reseeded.
      const visibleAt = sinks[VISIBLE_INDEX].lastSeedAt;
      const otherSeedTimes = sinks
        .map((s, i) => (i === VISIBLE_INDEX ? Infinity : s.lastSeedAt))
        .filter((t) => Number.isFinite(t));
      const earliestOther = Math.min(...otherSeedTimes);
      expect(
        visibleAt,
        `visible reseed (${visibleAt.toFixed(3)}ms) " +
        "must precede earliest other (${earliestOther.toFixed(3)}ms)`,
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
