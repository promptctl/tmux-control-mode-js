// packages/pane-terminal/tests/bench/g7-reconnect-burst.bench.ts
//
// GATE 7 — Reconnect with N attached streams:
//          first visible stream paints in < 100ms;
//          total burst < 50ms tmux serialization.
//
// Validates O6 from the design doc: re-seeds are dispatched in priority order
// (visible-attached → other-attached → detached) over a single tmux pipe, so
// the *first* stream paints fast even when the fleet is large. The 50ms
// "total burst" budget covers the FakeTmuxClient-side serialization of all
// capture-pane requests — not real tmux throughput, which is gate 1's domain.
//
// Status: RED (intentional). Requires:
//   - tmux-pane-terminal-8w9.4 (PaneStream — ReseedScheduler with visibility
//     priority; reconnect handler that triggers re-seed).

import { describe, it, expect } from "vitest";
import { FakeTmuxClient } from "../../src/bench/index.js";

const FIRST_PAINT_BUDGET_MS = 100;
const TOTAL_BURST_BUDGET_MS = 50;
const ATTACHED_STREAM_COUNT = 8;

describe("Gate 7 — reconnect burst with attached streams", () => {
  it(
    `first-visible paint < ${FIRST_PAINT_BUDGET_MS}ms; ` +
      `total serialization < ${TOTAL_BURST_BUDGET_MS}ms; ` +
      `${ATTACHED_STREAM_COUNT} attached streams`,
    () => {
      const client = new FakeTmuxClient();
      void client;
      expect.fail(
        "gate stub: requires PaneStream reconnect + ReseedScheduler (8w9.4).",
      );
    },
  );
});
