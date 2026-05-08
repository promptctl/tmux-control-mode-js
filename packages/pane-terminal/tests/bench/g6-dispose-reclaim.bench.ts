// packages/pane-terminal/tests/bench/g6-dispose-reclaim.bench.ts
//
// GATE 6 — dispose() reclaim: heap returns to within 1MB of pre-construction.
//
// Validates that PaneStream + sink hold no listeners, timers, or DOM nodes
// past `dispose()`. Run with `--expose-gc` so the bench can request explicit
// GC between baseline / construct / dispose / final samples; otherwise V8's
// generational behaviour makes the comparison flaky.
//
// Status: RED (intentional). Requires:
//   - tmux-pane-terminal-8w9.4 (PaneStream.dispose())
//   - tmux-pane-terminal-8w9.5 (TerminalSink.dispose())
//   - tmux-pane-terminal-8w9.6 (XtermSink.dispose())
//   - bench:gate must invoke node with --expose-gc (added to package.json
//     script when impl lands).

import { describe, it, expect } from "vitest";
import { FakeTmuxClient } from "../../src/bench/index.js";

const RECLAIM_BUDGET_BYTES = 1 * 1024 * 1024;

describe("Gate 6 — dispose() reclaim", () => {
  it(`heap returns to within ${RECLAIM_BUDGET_BYTES}B of pre-construction baseline`, () => {
    const client = new FakeTmuxClient();
    void client;
    expect.fail(
      `gate stub: budget=${RECLAIM_BUDGET_BYTES}B reclaim. ` +
        "Requires PaneStream/sink dispose() (8w9.4–6) and node --expose-gc " +
        "in bench:gate script.",
    );
  });
});
