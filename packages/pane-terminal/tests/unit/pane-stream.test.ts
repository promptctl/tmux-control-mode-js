// packages/pane-terminal/tests/unit/pane-stream.test.ts
//
// Unit coverage for `PaneStream` — state machine transitions, paneId filter,
// activity counter coalescing, and dispose teardown. Bench gates 2/3/5/7
// exercise the same code from a measurement angle; this file asserts the
// behavioural contract directly.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { FakeTmuxClient } from "../../src/bench/index.js";
import { PaneStream } from "../../src/stream/index.js";
import type { TerminalSink } from "../../src/sink/index.js";
import type { SeedCursor } from "../../src/sink/index.js";

class RecordingSink implements TerminalSink {
  readonly events: string[] = [];
  readonly writes: Uint8Array[] = [];
  readonly seedTexts: string[] = [];
  private visible = true;
  seed(captured: Uint8Array, cursor: SeedCursor | null): void {
    // seed carries raw bytes (same kind as write); decode Latin-1 (lossless
    // for the ASCII fixtures these tests use) for human-readable assertions.
    const text = new TextDecoder("latin1").decode(captured);
    this.seedTexts.push(text);
    this.events.push(
      `seed(${captured.byteLength} bytes, cursor=${JSON.stringify(cursor)})`,
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
    client,
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

  it("capture-pane trailing newline does not produce a trailing \\r\\n in the seed text", async () => {
    // capture-pane -p always appends a trailing \n after the last row. The
    // parser splits on \n, producing a spurious "" tail. Joining with that
    // element emits a trailing \r\n that scrolls xterm up one line, putting
    // the subsequent CUP one row too low. Stripping the trailer is the fix;
    // this test locks it in place.
    const { stream } = makeStream({ capture: "row-0\nrow-1\n" });
    const sink = new RecordingSink();
    stream.attach(sink);
    await flushTicks();
    expect(stream.state).toBe("live");
    expect(sink.seedTexts).toHaveLength(1);
    expect(sink.seedTexts[0]).toBe("row-0\r\nrow-1");
    expect(sink.seedTexts[0]?.endsWith("\r\n")).toBe(false);
  });

  it("normalizes the seed to exactly pane_height rows so the cursor aligns", async () => {
    // Regression: tmux's capture-pane elides trailing blank rows, and the
    // boundary between a real blank bottom row and the trailing-\n artifact is
    // ambiguous. A short seed leaves xterm's bottom-anchored viewport pulling
    // a scrollback row into view, rendering the cursor one row above its true
    // position. PaneStream pads trailing blank rows back up to the true grid
    // height (history rows + pane_height) so the visible screen is exactly
    // pane_height rows. State line: cursor_x;cursor_y;...flags;pane_height;
    // history_size — here 8 rows, no scrollback, cursor on visible row 1.
    const { stream } = makeStream({
      capture: "AA\nBB", // two content rows; trailing 6 blanks elided by tmux
      cursor: "0;1;0;1;0;0;0;1;8;0",
    });
    const sink = new RecordingSink();
    stream.attach(sink);
    await flushTicks();
    expect(stream.state).toBe("live");
    // The seed must carry exactly 8 rows — AA, BB, then 6 padded blank rows
    // (rows 2–7). The row COUNT is the invariant the cursor alignment needs.
    // Row 0 carries the autowrap preamble prefix; the 6th padded blank (row 7)
    // carries the trailing mode epilogue, so only rows 2–6 are asserted as
    // pure empties and row 7 is asserted to be blank-but-for the epilogue.
    const rows = sink.seedTexts[0]?.split("\r\n") ?? [];
    expect(rows).toHaveLength(8);
    expect(rows[0]?.endsWith("AA")).toBe(true);
    expect(rows[1]).toBe("BB");
    expect(rows.slice(2, 7)).toEqual(["", "", "", "", ""]);
    // Row 7 is the final padded blank; its only content is the mode epilogue
    // (an ESC sequence), never seeded grid text.
    expect(rows[7]?.startsWith("\x1b")).toBe(true);
  });

  it("seed preamble emits ?1049l + CUP home for main-screen pane (alternate_on=0)", async () => {
    // Regression: the original preamble emitted nothing for alternate_on=0,
    // so a reseed on a terminal still in alt screen drew content into the
    // wrong buffer. The fix emits ?1049l (exit alt screen) + CUP home before
    // any screen content so the correct screen and cursor row are established
    // deterministically, even on a reconnect reseed.
    const { stream } = makeStream({
      capture: "row-0\nrow-1",
      // alternate_on=0, cursor visible, no insert/keypad, autowrap, 3 rows
      cursor: "0;0;0;1;0;0;0;1;3;0",
    });
    const sink = new RecordingSink();
    stream.attach(sink);
    await flushTicks();
    expect(stream.state).toBe("live");
    const text = sink.seedTexts[0] ?? "";
    expect(text.startsWith("\x1b[?1049l\x1b[H")).toBe(true);
  });

  it("seed preamble emits ?1049h + CUP home for alt-screen pane (alternate_on=1)", async () => {
    const { stream } = makeStream({
      capture: "alt-row-0\nalt-row-1",
      cursor: "0;0;1;1;0;0;0;1;3;0", // alternate_on=1
    });
    const sink = new RecordingSink();
    stream.attach(sink);
    await flushTicks();
    expect(stream.state).toBe("live");
    const text = sink.seedTexts[0] ?? "";
    expect(text.startsWith("\x1b[?1049h\x1b[H")).toBe(true);
  });

  it("reseed from alt screen to main screen: preamble switches screen buffer", async () => {
    // The critical reseed-from-alt regression: the XtermSink terminal was
    // left in alt screen after an alt-screen seed; a subsequent reconnect
    // reseed for a main-screen pane must emit ?1049l + CUP so the seed
    // content lands on the main screen at row 0, not mid-alt-screen.
    const client = new FakeTmuxClient();
    client.setCapturePaneResponse((cmd) =>
      cmd.startsWith("display-message")
        ? "0;0;1;1;0;0;0;1;3;0" // alt=1
        : "alt-content",
    );
    const stream = new PaneStream({ client, paneId: PANE_ID });

    const sink1 = new RecordingSink();
    stream.attach(sink1);
    await flushTicks();
    expect(stream.state).toBe("live");
    // First seed established alt screen.
    expect(sink1.seedTexts[0]?.startsWith("\x1b[?1049h\x1b[H")).toBe(true);
    stream.detach();

    // Reconnect: pane is now on main screen.
    client.setCapturePaneResponse((cmd) =>
      cmd.startsWith("display-message")
        ? "0;0;0;1;0;0;0;1;3;0" // alt=0
        : "main-content",
    );
    client.setConnectionState({ status: "reconnecting", attempt: 1 });
    client.setConnectionState({ status: "ready" });

    const sink2 = new RecordingSink();
    stream.attach(sink2);
    expect(stream.state).toBe("seeding");
    await flushTicks();
    expect(stream.state).toBe("live");
    // Reseed must exit alt screen and home cursor before drawing main content.
    expect(sink2.seedTexts[0]?.startsWith("\x1b[?1049l\x1b[H")).toBe(true);
  });

  it("dispose() → 'disposed' and is idempotent", () => {
    const { stream } = makeStream();
    stream.dispose();
    expect(stream.state).toBe("disposed");
    stream.dispose(); // no throw
    expect(stream.state).toBe("disposed");
  });

  it("attach during in-flight seed coalesces — second attach reuses the same capture-pane", async () => {
    // Models the React StrictMode mount→cleanup→remount sequence: the
    // second attach lands BEFORE the first capture-pane resolves. PaneStream
    // must not issue a second RPC.
    const { client, stream } = makeStream({ capture: "scrollback" });
    const sink1 = new RecordingSink();
    const sink2 = new RecordingSink();

    stream.attach(sink1);
    expect(stream.state).toBe("seeding");
    expect(client.capturePaneCount()).toBe(1);

    // Detach before the seed RPC resolves — its setTimeout(0) hasn't fired yet.
    stream.detach();
    expect(stream.state).toBe("detached");

    // Re-attach with a different sink. PaneStream must NOT issue a second
    // capture-pane: the in-flight one will pick up `this.sink` when it
    // resolves and seed sink2 directly.
    stream.attach(sink2);
    expect(stream.state).toBe("seeding");
    expect(client.capturePaneCount()).toBe(1); // still 1 — coalesced

    await flushTicks();
    expect(stream.state).toBe("live");
    expect(client.capturePaneCount()).toBe(1);
    // sink1 was orphaned by detach() before the seed resolved; only sink2
    // ever received the snapshot.
    expect(sink1.events.filter((e) => e.startsWith("seed("))).toHaveLength(0);
    expect(sink2.events.filter((e) => e.startsWith("seed("))).toHaveLength(1);
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

  it("stale mid-flight seed clears the buffer before reissuing capture-pane", async () => {
    // Regression: detach while seed1 is pending → bytes arrive while detached
    // (lastSeed dropped, seedStaleMidFlight = true) → reattach (state →
    // seeding under the still-pending seed1) → more bytes arrive and are
    // pushed to the seed buffer → seed1 resolves stale and starts seed cycle 2.
    // Those buffered bytes are also in seed2's snapshot, so the buffer MUST be
    // cleared before the new capture-pane is issued — otherwise they get
    // replayed after seed2 and duplicate the on-screen output.
    const { client, stream } = makeStream({ capture: "second-screen" });
    const sink1 = new RecordingSink();
    const sink2 = new RecordingSink();

    stream.attach(sink1);
    expect(stream.state).toBe("seeding");
    expect(client.capturePaneCount()).toBe(1);

    // Detach before seed1 resolves; inject bytes to mark the seed stale.
    stream.detach();
    expect(stream.state).toBe("detached");
    client.injectOutput(PANE_ID, new Uint8Array([0x41, 0x42]));

    // Reattach — seed1 is still in flight, so PaneStream short-circuits to
    // 'seeding' without issuing a second RPC yet.
    stream.attach(sink2);
    expect(stream.state).toBe("seeding");
    expect(client.capturePaneCount()).toBe(1);

    // These bytes arrive during the second seeding window and would be
    // pushed to the buffer. seed2's snapshot will also contain them, so
    // replaying the buffer after seed2 would duplicate them on screen.
    client.injectOutput(PANE_ID, new Uint8Array([0x43, 0x44]));

    // Let seed1 resolve (sees stale → clears buffer → starts seed2) and then
    // seed2 resolve (drains the now-empty buffer → seeds sink2 → goes live).
    await flushTicks();
    expect(stream.state).toBe("live");
    expect(client.capturePaneCount()).toBe(2);

    // sink2 received exactly one seed (from seed2's snapshot) and ZERO writes
    // — the bytes that landed during the second seeding window were not
    // replayed, because seed2's capture already includes them.
    expect(sink2.events.filter((e) => e.startsWith("seed("))).toHaveLength(1);
    expect(sink2.writes).toHaveLength(0);
  });

  it("sendKeys('') is a no-op: resolves success without issuing a command", async () => {
    // Zero keys has no valid wire form (send-keys -H with no bytes errors).
    // The empty send must short-circuit to the synthetic no-op response
    // (commandNumber -1) rather than building a malformed command.
    const { stream } = makeStream();
    const res = await stream.sendKeys("");
    expect(res.success).toBe(true);
    expect(res.commandNumber).toBe(-1);
  });

  it("sendKeys forwards the FULL encoded wire — no trailing-char truncation", async () => {
    // Regression: a prior version called `client.execute(wire.slice(0, -1))`,
    // believing the encoder appended a trailing LF to strip. encodeSendKeys
    // emits NO trailing LF (execute() is the sole LF-terminator), so the slice
    // dropped the final HEX DIGIT — turning "A" (send-keys … 41) into … 4,
    // i.e. byte 0x04 (Ctrl-D). Every keystroke's last byte was corrupted into a
    // stray control code; against a shell that exits on EOF this killed the
    // session outright. Assert the exact, untruncated wire reaches execute().
    const { client, stream } = makeStream();
    const seen: string[] = [];
    client.setCapturePaneResponse((cmd) => {
      seen.push(cmd);
      return cmd.startsWith("display-message") ? "0;0" : "";
    });
    await stream.sendKeys("A");
    expect(seen.find((c) => c.startsWith("send-keys"))).toBe(
      `send-keys -H -t '%${PANE_ID}' 41`,
    );
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
