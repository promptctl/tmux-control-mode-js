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
// Status: GREEN as of 8w9.5. PaneStream's attach()/detach() preserves stream
// state across the hop — the only capture happens on the very first attach.

import { describe, it, expect } from "vitest";
import { FakeTmuxClient } from "../../src/bench/index.js";
import { PaneStream } from "../../src/stream/index.js";
import type { PaneStreamClient } from "../../src/stream/index.js";
import { BufferingSink } from "../../src/sink/index.js";

const PANE_ID = 1;
const REMOUNT_COUNT = 100;

async function flushSeed(): Promise<void> {
  // Two ticks: capture-pane + cursor display-message both resolve via
  // FakeTmuxClient.execute() on the next macrotask each.
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

describe("Gate 4 — re-mount on the same stream", () => {
  it(`first mount = 1 capture-pane; mounts 2..${REMOUNT_COUNT} = 0 (re-attach reuses stream state)`, async () => {
    const client = new FakeTmuxClient();
    client.setCapturePaneResponse((cmd) =>
      cmd.startsWith("display-message") ? "0;0" : "row-0\nrow-1\n",
    );
    const stream = new PaneStream({
      client: client as unknown as PaneStreamClient,
      paneId: PANE_ID,
    });
    expect(client.capturePaneCount()).toBe(0); // baseline

    // FIRST attach — triggers capture-pane (and a paired display-message,
    // which is NOT a capture-pane invocation; the count tracks only the
    // capture).
    const firstSink = new BufferingSink();
    stream.attach(firstSink);
    await flushSeed();
    expect(client.capturePaneCount()).toBe(1);
    expect(firstSink.seedCalls).toHaveLength(1);

    stream.detach();
    expect(stream.state).toBe("detached");

    // Mounts 2..N — re-attach with a fresh sink each time. Per the ticket
    // contract, none of these add another capture-pane call: the stream
    // re-issues capture only on first attach (idle → seeding). On every
    // subsequent attach from `detached`, PaneStream replays its cached
    // `lastSeed` synchronously — see the cache-and-reuse fast path in
    // `src/stream/pane-stream.ts attach()`. The cache is invalidated by
    // 'reconnected' and by output arriving while detached (which would
    // make the cached screen stale); neither happens in this loop, so
    // the count stays at 1.
    for (let i = 2; i <= REMOUNT_COUNT; i++) {
      const sink = new BufferingSink();
      stream.attach(sink);
      await flushSeed();
      stream.detach();
    }

    expect(
      client.capturePaneCount(),
      `mount #1 should have issued exactly 1 capture-pane; total saw ${client.capturePaneCount()}`,
    ).toBe(1);

    stream.dispose();
  });
});
