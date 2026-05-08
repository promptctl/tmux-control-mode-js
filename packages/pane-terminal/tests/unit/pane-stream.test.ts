// packages/pane-terminal/tests/unit/pane-stream.test.ts
//
// Unit coverage for `PaneStream` — state machine transitions, paneId filter,
// activity counter coalescing, and dispose teardown. Bench gates 2/3/5/7
// exercise the same code from a measurement angle; this file asserts the
// behavioural contract directly.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { FakeTmuxClient } from "../../src/bench/index.js";
import { PaneStream } from "../../src/stream/index.js";
import type { PaneStreamClient, TerminalSink } from "../../src/stream/index.js";
import type { SeedCursor } from "../../src/sink/index.js";

class RecordingSink implements TerminalSink {
  readonly events: string[] = [];
  readonly writes: Uint8Array[] = [];
  private visible = true;
  seed(text: string, cursor: SeedCursor | null): void {
    this.events.push(
      `seed(${text.length} chars, cursor=${JSON.stringify(cursor)})`,
    );
  }
  write(bytes: Uint8Array): void {
    this.events.push(`write(${bytes.byteLength}B)`);
    this.writes.push(bytes);
  }
  resize(cols: number, rows: number): void {
    this.events.push(`resize(${cols}x${rows})`);
  }
  clear(): void {
    this.events.push("clear");
  }
  isVisible(): boolean {
    return this.visible;
  }
  setVisible(v: boolean): void {
    this.visible = v;
  }
  dispose(): void {
    this.events.push("dispose");
  }
}

const PANE_ID = 7;

function makeStream(
  opts: {
    client?: FakeTmuxClient;
    paneId?: number;
    capture?: string;
    cursor?: string;
  } = {},
): {
  client: FakeTmuxClient;
  stream: PaneStream;
} {
  const client = opts.client ?? new FakeTmuxClient();
  client.setCapturePaneResponse((cmd) => {
    if (cmd.startsWith("display-message")) return opts.cursor ?? "0;0";
    return opts.capture ?? "";
  });
  const stream = new PaneStream({
    client: client as unknown as PaneStreamClient,
    paneId: opts.paneId ?? PANE_ID,
  });
  return { client, stream };
}

async function flushTicks(n = 4): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
}

describe("PaneStream — state machine", () => {
  it("starts in 'idle'", () => {
    const { stream } = makeStream();
    expect(stream.state).toBe("idle");
  });

  it("attach() → 'seeding' → 'live' (synchronous transition after seed resolves)", async () => {
    const { stream } = makeStream();
    const sink = new RecordingSink();
    const states: string[] = [];
    stream.on("state-changed", (s) => states.push(s));
    stream.attach(sink);
    expect(stream.state).toBe("seeding");
    await flushTicks();
    expect(stream.state).toBe("live");
    expect(states).toEqual(["seeding", "live"]);
  });

  it("seed() drains buffered live bytes BEFORE flipping to live", async () => {
    const { client, stream } = makeStream();
    const sink = new RecordingSink();
    stream.attach(sink);
    // Inject TWO bytes during the seeding window (capture is in flight).
    client.injectOutput(PANE_ID, new Uint8Array([0x41]));
    client.injectOutput(PANE_ID, new Uint8Array([0x42]));
    await flushTicks();
    // Sink received: seed first, then the buffered writes in order.
    const order = sink.events.filter(
      (e) => e.startsWith("seed") || e.startsWith("write"),
    );
    expect(order[0]).toMatch(/^seed/);
    expect(order[1]).toBe("write(1B)");
    expect(order[2]).toBe("write(1B)");
    expect(sink.writes.map((w) => w[0])).toEqual([0x41, 0x42]);
  });

  it("detach() → 'detached'; attach() again replays the cached seed without a fresh capture-pane", async () => {
    const { client, stream } = makeStream({ capture: "first-screen" });
    const sink1 = new RecordingSink();
    stream.attach(sink1);
    await flushTicks();
    expect(client.capturePaneCount()).toBe(1);
    expect(sink1.events.some((e) => e.startsWith("seed"))).toBe(true);

    stream.detach();
    expect(stream.state).toBe("detached");

    // Gate #4 contract: re-attach hands the new sink the cached seed
    // payload synchronously, no tmux round-trip.
    const sink2 = new RecordingSink();
    stream.attach(sink2);
    expect(stream.state).toBe("live"); // synchronous transition
    expect(client.capturePaneCount()).toBe(1); // no new capture
    expect(sink2.events.some((e) => e.startsWith("seed"))).toBe(true);
  });

  it("output arriving while detached invalidates the cached seed", async () => {
    const { client, stream } = makeStream({ capture: "first-screen" });
    const sink1 = new RecordingSink();
    stream.attach(sink1);
    await flushTicks();
    expect(client.capturePaneCount()).toBe(1);

    stream.detach();
    expect(stream.state).toBe("detached");

    // Bytes arrive for our pane while detached. PaneStream cannot buffer
    // them (would blow gate-3 memory budgets), but it can — and must —
    // mark the cached seed as stale so the next attach issues a fresh
    // capture-pane instead of painting a screen that's missing the
    // intervening output.
    client.injectOutput(7, new Uint8Array([0x41, 0x42]));

    const sink2 = new RecordingSink();
    stream.attach(sink2);
    expect(stream.state).toBe("seeding"); // slow path, not the cached fast path
    await flushTicks();
    expect(stream.state).toBe("live");
    expect(client.capturePaneCount()).toBe(2);
  });

  it("a failed seed is NOT cached; the next attach retries capture-pane", async () => {
    const { client, stream } = makeStream();
    // Make execute() reject so the seed Promise.all throws.
    client.setCapturePaneResponse(() => {
      throw new Error("simulated capture failure");
    });

    const sink1 = new RecordingSink();
    stream.attach(sink1);
    await flushTicks();
    // State still flips to live (better than wedging), but with empty seed.
    expect(stream.state).toBe("live");
    stream.detach();

    // Now wire a working capture, re-attach. The cache must be empty so
    // attach takes the slow path and recovers.
    client.setCapturePaneResponse((cmd) =>
      cmd.startsWith("display-message") ? "0;0" : "recovered",
    );
    const baselineCaptures = client.capturePaneCount();

    const sink2 = new RecordingSink();
    stream.attach(sink2);
    expect(stream.state).toBe("seeding"); // slow path proves cache was empty
    await flushTicks();
    expect(stream.state).toBe("live");
    expect(client.capturePaneCount()).toBeGreaterThan(baselineCaptures);
  });

  it("'reconnected' invalidates the cached seed; the next attach re-issues capture-pane", async () => {
    const { client, stream } = makeStream({ capture: "first-screen" });
    const sink1 = new RecordingSink();
    stream.attach(sink1);
    await flushTicks();
    expect(client.capturePaneCount()).toBe(1);
    stream.detach();

    // Drive a reconnect — PaneStream's onReconnected drops the cached seed.
    client.setConnectionState({ status: "reconnecting", attempt: 1 });
    client.setConnectionState({ status: "ready" });

    const sink2 = new RecordingSink();
    stream.attach(sink2);
    expect(stream.state).toBe("seeding");
    await flushTicks();
    expect(stream.state).toBe("live");
    expect(client.capturePaneCount()).toBe(2); // fresh capture after reconnect
  });

  it("dispose() → 'disposed' and is idempotent", () => {
    const { stream } = makeStream();
    stream.dispose();
    expect(stream.state).toBe("disposed");
    stream.dispose(); // no throw
    expect(stream.state).toBe("disposed");
  });

  it("dispose() during seeding cleans up without flipping to live", async () => {
    const { stream } = makeStream();
    const sink = new RecordingSink();
    stream.attach(sink);
    expect(stream.state).toBe("seeding");
    stream.dispose();
    await flushTicks();
    expect(stream.state).toBe("disposed");
    // Sink must NOT have been seeded after dispose.
    expect(sink.events.some((e) => e.startsWith("seed"))).toBe(false);
  });
});

describe("PaneStream — paneId filter & dataflow", () => {
  it("ignores output for other panes (no sink writes, no activity bump)", async () => {
    const { client, stream } = makeStream();
    const sink = new RecordingSink();
    stream.attach(sink);
    await flushTicks();
    const baselineActivity = stream.activity.bytesSinceLastAttach;

    client.injectOutput(PANE_ID + 1, new Uint8Array([1, 2, 3, 4]));
    client.injectOutput(PANE_ID + 2, new Uint8Array([5, 6]));

    expect(sink.writes).toHaveLength(0);
    expect(stream.activity.bytesSinceLastAttach).toBe(baselineActivity);
  });

  it("forwards live bytes by reference (no copy in the live path)", async () => {
    const { client, stream } = makeStream();
    const sink = new RecordingSink();
    stream.attach(sink);
    await flushTicks();
    const buf = new Uint8Array([9, 8, 7]);
    client.injectOutput(PANE_ID, buf);
    expect(sink.writes[0]).toBe(buf);
  });
});

describe("PaneStream — activity counter coalescing", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("emits 'activity-changed' at most once per throttle window", async () => {
    vi.useRealTimers();
    const { client, stream } = makeStream();
    const sink = new RecordingSink();
    stream.attach(sink);
    await flushTicks();
    const events: number[] = [];
    stream.on("activity-changed", (a) => events.push(a.bytesSinceLastAttach));
    // 10 byte injections inside the same throttle window.
    for (let i = 0; i < 10; i++) {
      client.injectOutput(PANE_ID, new Uint8Array([0x41]));
    }
    // Counter is updated synchronously even though the event hasn't fired.
    expect(stream.activity.bytesSinceLastAttach).toBe(10);
    // Wait past the 100ms default throttle window.
    await new Promise((r) => setTimeout(r, 150));
    // Exactly ONE activity-changed should have fired, with the final count.
    expect(events).toEqual([10]);
  });

  it("subsequent writes after the flush schedule a new flush", async () => {
    vi.useRealTimers();
    const { client, stream } = makeStream();
    stream.attach(new RecordingSink());
    await flushTicks();
    const events: number[] = [];
    stream.on("activity-changed", (a) => events.push(a.bytesSinceLastAttach));

    client.injectOutput(PANE_ID, new Uint8Array([1]));
    await new Promise((r) => setTimeout(r, 150));
    client.injectOutput(PANE_ID, new Uint8Array([1, 2]));
    await new Promise((r) => setTimeout(r, 150));

    expect(events).toEqual([1, 3]);
  });
});
