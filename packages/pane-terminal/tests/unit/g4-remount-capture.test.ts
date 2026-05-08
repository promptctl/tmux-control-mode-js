// packages/pane-terminal/tests/unit/g4-remount-capture.test.ts
//
// GATE 4 — Re-mount the same stream's view 100 times:
//          first mount issues exactly 1 capture-pane;
//          mounts 2..100 issue 0.
//
// This is the contract that makes O2 visible: the stream is the data carrier;
// the view is disposable. Mount churn (visibility flicker, React strict-mode
// double-mount, browser tab restore) must not multiply tmux load.
//
// Status: RED (intentional). Requires:
//   - tmux-pane-terminal-8w9.4 (PaneStream — capture-pane on first attach,
//     cached state on subsequent attaches).

import { describe, it, expect } from "vitest";
import { FakeTmuxClient } from "../../src/bench/index.js";

describe("Gate 4 — re-mount on the same stream", () => {
  it("first mount = 1 capture-pane; mounts 2..100 = 0", () => {
    const client = new FakeTmuxClient();
    expect(client.capturePaneCount()).toBe(0); // baseline

    // When PaneStream lands, this loop attaches/detaches a sink 100×:
    //   const stream = new PaneStream(client, paneId);
    //   for (let i = 0; i < 100; i++) {
    //     const sink = new BufferingSink();
    //     stream.attach(sink);
    //     stream.detach(sink);
    //   }
    //   expect(client.capturePaneCount()).toBe(1);
    expect.fail(
      "gate stub: requires PaneStream attach/detach (8w9.4) + BufferingSink (8w9.5).",
    );
  });
});
