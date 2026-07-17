// packages/pane-terminal/tests/bench/g7-reconnect-burst.bench.ts
//
// GATE 7 — Reconnect with N attached streams, two enforced properties:
//          (1) the visible stream reseeds first and paints in < 100ms;
//          (2) the burst issues exactly one capture-pane per attached
//              stream — no redundant serialization over the tmux pipe.
//
// Validates O6 from the design doc: reseeds dispatch in priority order
// (visible-attached → other-attached → detached) over a single tmux pipe,
// so the *first* visible stream paints fast even when the fleet is large.
//
// The "serialization budget" is the COUNT of capture-pane requests the
// burst issues (FakeTmuxClient.capturePaneCount()), not wall-clock. That
// count IS the serialization work — one capture-pane per attached reseed —
// and it is invariant to GC pauses, Node's timer floor, and system load,
// so it cannot flake. A prior revision (pre tmux-test-gates-e33.6) asserted
// a 50ms wall-clock budget spanning 32 setTimeout(0) macrotasks; that
// number measured scheduler latency, not serialization, and its name lied
// about what it stood for. Counting the requests measures the work the
// budget always named. [FRAMING:representation] [LAW:no-silent-failure]
//
// Real tmux throughput is gate 1's domain (single-attach p99 against a
// live process); this gate owns the fake-side aggregate request shape.
//
// Status: GREEN as of 8w9.4. Updated in 8w9.5 to use BufferingSink as the
// canonical fixture; visibility is now owned by the sink (per design doc
// O6) rather than the stream, which is why we model offscreen panes as
// `new BufferingSink({ visible: false })`.
//
// The scenario is driven once (beforeAll) and asserted by two separate
// gates, each reading the property at its own seam [LAW:decomposition]:
// the ordering + first-paint gate reads the sink-side seed callbacks; the
// serialization gate reads the pipe-side capture-pane request log. The
// seams are distinct — a regression that double-issues capture-pane but
// drops the stale second result would keep the seed count at one yet
// double the request count, so the request gate catches what the seed
// gate cannot see.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { FakeTmuxClient } from "../../src/bench/index.js";
import { PaneStream } from "../../src/stream/index.js";
import { BufferingSink } from "../../src/sink/index.js";

const FIRST_PAINT_BUDGET_MS = 100;
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
  // Count of capture-pane requests the reconnect burst issued (delta of the
  // fake's capture-pane log across the burst window). Deterministic — the
  // serialization work the "budget" always named, read at the pipe seam.
  let burstCaptureCount = 0;

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
    // Snapshot the capture-pane request log immediately before the burst so
    // the delta after the sweep is exactly the burst's serialization work.
    const captureBefore = client.capturePaneCount();
    client.setConnectionState({ status: "reconnecting", attempt: 1 });
    const burstStart = performance.now();
    client.setConnectionState({ status: "ready" });

    // Run the scheduled reseed sweep to completion. Each capture-pane
    // resolves on the next macrotask (FakeTmuxClient default 0ms RTT).
    for (let i = 0; i < ATTACHED_STREAM_COUNT * 4; i++) await tick();

    reseedCounts = sinks.map((s) => s.seedCalls.length);
    visibleAt = sinks[VISIBLE_INDEX].lastSeedAt;
    const otherSeedTimes = sinks
      .map((s, i) => (i === VISIBLE_INDEX ? Infinity : s.lastSeedAt))
      .filter((t) => Number.isFinite(t));
    earliestOther = Math.min(...otherSeedTimes);
    firstPaintMs = visibleAt - burstStart;
    burstCaptureCount = client.capturePaneCount() - captureBefore;
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

  // The burst must serialize exactly one capture-pane per attached stream —
  // no redundant captures over the single tmux pipe. `===` is the strongest
  // true theorem: more means redundant serialization, fewer means a stream
  // failed to reseed; both are defects. This is deterministic (a request
  // count, not wall-clock) so it holds under any GC/timer/load conditions.
  // [FRAMING:representation] [LAW:types-are-the-program]
  it(`reconnect burst issues exactly ${ATTACHED_STREAM_COUNT} capture-pane requests (one per attached stream)`, () => {
    expect(
      burstCaptureCount,
      `burst issued ${burstCaptureCount} capture-pane requests (expected one per attached stream = ${ATTACHED_STREAM_COUNT})`,
    ).toBe(ATTACHED_STREAM_COUNT);
  });
});
