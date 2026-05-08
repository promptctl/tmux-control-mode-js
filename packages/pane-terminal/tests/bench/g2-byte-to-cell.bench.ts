// packages/pane-terminal/tests/bench/g2-byte-to-cell.bench.ts
//
// GATE 2 — Live byte → cell on screen p99 < 16ms (one frame at 60fps).
//
// Runs without real tmux: a FakeTmuxClient injects byte chunks, an XtermSink
// in jsdom renders them. The bench measures the elapsed ms between
// `client.injectOutput()` and the corresponding xterm `onWriteParsed`
// callback, across N=1000 chunks of varied sizes.
//
// Status: RED (intentional). Requires:
//   - tmux-pane-terminal-8w9.4 (PaneStream — output→sink wiring)
//   - tmux-pane-terminal-8w9.5 (TerminalSink interface)
//   - tmux-pane-terminal-8w9.6 (XtermSink — `onWriteParsed` hook)
//   - jsdom + @xterm/xterm devDeps (added when this gate goes green; not
//     pre-installed because the harness must not pretend to test what it
//     cannot run).

import { describe, it, expect } from "vitest";
import { FakeTmuxClient } from "../../src/bench/index.js";

const P99_BUDGET_MS = 16;

describe("Gate 2 — live byte → cell on screen", () => {
  it("p99 byte-to-cell latency < 16ms across 1000 chunks", () => {
    const client = new FakeTmuxClient();
    void client; // structure the bench shape; impl arrives in 8w9.4+
    expect.fail(
      `gate stub: budget=${P99_BUDGET_MS}ms p99 (60fps frame). ` +
        "Requires PaneStream → TerminalSink → XtermSink wiring (8w9.4–6) " +
        "and jsdom + @xterm/xterm devDeps in the package.",
    );
  });
});
