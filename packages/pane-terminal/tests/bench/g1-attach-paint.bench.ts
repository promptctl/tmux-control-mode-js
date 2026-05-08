// packages/pane-terminal/tests/bench/g1-attach-paint.bench.ts
//
// GATE 1 — Visibility toggle → first paint p99 < 100ms.
//
// This is the only gate that needs a real tmux process: the requirement
// includes the round-trip cost of capture-pane, which is precisely what we're
// budgeting against. Skipped unless TMUX_INTEGRATION=1.
//
// Status: RED (intentional). Requires:
//   - tmux-pane-terminal-8w9.4 (PaneStream — attach() implementation)
//   - tmux-pane-terminal-8w9.5 (BufferingSink — knows when "first paint" fires)
//   - tmux-pane-terminal-8w9.6 (XtermSink — DOM render path)
//
// Verification: when impl lands, this measures the elapsed ms between
// `stream.attach(sink)` and the first `sink.write()` (or `seed()`) callback,
// across N=200 iterations on a fresh pane, and asserts p99 < 100ms.

import { describe, it, expect } from "vitest";

const P99_BUDGET_MS = 100;

const integrationOn = process.env.TMUX_INTEGRATION === "1";

describe.skipIf(!integrationOn)(
  "Gate 1 — visibility toggle → first paint",
  () => {
    it("p99 first-paint latency < 100ms across 200 attaches", () => {
      // [LAW:behavior-not-structure] Threshold is the contract; this gate
      // depends on PaneStream/sink shape only via their public attach/paint
      // events, never on internals.
      expect.fail(
        `gate stub: budget=${P99_BUDGET_MS}ms p99. ` +
          "Requires PaneStream.attach() (8w9.4) + sink first-paint event (8w9.5/8w9.6). " +
          "Run with TMUX_INTEGRATION=1 once impl lands.",
      );
    });
  },
);
