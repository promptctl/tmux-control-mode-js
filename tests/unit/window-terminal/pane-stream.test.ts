// tests/unit/window-terminal/pane-stream.test.ts
//
// Unit coverage for `PaneStream` — state machine transitions, paneId filter,
// activity counter coalescing, and dispose teardown. Bench gates 2/3/5/7
// exercise the same code from a measurement angle; this file asserts the
// behavioural contract directly.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { FakeTmuxClient } from "../../helpers/fake-tmux-client.js";
import { seedStateLine } from "../../helpers/seed-state.js";
import { PaneStream } from "../../../src/window-terminal/engine/pane-stream.js";
import type {
  PaneActivity,
  PaneStreamError,
  PaneStreamState,
} from "../../../src/window-terminal/engine/pane-stream.js";
import type { TerminalSink } from "../../../src/window-terminal/engine/terminal-sink.js";
import {
  TmuxCommandError,
  TmuxProtocolError,
  TmuxReplyFormatError,
  TransportClosedError,
  TransportSendError,
} from "../../../src/browser.js";
import { BridgeError } from "../../../src/connectors/errors.js";

// A live-tmux command failure (tmux replied %error). `reportError` must SURFACE
// this class — tmux was alive, so the blank pane is a real failure.
const tmuxError = (line: string): TmuxCommandError =>
  new TmuxCommandError({
    commandNumber: 1,
    timestamp: 0,
    output: [line],
    success: false,
  });

// `refresh-client -B 'name':'what':'format'` subscribes; the bare
// `refresh-client -B 'name'` form unsubscribes.
const isSubscribe = (cmd: string): boolean =>
  /^refresh-client -B '[^']*':/.test(cmd);

class RecordingSink implements TerminalSink {
  readonly events: string[] = [];
  readonly writes: Uint8Array[] = [];
  readonly seedTexts: string[] = [];
  private visible = true;
  seed(captured: Uint8Array, trailing: readonly Uint8Array[]): void {
    // seed carries raw bytes (same kind as write); decode Latin-1 (lossless
    // for the ASCII fixtures these tests use) for human-readable assertions.
    const text = new TextDecoder("latin1").decode(captured);
    this.seedTexts.push(text);
    this.events.push(`seed(${captured.byteLength} bytes)`);
    // Trailing live bytes are applied after the snapshot, in order — record
    // them as the same behavioral write events a renderer would emit.
    for (const chunk of trailing) this.write(chunk);
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
    state?: string;
  } = {},
): {
  client: FakeTmuxClient;
  stream: PaneStream;
} {
  const client = opts.client ?? new FakeTmuxClient();
  client.setExecuteResponse((cmd) => {
    if (cmd.startsWith("display-message")) return opts.state ?? seedStateLine();
    return opts.capture ?? "";
  });
  const stream = new PaneStream({
    client,
    paneId: opts.paneId ?? PANE_ID,
  });
  return { client, stream };
}

// The pane prints `data` just after tmux begins its next capture's reply:
// behind that capture. (Bytes injected before it, tmux parsed into the grid
// before the capture ran.)
function printAfterNextBegin(client: FakeTmuxClient, data: Uint8Array): void {
  const once = (ev: { commandNumber: number }): void => {
    if (!client.commandNumbered(ev.commandNumber).startsWith("capture-pane"))
      return;
    client.off("begin", once);
    client.injectOutput(PANE_ID, data);
  };
  client.on("begin", once);
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
    // TWO chunks the pane prints after the capture ran.
    printAfterNextBegin(client, new Uint8Array([0x41]));
    printAfterNextBegin(client, new Uint8Array([0x42]));
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

  it("output a live sink received invalidates the cached seed", async () => {
    // The cache is the pane's picture as of its capture; a live byte moves
    // the pane past it, so a later sink must not be handed the older screen.
    const { client, stream } = makeStream({ capture: "first-screen" });
    stream.attach(new RecordingSink());
    await flushTicks();
    client.injectOutput(7, new Uint8Array([0x41]));
    stream.detach();

    stream.attach(new RecordingSink());
    expect(stream.state).toBe("seeding");
    await flushTicks();
    expect(client.capturePaneCount()).toBe(2);
  });

  it("bytes the pane printed before the capture's begin are not drawn again", async () => {
    // tmux parsed them into the grid before it ran the capture: the snapshot
    // holds them, however late they reach the client.
    const { client, stream } = makeStream({ capture: "first-screen" });
    const sink = new RecordingSink();
    stream.attach(sink);
    client.injectOutput(PANE_ID, new Uint8Array([0x41]));
    await flushTicks();
    expect(stream.state).toBe("live");
    expect(sink.seedTexts).toHaveLength(1);
    expect(sink.writes).toHaveLength(0);
  });

  it("a seed whose capture was followed by trailing bytes is not cached", async () => {
    const { client, stream } = makeStream({ capture: "first-screen" });
    stream.attach(new RecordingSink());
    printAfterNextBegin(client, new Uint8Array([0x41]));
    await flushTicks();
    expect(stream.state).toBe("live");
    stream.detach();

    stream.attach(new RecordingSink());
    expect(stream.state).toBe("seeding");
    await flushTicks();
    expect(client.capturePaneCount()).toBe(2);
  });

  it("a capture that resolves with no sink and bytes behind it is not cached", async () => {
    // The bytes postdate the snapshot, so it is already behind the pane.
    const { client, stream } = makeStream({ capture: "first-screen" });
    stream.attach(new RecordingSink());
    stream.detach();
    printAfterNextBegin(client, new Uint8Array([0x41]));
    await flushTicks();

    stream.attach(new RecordingSink());
    expect(stream.state).toBe("seeding");
    await flushTicks();
    expect(client.capturePaneCount()).toBe(2);
  });

  it("a sink re-attaching mid-capture is seeded with the snapshot, then exactly the bytes after its begin", async () => {
    // StrictMode's mount→cleanup→mount on a printing pane, synchronous: one
    // capture, and the bytes from before the detach are cut at the begin.
    const { client, stream } = makeStream({ capture: "first-screen" });
    stream.attach(new RecordingSink());
    client.injectOutput(PANE_ID, new Uint8Array([0x41]));
    stream.detach();
    const sink = new RecordingSink();
    stream.attach(sink);
    printAfterNextBegin(client, new Uint8Array([0x42]));
    await flushTicks();

    expect(stream.state).toBe("live");
    expect(client.capturePaneCount()).toBe(1);
    expect(sink.seedTexts).toHaveLength(1);
    expect(sink.writes.map((w) => [...w])).toEqual([[0x42]]);
  });

  it("a sink attaching while a capture is in flight waits for it rather than replaying the older cache", async () => {
    const { client, stream } = makeStream({ capture: "first-screen" });
    stream.attach(new RecordingSink());
    await flushTicks();
    void stream.reseed(); // cache still set; a capture is now in flight
    stream.detach();

    const sink = new RecordingSink();
    stream.attach(sink);
    expect(stream.state).toBe("seeding");
    await flushTicks();
    expect(sink.seedTexts).toHaveLength(1);
    expect(client.capturePaneCount()).toBe(2);
  });

  it("a failed capture hands over no seed; the bytes behind it arrive as writes", async () => {
    // A failed capture is no picture of the pane: seeding it would replace
    // what the sink shows with a blank one.
    const { client, stream } = makeStream();
    client.setExecuteFailure((cmd) =>
      cmd.startsWith("capture-pane") ? tmuxError("capture failed") : null,
    );
    const sink = new RecordingSink();
    stream.attach(sink);
    client.injectOutput(7, new Uint8Array([0x41]));
    await flushTicks();

    expect(stream.state).toBe("live");
    expect(sink.events).toEqual(["write(1B)"]);
  });

  it("a state reply with no size fails the capture as a malformed reply", async () => {
    // The capture's own size is the only size a seed is drawn at, so a reply
    // without one is no picture: the bytes go out as writes and the reply is
    // reported, then the next well-formed capture draws and clears it.
    const truncated = "0;0;0;1;0;0;0;1;0;24;0;0;23"; // pane_width missing
    const { client, stream } = makeStream({ state: truncated });
    const sink = new RecordingSink();
    stream.attach(sink);
    client.injectOutput(PANE_ID, new Uint8Array([0x41]));
    await flushTicks();

    expect(stream.state).toBe("live");
    expect(sink.events).toEqual(["write(1B)"]);
    const cause = stream.lastError?.cause;
    expect(stream.lastError?.phase).toBe("seed");
    expect(cause).toBeInstanceOf(TmuxReplyFormatError);
    expect(cause).toMatchObject({ output: [truncated] });
    expect((cause as TmuxReplyFormatError).command).toMatch(
      /^capture-pane .* ; display-message -p -t %7 /,
    );

    client.setExecuteResponse((cmd) =>
      cmd.startsWith("display-message") ? seedStateLine() : "hello",
    );
    void stream.reseed();
    await flushTicks();
    expect(sink.seedTexts).toHaveLength(1);
    expect(stream.lastError).toBeNull();
  });

  it("a failed seed is NOT cached; the next attach retries capture-pane", async () => {
    const { client, stream } = makeStream();
    // Make execute() reject so the seed Promise.all throws.
    client.setExecuteResponse(() => {
      throw new Error("simulated capture failure");
    });

    const sink1 = new RecordingSink();
    stream.attach(sink1);
    await flushTicks();
    // State still flips to live (better than wedging), but with no seed.
    expect(stream.state).toBe("live");
    stream.detach();

    // Now wire a working capture, re-attach. The cache must be empty so
    // attach takes the slow path and recovers.
    client.setExecuteResponse((cmd) =>
      cmd.startsWith("display-message") ? seedStateLine() : "recovered",
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
    // A two-row pane: the trailer kept would make the seed three rows.
    const { stream } = makeStream({
      capture: "row-0\nrow-1\n",
      state: seedStateLine({ rows: 2 }),
    });
    const sink = new RecordingSink();
    stream.attach(sink);
    await flushTicks();
    expect(stream.state).toBe("live");
    expect(sink.seedTexts).toHaveLength(1);
    const rows = sink.seedTexts[0]?.split("\r\n") ?? [];
    expect(rows).toHaveLength(2);
    expect(rows[1]?.startsWith("row-1\x0f")).toBe(true);
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
      state: seedStateLine({ rows: 8, cursor: { col: 0, row: 1 } }),
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
    // BB is the capture's last row: SI and SGR 0 end its shift and pen.
    expect(rows[1]).toBe("BB\x0f\x1b[0m");
    expect(rows.slice(2, 7)).toEqual(["", "", "", "", ""]);
    // Row 7 is the final padded blank; its only content is the mode epilogue
    // (an ESC sequence), never seeded grid text.
    expect(rows[7]?.startsWith("\x1b")).toBe(true);
  });

  it("seed preamble opens with ?1049l for main-screen pane (alternate_on=0)", async () => {
    // Regression: the original preamble emitted nothing for alternate_on=0,
    // so a reseed on a terminal still in alt screen drew content into the
    // wrong buffer. The seed now opens with ?1049l (exit alt screen), so the
    // content lands in the main buffer even on a reconnect reseed. What the
    // clear after it does is seed-builder.test's to check.
    const { stream } = makeStream({
      capture: "row-0\nrow-1",
      // alternate_on=0, cursor visible, no insert/keypad, autowrap, 3 rows
      state: seedStateLine({ rows: 3 }),
    });
    const sink = new RecordingSink();
    stream.attach(sink);
    await flushTicks();
    expect(stream.state).toBe("live");
    const text = sink.seedTexts[0] ?? "";
    expect(text.startsWith("\x1b[?1049l")).toBe(true);
  });

  it("seed preamble opens with ?1049h for alt-screen pane (alternate_on=1)", async () => {
    const { stream } = makeStream({
      capture: "alt-row-0\nalt-row-1",
      state: seedStateLine({ rows: 3, alternate: true }),
    });
    const sink = new RecordingSink();
    stream.attach(sink);
    await flushTicks();
    expect(stream.state).toBe("live");
    const text = sink.seedTexts[0] ?? "";
    expect(text.startsWith("\x1b[?1049h")).toBe(true);
  });

  it("reseed from alt screen to main screen: preamble switches screen buffer", async () => {
    // The critical reseed-from-alt regression: the XtermSink terminal was
    // left in alt screen after an alt-screen seed; a subsequent reconnect
    // reseed for a main-screen pane must emit ?1049l + CUP so the seed
    // content lands on the main screen at row 0, not mid-alt-screen.
    const client = new FakeTmuxClient();
    client.setExecuteResponse((cmd) =>
      cmd.startsWith("display-message")
        ? seedStateLine({ rows: 3, alternate: true })
        : "alt-content",
    );
    const stream = new PaneStream({ client, paneId: PANE_ID });

    const sink1 = new RecordingSink();
    stream.attach(sink1);
    await flushTicks();
    expect(stream.state).toBe("live");
    // First seed established alt screen.
    expect(sink1.seedTexts[0]?.startsWith("\x1b[?1049h")).toBe(true);
    stream.detach();

    // Reconnect: pane is now on main screen.
    client.setExecuteResponse((cmd) =>
      cmd.startsWith("display-message")
        ? seedStateLine({ rows: 3 })
        : "main-content",
    );
    client.setConnectionState({ status: "reconnecting", attempt: 1 });
    client.setConnectionState({ status: "ready" });

    const sink2 = new RecordingSink();
    stream.attach(sink2);
    expect(stream.state).toBe("seeding");
    await flushTicks();
    expect(stream.state).toBe("live");
    // Reseed must exit alt screen before drawing main content.
    expect(sink2.seedTexts[0]?.startsWith("\x1b[?1049l")).toBe(true);
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

  it("a capture the pane changed under is retaken, and the retake draws only the bytes after its own begin", async () => {
    // The pane prints a fresh byte as tmux begins each reply. Every byte
    // before the retake's begin is in the retake's snapshot; drawing any of
    // them again would double it on screen.
    const { client, stream } = makeStream({ capture: "second-screen" });
    const printed: number[] = [];
    client.on("begin", () => {
      const byte = 0x41 + printed.length;
      printed.push(byte);
      client.injectOutput(PANE_ID, new Uint8Array([byte]));
    });
    const sink = new RecordingSink();
    stream.attach(sink);
    // The pane changed under the capture in flight (a new size, `%continue`).
    client.injectNotification({ type: "continue", paneId: PANE_ID });

    await flushTicks(8);
    expect(stream.state).toBe("live");
    expect(client.capturePaneCount()).toBe(2);
    expect(sink.seedTexts).toHaveLength(1);
    expect(sink.writes.map((w) => [...w])).toEqual([[printed.at(-1)]]);
  });

  it("seeds over a connection that announces the reply's begin inside execute()", async () => {
    const client = new FakeTmuxClient();
    client.setBeginAnnounced("in-execute");
    const { stream } = makeStream({ client, capture: "first-screen" });
    const sink = new RecordingSink();
    stream.attach(sink);
    await flushTicks();
    expect(stream.state).toBe("live");
    expect(stream.lastError).toBeNull();
    expect(sink.seedTexts).toHaveLength(1);
  });

  it("a reply that outruns its begin fails the seed loudly and goes live with every buffered byte", async () => {
    const client = new FakeTmuxClient();
    client.setBeginAnnounced("never");
    const { stream } = makeStream({ client, capture: "first-screen" });
    const sink = new RecordingSink();
    stream.attach(sink);
    client.injectOutput(PANE_ID, new Uint8Array([0x41]));
    await flushTicks();
    expect(stream.state).toBe("live");
    expect(stream.lastError).toMatchObject({
      phase: "seed",
      cause: { message: expect.stringMatching(/resolved before its %begin/) },
    });
    expect(sink.seedTexts).toHaveLength(0);
    expect(sink.writes.map((w) => [...w])).toEqual([[0x41]]);
  });

  it("dispose mid-capture settles the capture and reports nothing", async () => {
    const { stream } = makeStream({ capture: "first-screen" });
    stream.attach(new RecordingSink());
    await flushTicks();
    const reseed = stream.reseed();
    stream.dispose();
    await reseed;
    expect(stream.lastError).toBeNull();
  });

  it("sendKeyBytes(no bytes) is a no-op: resolves success without issuing a command", async () => {
    // Zero keys has no valid wire form (send-keys -H with no bytes errors).
    // The empty send must short-circuit to the synthetic no-op response
    // (commandNumber -1) rather than building a malformed command.
    const { stream } = makeStream();
    const res = await stream.sendKeyBytes(new Uint8Array());
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
    client.setExecuteResponse((cmd) => {
      seen.push(cmd);
      return cmd.startsWith("display-message") ? seedStateLine() : "";
    });
    await stream.sendKeyBytes(new Uint8Array([0x41]));
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

// ---------------------------------------------------------------------------
// kwv.3 — subscribe/seed effect failures are observable, not blank screens.
// Both seams flow through client.execute(); the fake's setExecuteFailure knob
// scripts a rejection per command. reportError classifies by error CLASS: a
// live-tmux failure surfaces on the 'error' seam; a connection-gone failure is
// the quiet, reconnect-re-driven case.
// ---------------------------------------------------------------------------

describe("PaneStream — seam failure observability (kwv.3)", () => {
  it("a failed pane-size subscribe surfaces on lastError and the 'error' event", async () => {
    vi.useRealTimers();
    const client = new FakeTmuxClient();
    client.setExecuteFailure((cmd) =>
      isSubscribe(cmd) ? tmuxError("no such pane") : null,
    );
    const errors: PaneStreamError[] = [];
    // The subscribe fires in the constructor; a listener attached synchronously
    // after construction still catches the async rejection, and lastError is
    // retained for a consumer that subscribes even later.
    const stream = new PaneStream({ client, paneId: PANE_ID });
    stream.on("error", (e) => errors.push(e));
    await flushTicks();

    expect(stream.lastError?.phase).toBe("subscribe");
    expect(stream.lastError?.paneId).toBe(PANE_ID);
    expect(errors.map((e) => e.phase)).toEqual(["subscribe"]);
    stream.dispose();
  });

  it("a connection-gone subscribe failure stays quiet (reconnect re-drives it)", async () => {
    vi.useRealTimers();
    const client = new FakeTmuxClient();
    client.setExecuteFailure((cmd) =>
      isSubscribe(cmd) ? new TransportClosedError("socket closed") : null,
    );
    const errors: PaneStreamError[] = [];
    const stream = new PaneStream({ client, paneId: PANE_ID });
    stream.on("error", (e) => errors.push(e));
    await flushTicks();

    expect(stream.lastError).toBeNull();
    expect(errors).toEqual([]);
    stream.dispose();
  });

  it("a TransportSendError subscribe failure also stays quiet (the other no-live-connection class)", async () => {
    // isConnectionGone classifies BOTH TransportClosedError and
    // TransportSendError as quiet; this pins the TransportSendError branch so a
    // silent removal of it would fail here.
    vi.useRealTimers();
    const client = new FakeTmuxClient();
    client.setExecuteFailure((cmd) =>
      isSubscribe(cmd)
        ? new TransportSendError("transport refused the send")
        : null,
    );
    const errors: PaneStreamError[] = [];
    const stream = new PaneStream({ client, paneId: PANE_ID });
    stream.on("error", (e) => errors.push(e));
    await flushTicks();

    expect(stream.lastError).toBeNull();
    expect(errors).toEqual([]);
    stream.dispose();
  });

  it("a closed bridge (BRIDGE_CLOSED) is connection-gone too; another bridge error surfaces", async () => {
    vi.useRealTimers();
    const client = new FakeTmuxClient();
    client.setExecuteFailure((cmd) =>
      isSubscribe(cmd)
        ? new BridgeError("BRIDGE_CLOSED", "socket dropped")
        : cmd.startsWith("capture-pane")
          ? new BridgeError("BRIDGE_TIMEOUT", "slow")
          : null,
    );
    const errors: PaneStreamError[] = [];
    const stream = new PaneStream({ client, paneId: PANE_ID });
    stream.on("error", (e) => errors.push(e));
    stream.attach(new RecordingSink());
    await flushTicks();
    expect(errors.map((e) => e.phase)).toEqual(["seed"]);
    stream.dispose();
  });

  it("dispose's unsubscribe is done when the name holds no subscription; a live tmux refusal surfaces", async () => {
    vi.useRealTimers();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const isUnsubscribe = (cmd: string): boolean =>
        /^refresh-client -B '[^':]*'$/.test(cmd);
      const absent = new FakeTmuxClient();
      // An unsubscribe made during a reconnect reaches a bridge peer that
      // never held the name.
      absent.setExecuteFailure((cmd) =>
        isUnsubscribe(cmd)
          ? new BridgeError("BRIDGE_UNKNOWN_SUBSCRIPTION", "not owned")
          : null,
      );
      new PaneStream({ client: absent, paneId: PANE_ID }).dispose();

      // A dispose while the connection is down: the subscription went with it.
      const gone = new FakeTmuxClient();
      gone.setExecuteFailure((cmd) =>
        isUnsubscribe(cmd) ? new TransportClosedError("socket closed") : null,
      );
      new PaneStream({ client: gone, paneId: PANE_ID }).dispose();

      const refused = new FakeTmuxClient();
      const refusal = tmuxError("server exited unexpectedly");
      refused.setExecuteFailure((cmd) => (isUnsubscribe(cmd) ? refusal : null));
      new PaneStream({ client: refused, paneId: PANE_ID }).dispose();

      await new Promise((r) => setTimeout(r, 10));
      expect(unhandled).toEqual([refusal]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("a delivered pane size clears an outstanding subscribe failure", async () => {
    // The subscribe seam's recovery point: a subscription-changed carrying a
    // valid size proves the subscription is working, so lastError must clear.
    vi.useRealTimers();
    const client = new FakeTmuxClient();
    client.setExecuteResponse((cmd) =>
      cmd.startsWith("display-message") ? seedStateLine() : "",
    );
    client.setExecuteFailure((cmd) =>
      isSubscribe(cmd) ? tmuxError("no such pane") : null,
    );
    const stream = new PaneStream({ client, paneId: PANE_ID });
    stream.attach(new RecordingSink());
    await flushTicks();
    expect(stream.lastError?.phase).toBe("subscribe");

    // tmux later reports the pane size on the same subscription name.
    client.injectSubscriptionChanged(
      client.subscriptionNamed(`%${PANE_ID}`),
      PANE_ID,
      "80;24",
    );
    expect(stream.lastError).toBeNull();
    stream.dispose();
  });

  it("a failed capture-pane seed surfaces on the 'error' seam yet the stream still goes live", async () => {
    vi.useRealTimers();
    const client = new FakeTmuxClient();
    client.setExecuteFailure((cmd) =>
      cmd.startsWith("capture-pane") ? tmuxError("capture failed") : null,
    );
    const stream = new PaneStream({ client, paneId: PANE_ID });
    const errors: PaneStreamError[] = [];
    stream.on("error", (e) => errors.push(e));
    stream.attach(new RecordingSink());
    await flushTicks();

    expect(errors.map((e) => e.phase)).toEqual(["seed"]);
    expect(stream.lastError?.phase).toBe("seed");
    // Still went live — live bytes must render, not wedge forever in 'seeding'.
    expect(stream.state).toBe("live");
    stream.dispose();
  });

  it("a corrupted-terminator (TmuxProtocolError) seed failure also surfaces", async () => {
    vi.useRealTimers();
    const client = new FakeTmuxClient();
    client.setExecuteFailure((cmd) =>
      cmd.startsWith("capture-pane")
        ? new TmuxProtocolError(1, "%end 2 3") // truncated guard terminator
        : null,
    );
    const stream = new PaneStream({ client, paneId: PANE_ID });
    const errors: PaneStreamError[] = [];
    stream.on("error", (e) => errors.push(e));
    stream.attach(new RecordingSink());
    await flushTicks();

    expect(errors.map((e) => e.phase)).toEqual(["seed"]);
    expect(stream.state).toBe("live");
    stream.dispose();
  });

  it("a connection-gone seed failure stays quiet but still transitions to live", async () => {
    vi.useRealTimers();
    const client = new FakeTmuxClient();
    client.setExecuteFailure((cmd) =>
      cmd.startsWith("capture-pane")
        ? new TransportClosedError("socket closed")
        : null,
    );
    const stream = new PaneStream({ client, paneId: PANE_ID });
    stream.on("error", () => {
      throw new Error("connection-gone seed failure must not surface");
    });
    stream.attach(new RecordingSink());
    await flushTicks();

    expect(stream.lastError).toBeNull();
    expect(stream.state).toBe("live");
    stream.dispose();
  });

  it("recovers after a transient seed failure: a later reseed paints the captured screen", async () => {
    vi.useRealTimers();
    let failCapture = true;
    const client = new FakeTmuxClient();
    client.setExecuteResponse((cmd) =>
      cmd.startsWith("display-message") ? seedStateLine() : "recovered-screen",
    );
    client.setExecuteFailure((cmd) =>
      failCapture && cmd.startsWith("capture-pane")
        ? tmuxError("transient")
        : null,
    );
    const stream = new PaneStream({ client, paneId: PANE_ID });
    const sink = new RecordingSink();
    stream.attach(sink);
    await flushTicks();
    expect(stream.lastError?.phase).toBe("seed");
    expect(stream.state).toBe("live");

    // The transient failure clears; a reseed now succeeds and paints the
    // screen. The failed seed was deliberately not cached, so the retry works.
    failCapture = false;
    await stream.reseed();
    await flushTicks();
    expect(sink.seedTexts.some((t) => t.includes("recovered-screen"))).toBe(
      true,
    );
    // The seed seam recovered, so the pull-model signal must stop reporting the
    // now-moot transient failure (no stale error stranded).
    expect(stream.lastError).toBeNull();
    stream.dispose();
  });

  it("a recovered seed does not mask a still-outstanding subscribe failure", async () => {
    // Two independent seams fail. lastError is per-phase, so recovering one must
    // not erase knowledge of the other — otherwise the epic's own silent
    // failure creeps back in through the pull model.
    vi.useRealTimers();
    let failCapture = true;
    const client = new FakeTmuxClient();
    client.setExecuteResponse((cmd) =>
      cmd.startsWith("display-message") ? seedStateLine() : "screen",
    );
    client.setExecuteFailure((cmd) => {
      // subscribe fails permanently (no pane geometry will ever arrive)...
      if (isSubscribe(cmd)) return tmuxError("no such pane");
      // ...seed fails only transiently.
      if (failCapture && cmd.startsWith("capture-pane")) {
        return tmuxError("transient");
      }
      return null;
    });
    const stream = new PaneStream({ client, paneId: PANE_ID });
    stream.attach(new RecordingSink());
    await flushTicks();
    // Both surfaced; the most-recent (seed) is on top.
    expect(stream.lastError?.phase).toBe("seed");

    // Seed recovers via reseed — but the subscribe seam is still broken.
    failCapture = false;
    await stream.reseed();
    await flushTicks();
    expect(stream.lastError?.phase).toBe("subscribe");

    // dispose() drops the retained error chain.
    stream.dispose();
    expect(stream.lastError).toBeNull();
  });
});

describe("PaneStream — pane-size subscription lifecycle", () => {
  it("two streams of one pane keep separate subscriptions: disposing one leaves the other's", async () => {
    const client = new FakeTmuxClient();
    const a = new PaneStream({ client, paneId: PANE_ID });
    const nameA = client.subscriptionNamed(`%${PANE_ID}`);
    const b = new PaneStream({ client, paneId: PANE_ID });
    const nameB = client.subscriptionNamed(`%${PANE_ID}`);
    expect(nameA).not.toBe(nameB);

    const sink = new RecordingSink();
    b.attach(sink);
    a.dispose();
    await flushTicks();
    const unsubscribes = client
      .commands()
      .filter((c) => /^refresh-client -B '[^']*'$/.test(c));
    expect(unsubscribes).toEqual([`refresh-client -B '${nameA}'`]);

    // b still follows its pane's size.
    const captures = client.capturePaneCount();
    client.injectSubscriptionChanged(nameB, PANE_ID, "100;30");
    await flushTicks();
    expect(client.capturePaneCount()).toBe(captures + 1);
    b.dispose();
  });

  it("subscribes through the connection's subscription methods", () => {
    const client = new FakeTmuxClient();
    const spy = vi.spyOn(client, "subscribeRaw");
    const stream = new PaneStream({ client, paneId: PANE_ID });
    expect(spy).toHaveBeenCalledWith(
      client.subscriptionNamed(`%${PANE_ID}`),
      `%${PANE_ID}`,
      "#{pane_width};#{pane_height}",
    );
    stream.dispose();
  });

  it("re-issues its subscription on 'reconnected'", async () => {
    const client = new FakeTmuxClient();
    const stream = new PaneStream({ client, paneId: PANE_ID });
    const name = client.subscriptionNamed(`%${PANE_ID}`);
    const subscribes = () =>
      client
        .commands()
        .filter((c) => c.startsWith(`refresh-client -B '${name}':`));
    expect(subscribes()).toHaveLength(1);
    client.setConnectionState({ status: "ready" });
    client.setConnectionState({ status: "reconnecting", attempt: 1 });
    client.setConnectionState({ status: "ready" });
    expect(subscribes()).toHaveLength(2);
    stream.dispose();
    await flushTicks();
  });
});

describe("PaneStream — floods (pause/continue)", () => {
  it("a paused pane reads as seeding until continue, then reseeds once", async () => {
    const { client, stream } = makeStream({ capture: "hello" });
    const sink = new RecordingSink();
    stream.attach(sink);
    await flushTicks();
    expect(stream.state).toBe("live");
    const captures = client.capturePaneCount();

    client.injectNotification({ type: "pause", paneId: PANE_ID });
    expect(stream.state).toBe("seeding");
    await flushTicks();
    expect(client.capturePaneCount()).toBe(captures);

    client.injectNotification({ type: "continue", paneId: PANE_ID });
    expect(stream.state).toBe("seeding");
    await flushTicks();
    expect(client.capturePaneCount()).toBe(captures + 1);
    expect(stream.state).toBe("live");
    expect(sink.seedTexts).toHaveLength(2);
    stream.dispose();
  });

  it("a capture that lands while the pane is paused stays seeding; continue reseeds", async () => {
    const { client, stream } = makeStream({ capture: "hello" });
    const sink = new RecordingSink();
    stream.attach(sink);
    // The arrival capture is in flight when tmux pauses the pane.
    client.injectNotification({ type: "pause", paneId: PANE_ID });
    await flushTicks();
    expect(stream.state).toBe("seeding");
    expect(sink.seedTexts).toHaveLength(0);
    const captures = client.capturePaneCount();

    client.injectNotification({ type: "continue", paneId: PANE_ID });
    await flushTicks();
    expect(client.capturePaneCount()).toBe(captures + 1);
    expect(stream.state).toBe("live");
    expect(sink.seedTexts).toHaveLength(1);
    stream.dispose();
  });

  const shape = (sink: RecordingSink): string[] =>
    sink.events
      .filter((e) => !e.startsWith("write"))
      .map((e) => e.replace(/^seed\(.*/s, "seed"));

  // A pane whose capture states the size it is at now, as tmux's does.
  function makePane(cols = 80, rows = 24) {
    const pane = { cols, rows, failCapture: false };
    const client = new FakeTmuxClient();
    client.setExecuteResponse((cmd) =>
      cmd.startsWith("display-message") ? seedStateLine(pane) : "hello",
    );
    client.setExecuteFailure((cmd) =>
      pane.failCapture && cmd.startsWith("capture-pane")
        ? tmuxError("x")
        : null,
    );
    const stream = new PaneStream({ client, paneId: PANE_ID });
    const name = client.subscriptionNamed(`%${PANE_ID}`);
    return { client, stream, pane, name };
  }

  it("a report of a size the picture is not at takes the pane again; a report of its size does not", async () => {
    const { client, stream, pane, name } = makePane();
    const sink = new RecordingSink();
    stream.attach(sink);
    await flushTicks();
    const captures = client.capturePaneCount();

    client.injectSubscriptionChanged(name, PANE_ID, "80;24");
    await flushTicks();
    expect(client.capturePaneCount()).toBe(captures);

    // Border status shrank the pane with no layout change; its program
    // redrew for 79x23 before tmux said so. tmux's screen wins.
    pane.cols = 79;
    pane.rows = 23;
    client.injectSubscriptionChanged(name, PANE_ID, "79;23");
    await flushTicks();
    expect(client.capturePaneCount()).toBe(captures + 1);
    expect(stream.state).toBe("live");
    expect(shape(sink).slice(-2)).toEqual(["resize(79x23)", "seed"]);
    stream.dispose();
  });

  it("before tmux reports, a seed is drawn at the size it was captured at", async () => {
    // A pane outside the control client's session is never reported; any
    // other waits up to a second for its first report.
    const { stream } = makeStream({ capture: "hello" });
    const sink = new RecordingSink();
    stream.attach(sink);
    await flushTicks();
    expect(shape(sink)).toEqual(["resize(80x24)", "seed"]);
    stream.dispose();
  });

  it("before tmux reports, each seed is drawn at its own capture's size", async () => {
    // A pane outside the control client's session is never reported, so a
    // resize of it is known only from the next capture.
    let state = seedStateLine();
    const client = new FakeTmuxClient();
    client.setExecuteResponse((cmd) =>
      cmd.startsWith("display-message") ? state : "hello",
    );
    const stream = new PaneStream({ client, paneId: PANE_ID });
    stream.attach(new RecordingSink());
    await flushTicks();
    stream.detach();
    state = seedStateLine({ cols: 100, rows: 30 });
    client.injectOutput(PANE_ID, new TextEncoder().encode("x")); // drops the cache
    const sink = new RecordingSink();
    stream.attach(sink);
    await flushTicks();
    expect(shape(sink)).toEqual(["resize(100x30)", "seed"]);
    stream.dispose();
  });

  it("a failed capture leaves the sink's size; tmux's first report captures again", async () => {
    // The bytes behind the failed capture reached the sink at whatever size
    // it had; nothing else would redraw them at tmux's.
    const { stream, pane, name, client } = makePane(100, 30);
    pane.failCapture = true;
    const sink = new RecordingSink();
    stream.attach(sink);
    await flushTicks();
    expect(shape(sink)).toEqual([]);
    pane.failCapture = false;
    client.injectSubscriptionChanged(name, PANE_ID, "100;30");
    await flushTicks();
    expect(shape(sink)).toEqual(["resize(100x30)", "seed"]);
    stream.dispose();
  });

  it("a report while the first capture is in flight draws it, then takes the pane again", async () => {
    // The capture may have run before the resize the report says.
    const { client, stream, pane, name } = makePane();
    const sink = new RecordingSink();
    stream.attach(sink);
    pane.cols = 100;
    pane.rows = 30;
    client.injectSubscriptionChanged(name, PANE_ID, "100;30");
    await flushTicks();
    expect(client.capturePaneCount()).toBe(2);
    expect(shape(sink)).toEqual([
      "resize(100x30)",
      "seed",
      "resize(100x30)",
      "seed",
    ]);
    stream.dispose();
  });

  it("a pane resized again and again while its capture flies is drawn that capture, then taken once more", async () => {
    // A drag: layout changes faster than a capture's round trip. Dropping
    // each capture would freeze the pane until the drag stopped.
    const { client, stream, pane } = makePane();
    const sink = new RecordingSink();
    const states: PaneStreamState[] = [];
    stream.on("state-changed", (s) => states.push(s));
    stream.attach(sink);
    for (const cols of [90, 100, 110]) {
      pane.cols = cols;
      stream.resized();
    }
    await flushTicks();
    expect(client.capturePaneCount()).toBe(2);
    expect(shape(sink).filter((e) => e === "seed")).toHaveLength(2);
    expect(shape(sink).at(-2)).toBe("resize(110x24)");
    // Seeding throughout: never live for an instant between the two.
    expect(states).toEqual(["seeding", "live"]);
    stream.dispose();
  });

  it("an attach while tmux has the pane paused takes nothing until %continue", async () => {
    const { client, stream } = makePane();
    client.injectNotification({ type: "pause", paneId: PANE_ID });
    stream.attach(new RecordingSink());
    await flushTicks();
    expect(client.capturePaneCount()).toBe(0);
    expect(stream.state).toBe("seeding");
    client.injectNotification({ type: "continue", paneId: PANE_ID });
    await flushTicks();
    expect(client.capturePaneCount()).toBe(1);
    expect(stream.state).toBe("live");
    stream.dispose();
  });

  it("after a failed capture, a report of the size the sink was last drawn at takes the pane again", async () => {
    // The bytes behind the failed capture reached the sink at no known size.
    const { client, stream, pane, name } = makePane();
    stream.attach(new RecordingSink());
    await flushTicks();
    pane.failCapture = true;
    pane.cols = 100;
    stream.resized();
    await flushTicks();
    pane.failCapture = false;
    pane.cols = 80;
    const captures = client.capturePaneCount();
    client.injectSubscriptionChanged(name, PANE_ID, "80;24");
    await flushTicks();
    expect(client.capturePaneCount()).toBe(captures + 1);
    stream.dispose();
  });

  it("a resize while tmux has the pane paused takes nothing until %continue", async () => {
    const { client, stream } = makePane();
    stream.attach(new RecordingSink());
    await flushTicks();
    client.injectNotification({ type: "pause", paneId: PANE_ID });
    const captures = client.capturePaneCount();
    stream.resized();
    await flushTicks();
    expect(client.capturePaneCount()).toBe(captures);
    client.injectNotification({ type: "continue", paneId: PANE_ID });
    await flushTicks();
    expect(client.capturePaneCount()).toBe(captures + 1);
    expect(stream.state).toBe("live");
    stream.dispose();
  });

  it("a seed is drawn at the size it was captured at, not at tmux's last report", async () => {
    // tmux said 100;30, the pane went back to 80x24 inside one check, and
    // tmux will not say 80;24 again: only the capture knows.
    const { client, stream } = makeStream({ capture: "hello" });
    const name = client.subscriptionNamed(`%${PANE_ID}`);
    client.injectSubscriptionChanged(name, PANE_ID, "100;30");
    const sink = new RecordingSink();
    stream.attach(sink);
    await flushTicks();
    expect(shape(sink)).toEqual(["resize(80x24)", "seed"]);
    stream.dispose();
  });

  it("tmux's first report recaptures when it differs from the size the seed was drawn at", async () => {
    // The pane moved on before tmux's first check; its program's redraw
    // reached the sink at 80x24.
    const { client, stream } = makeStream({ capture: "hello" });
    const name = client.subscriptionNamed(`%${PANE_ID}`);
    stream.attach(new RecordingSink());
    await flushTicks();
    const captures = client.capturePaneCount();
    client.injectSubscriptionChanged(name, PANE_ID, "120;40");
    await flushTicks();
    expect(client.capturePaneCount()).toBe(captures + 1);
    stream.dispose();
  });

  it("tmux's first report does not recapture when it is the size the seed was drawn at", async () => {
    const { client, stream } = makeStream({ capture: "hello" });
    const name = client.subscriptionNamed(`%${PANE_ID}`);
    stream.attach(new RecordingSink());
    await flushTicks();
    const captures = client.capturePaneCount();
    client.injectSubscriptionChanged(name, PANE_ID, "80;24");
    await flushTicks();
    expect(client.capturePaneCount()).toBe(captures);
    stream.dispose();
  });

  it("a seed resolved with no sink attached still sets the size a first report is compared with", async () => {
    const { client, stream } = makeStream({ capture: "hello" });
    const name = client.subscriptionNamed(`%${PANE_ID}`);
    stream.attach(new RecordingSink());
    stream.detach(); // the capture resolves into the cache
    await flushTicks();
    const captures = client.capturePaneCount();
    client.injectSubscriptionChanged(name, PANE_ID, "120;40");
    await flushTicks();
    const sink = new RecordingSink();
    stream.attach(sink);
    expect(stream.state).toBe("seeding"); // the cached 80x24 picture is gone
    await flushTicks();
    expect(client.capturePaneCount()).toBe(captures + 1);
    stream.dispose();
  });

  it("after a reconnect, a seed is drawn at its own size, not the old connection's report", async () => {
    // The new control client may never report this pane (not in its
    // session), so the old report says nothing about the pane now.
    const { client, stream } = makeStream({ capture: "hello" });
    const name = client.subscriptionNamed(`%${PANE_ID}`);
    client.injectSubscriptionChanged(name, PANE_ID, "100;30");
    stream.attach(new RecordingSink());
    await flushTicks();
    stream.detach();
    client.setConnectionState({ status: "reconnecting", attempt: 1 });
    client.setConnectionState({ status: "ready" });
    const sink = new RecordingSink();
    stream.attach(sink);
    await flushTicks();
    expect(shape(sink)).toEqual(["resize(80x24)", "seed"]);
    stream.dispose();
  });

  it("takes only a decimal width;height from the subscription", () => {
    const { client, stream } = makeStream();
    const name = client.subscriptionNamed(`%${PANE_ID}`);
    const sink = new RecordingSink();
    stream.attach(sink);
    for (const value of ["0x50;24", "1e2;24", "80;24;1", "80;0", " 80;24"]) {
      client.injectSubscriptionChanged(name, PANE_ID, value);
    }
    expect(sink.events.filter((e) => e.startsWith("resize"))).toEqual([]);
    stream.dispose();
  });

  it("a size change while detached invalidates the cached seed and reaches the next sink, with no output", async () => {
    // A program that prints nothing on SIGWINCH leaves no byte to clear the
    // cache; the size change alone moves the pane past the cached picture.
    const { client, stream, pane, name } = makePane();
    stream.attach(new RecordingSink());
    await flushTicks();
    const captures = client.capturePaneCount();
    stream.detach();

    pane.cols = 100;
    pane.rows = 30;
    client.injectSubscriptionChanged(name, PANE_ID, "100;30");
    await flushTicks();
    expect(client.capturePaneCount()).toBe(captures); // nobody to capture for

    const sink = new RecordingSink();
    stream.attach(sink);
    expect(stream.state).toBe("seeding"); // not the cached fast path
    await flushTicks();
    expect(client.capturePaneCount()).toBe(captures + 1);
    expect(shape(sink)).toEqual(["resize(100x30)", "seed"]);
    stream.dispose();
  });

  it("a layout change takes the pane again, attached or detached, even when tmux's report stays quiet", async () => {
    // A zoom undone inside one check: tmux reports nothing, %layout-change
    // twice.
    const { client, stream, pane } = makePane();
    const sink = new RecordingSink();
    stream.attach(sink);
    await flushTicks();
    pane.cols = 100;
    pane.rows = 30;
    stream.resized();
    await flushTicks();
    pane.cols = 80;
    pane.rows = 24;
    stream.resized();
    await flushTicks();
    expect(shape(sink)).toEqual([
      "resize(80x24)",
      "seed",
      "resize(100x30)",
      "seed",
      "resize(80x24)",
      "seed",
    ]);

    stream.detach();
    const captures = client.capturePaneCount();
    stream.resized();
    await flushTicks();
    expect(client.capturePaneCount()).toBe(captures); // nobody to capture for
    stream.attach(new RecordingSink());
    expect(stream.state).toBe("seeding"); // the cached picture is gone
    stream.dispose();
  });

  it("a continue for a pane with no sink drops a capture still in flight", async () => {
    const { client, stream } = makeStream({ capture: "hello" });
    stream.attach(new RecordingSink());
    client.injectNotification({ type: "pause", paneId: PANE_ID });
    stream.detach();
    client.injectNotification({ type: "continue", paneId: PANE_ID });
    await flushTicks();
    // The capture missed what tmux dropped while paused, so it is not cached:
    // the next attach captures again.
    const captures = client.capturePaneCount();
    stream.attach(new RecordingSink());
    await flushTicks();
    expect(client.capturePaneCount()).toBe(captures + 1);
    stream.dispose();
  });

  it("ignores another pane's pause and continue", async () => {
    const { client, stream } = makeStream();
    stream.attach(new RecordingSink());
    await flushTicks();
    const captures = client.capturePaneCount();
    client.injectNotification({ type: "pause", paneId: PANE_ID + 1 });
    client.injectNotification({ type: "continue", paneId: PANE_ID + 1 });
    await flushTicks();
    expect(stream.state).toBe("live");
    expect(client.capturePaneCount()).toBe(captures);
    stream.dispose();
  });

  it("output while detached mid-capture is not kept: the next attach captures again", async () => {
    const { client, stream } = makeStream({ capture: "first-screen" });
    stream.attach(new RecordingSink());
    stream.detach();
    client.injectOutput(PANE_ID, new Uint8Array([0x41, 0x42]));
    await flushTicks();
    expect(client.capturePaneCount()).toBe(1);

    const sink = new RecordingSink();
    stream.attach(sink);
    await flushTicks();
    expect(client.capturePaneCount()).toBe(2);
    expect(sink.seedTexts).toHaveLength(1);
    expect(sink.writes).toEqual([]);
    stream.dispose();
  });

  it("a detached stream recaptures on its next attach after a flood", async () => {
    const { client, stream } = makeStream();
    stream.attach(new RecordingSink());
    await flushTicks();
    stream.detach();
    const captures = client.capturePaneCount();
    client.injectNotification({ type: "pause", paneId: PANE_ID });
    client.injectNotification({ type: "continue", paneId: PANE_ID });
    expect(stream.state).toBe("detached");
    stream.attach(new RecordingSink());
    await flushTicks();
    expect(client.capturePaneCount()).toBe(captures + 1);
    stream.dispose();
  });
});

describe("PaneStream — event listeners", () => {
  it("takes each event's own listener shape", () => {
    // The @ts-expect-error lines are the assertions; `pnpm run typecheck`
    // fails if any of them compiles.
    const calls = (stream: PaneStream) => [
      () => stream.on("state-changed", (s: PaneStreamState) => s),
      () => stream.on("activity-changed", (a: PaneActivity) => a),
      () => stream.on("error", (e: PaneStreamError) => e),
      () => stream.on("reconnected", () => undefined),
      // @ts-expect-error a state-changed listener receives a state, not an error
      () => stream.on("state-changed", (e: PaneStreamError) => e),
      // @ts-expect-error an error listener receives an error, not activity
      () => stream.on("error", (a: PaneActivity) => a),
      // @ts-expect-error a reconnected listener receives nothing
      () => stream.on("reconnected", (s: PaneStreamState) => s),
    ];
    expect(calls).toBeTypeOf("function");
  });

  it("the returned unsubscribe stops delivery to that listener only", async () => {
    const { stream } = makeStream();
    const kept: string[] = [];
    const dropped: string[] = [];
    stream.on("state-changed", (s) => kept.push(s));
    const off = stream.on("state-changed", (s) => dropped.push(s));
    off();
    stream.attach(new RecordingSink());
    await flushTicks();
    expect(kept).toEqual(["seeding", "live"]);
    expect(dropped).toEqual([]);
    stream.dispose();
  });
});
