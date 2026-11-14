// tests/unit/ws-outbox.test.ts
// Unit tests for the Outbox collaborator extracted from WebSocketTmuxClient.
// The outbox fuses call correlation, per-call timeout, and the un-transmitted
// send queue into one structure — these tests pin the invariants that the
// fusion is meant to guarantee (transmit-exactly-once, FIFO, drain rejects all,
// a rejected frame is never re-sent).
import { describe, it, expect, vi, afterEach } from "vitest";
import { Outbox } from "../../src/connectors/websocket/outbox.js";
import {
  BridgeError,
  parseDurationMs,
  type ReceivedResultFrame,
} from "../../src/connectors/websocket/protocol.js";
import type { CommandResponse } from "../../src/protocol/types.js";
import { TmuxCommandError } from "../../src/errors.js";

afterEach(() => {
  vi.useRealTimers();
});

// The outbox only accepts a stamped deadline; tests go through the same
// parser the client does.
const ms = (n: number) => parseDurationMs("requestTimeoutMs", n);

// What the client's frame parser hands the outbox: the id, the rest unread.
function received(
  frame: { readonly k: "result"; readonly id: string } & Record<
    string,
    unknown
  >,
): ReceivedResultFrame {
  return { k: "result", id: frame.id, raw: frame };
}

function okResult(id: string): ReceivedResultFrame {
  const response: CommandResponse = {
    commandNumber: 1,
    timestamp: 0,
    output: [`out-${id}`],
    success: true,
  };
  return received({ k: "result", id, ok: true, response });
}

describe("Outbox — transmit", () => {
  it("transmits immediately and exactly once when send accepts the frame", () => {
    const sent: string[] = [];
    const outbox = new Outbox((frame) => {
      sent.push(frame);
      return true;
    });
    void outbox.enqueue("r1", "execute", "frame-1", ms(1000));
    expect(sent).toEqual(["frame-1"]);
    // A later flush must not re-send an already-transmitted frame.
    outbox.flush();
    expect(sent).toEqual(["frame-1"]);
  });

  it("queues the frame when send is not ready, then transmits once on flush", () => {
    const sent: string[] = [];
    let ready = false;
    const outbox = new Outbox((frame) => {
      if (!ready) return false;
      sent.push(frame);
      return true;
    });
    void outbox.enqueue("r1", "execute", "frame-1", ms(1000));
    expect(sent).toEqual([]); // not ready — queued
    ready = true;
    outbox.flush();
    expect(sent).toEqual(["frame-1"]);
    outbox.flush();
    expect(sent).toEqual(["frame-1"]); // still exactly once
  });

  it("preserves FIFO order and stops flushing at the first frame that fails", () => {
    const sent: string[] = [];
    let acceptFrom = 99; // nothing ready at first
    const outbox = new Outbox((frame) => {
      const n = Number(frame.split("-")[1]);
      if (n < acceptFrom) return false;
      sent.push(frame);
      return true;
    });
    // None ready yet (all < 3) — nothing transmits at enqueue.
    void outbox.enqueue("r1", "execute", "frame-1", ms(1000));
    void outbox.enqueue("r2", "execute", "frame-2", ms(1000));
    void outbox.enqueue("r3", "execute", "frame-3", ms(1000));
    expect(sent).toEqual([]);
    // Now accept from frame-2 onward: flush must stop at frame-1 (still fails),
    // so nothing goes out — FIFO is not skipped.
    acceptFrom = 2;
    outbox.flush();
    expect(sent).toEqual([]);
    // Accept everything: FIFO order 1,2,3.
    acceptFrom = 1;
    outbox.flush();
    expect(sent).toEqual(["frame-1", "frame-2", "frame-3"]);
  });
});

describe("Outbox — settle", () => {
  it("resolves the matching pending on an ok result", async () => {
    const outbox = new Outbox(() => true);
    const p = outbox.enqueue("r1", "execute", "frame-1", ms(1000));
    outbox.settle(okResult("r1"));
    await expect(p).resolves.toMatchObject({ output: ["out-r1"] });
  });

  it("rejects the matching pending on an error result", async () => {
    const outbox = new Outbox(() => true);
    const p = outbox.enqueue("r1", "execute", "frame-1", ms(1000));
    outbox.settle(
      received({
        k: "result",
        id: "r1",
        ok: false,
        error: { code: "BRIDGE_INTERNAL", message: "boom" },
      }),
    );
    await expect(p).rejects.toMatchObject({ code: "BRIDGE_INTERNAL" });
  });

  it.each(["BRIDGE_NOPE", 7, "toString"])(
    "rejects the call when an error result's code is %j, not a BridgeErrorCode",
    async (code) => {
      const outbox = new Outbox(() => true);
      const p = outbox.enqueue("r1", "execute", "frame-1", ms(1000));
      const violation = outbox.settle(
        received({
          k: "result",
          id: "r1",
          ok: false,
          error: { code, message: "m" },
        }),
      );
      expect(violation?.message).toContain(
        "result(execute).error.code must be a BridgeErrorCode",
      );
      await expect(p).rejects.toBe(violation);
    },
  );

  it("settling an unknown id is a no-op", () => {
    const outbox = new Outbox(() => true);
    expect(() => outbox.settle(okResult("ghost"))).not.toThrow();
  });

  it("a result for a call never sent is a violation, and the call stays pending", async () => {
    const sent: string[] = [];
    let ready = false;
    const outbox = new Outbox((frame) => {
      if (!ready) return false;
      sent.push(frame);
      return true;
    });
    const p = outbox.enqueue("r1", "execute", "frame-1", ms(1000));
    const violation = outbox.settle(okResult("r1"));
    expect(violation).toMatchObject({ code: "BRIDGE_PROTOCOL_ERROR" });
    expect(violation?.message).toContain("r1");
    // Still queued: it transmits on flush and its real result settles it.
    ready = true;
    outbox.flush();
    expect(sent).toEqual(["frame-1"]);
    expect(outbox.settle(okResult("r1"))).toBeUndefined();
    await expect(p).resolves.toMatchObject({ output: ["out-r1"] });
  });
});

describe("Outbox — timeout", () => {
  it("rejects with BRIDGE_TIMEOUT when no result arrives in time", async () => {
    vi.useFakeTimers();
    const outbox = new Outbox(() => true);
    const p = outbox.enqueue("r1", "execute", "frame-1", ms(50));
    const settled = p.catch((e: unknown) => e);
    vi.advanceTimersByTime(50);
    const err = await settled;
    expect(err).toBeInstanceOf(BridgeError);
    expect((err as BridgeError).code).toBe("BRIDGE_TIMEOUT");
  });

  it("a result arriving after timeout is a no-op (pending already gone)", async () => {
    vi.useFakeTimers();
    const outbox = new Outbox(() => true);
    const p = outbox.enqueue("r1", "execute", "frame-1", ms(50));
    const settled = p.catch((e: unknown) => e);
    vi.advanceTimersByTime(50);
    await settled;
    expect(() => outbox.settle(okResult("r1"))).not.toThrow();
  });
});

describe("Outbox — drain", () => {
  it("rejects every pending call with the given error and clears the queue", async () => {
    const sent: string[] = [];
    let ready = true;
    const outbox = new Outbox((frame) => {
      if (!ready) return false;
      sent.push(frame);
      return true;
    });
    ready = false; // keep frames queued so drain has something to reject
    const p1 = outbox.enqueue("r1", "execute", "frame-1", ms(1000));
    const p2 = outbox.enqueue("r2", "execute", "frame-2", ms(1000));
    const c1 = p1.catch((e: unknown) => e);
    const c2 = p2.catch((e: unknown) => e);

    outbox.drain(new BridgeError("BRIDGE_CLOSED", "gone"));

    expect((await c1) as BridgeError).toMatchObject({ code: "BRIDGE_CLOSED" });
    expect((await c2) as BridgeError).toMatchObject({ code: "BRIDGE_CLOSED" });

    // The M2 invariant: a drained (rejected) frame is NOT re-sent on a later
    // ready transition — the queue was cleared.
    ready = true;
    outbox.flush();
    expect(sent).toEqual([]);
  });

  it("rejects entries that transmitted but whose result never arrived", async () => {
    // The lost-result-frame path: send succeeds, but the connection dies before
    // the result comes back. drain() must still reject the caller.
    const outbox = new Outbox(() => true); // always transmits
    const p1 = outbox.enqueue("r1", "execute", "frame-1", ms(1000));
    const p2 = outbox.enqueue("r2", "execute", "frame-2", ms(1000));
    const c1 = p1.catch((e: unknown) => e);
    const c2 = p2.catch((e: unknown) => e);

    outbox.drain(new BridgeError("BRIDGE_CLOSED", "gone"));

    expect((await c1) as BridgeError).toMatchObject({ code: "BRIDGE_CLOSED" });
    expect((await c2) as BridgeError).toMatchObject({ code: "BRIDGE_CLOSED" });
    // A late result for a drained call is a no-op — the entry is gone.
    expect(() => outbox.settle(okResult("r1"))).not.toThrow();
  });
});

describe("Outbox — settle", () => {
  const failed: CommandResponse = {
    commandNumber: 1,
    timestamp: 0,
    output: ["no such hook"],
    success: false,
  };

  it("rejects a tmux %error result as TmuxCommandError, matching the Electron renderer", async () => {
    const outbox = new Outbox(() => true);
    const p = outbox.enqueue(
      "r1",
      "enableCrossSessionLayoutChange",
      "f",
      ms(1000),
    );
    outbox.settle(
      received({ k: "result", id: "r1", ok: false, tmuxError: failed }),
    );
    await expect(p).rejects.toBeInstanceOf(TmuxCommandError);
  });

  it("accepts a null response only for a method whose response is null", async () => {
    const outbox = new Outbox(() => true);
    const exec = outbox.enqueue("r1", "execute", "f1", ms(1000));
    const en = outbox.enqueue(
      "r2",
      "enableCrossSessionLayoutChange",
      "f2",
      ms(1000),
    );
    const dis = outbox.enqueue(
      "r3",
      "disableCrossSessionLayoutChange",
      "f3",
      ms(1000),
    );
    // A mismatch is returned as a protocol violation for the client's error
    // channel, as well as rejecting the call it answered.
    expect(
      outbox.settle(
        received({ k: "result", id: "r1", ok: true, response: null }),
      ),
    ).toMatchObject({ code: "BRIDGE_PROTOCOL_ERROR" });
    expect(
      outbox.settle(
        received({ k: "result", id: "r2", ok: true, response: null }),
      ),
    ).toBeUndefined();
    expect(outbox.settle(okResult("r3"))).toMatchObject({
      code: "BRIDGE_PROTOCOL_ERROR",
    });
    await expect(exec).rejects.toMatchObject({ code: "BRIDGE_PROTOCOL_ERROR" });
    await expect(en).resolves.toBeNull();
    await expect(dis).rejects.toMatchObject({ code: "BRIDGE_PROTOCOL_ERROR" });
  });

  const pane = {
    sessionId: 1,
    sessionName: "main",
    windowId: 2,
    windowName: "w",
    paneId: 3,
    process: { state: "running", pid: 42, cwd: "/tmp", currentCommand: "zsh" },
    startCommand: "",
    width: 80,
    height: 24,
  };

  it("resolves a response that has its method's shape, with only the declared fields", async () => {
    const outbox = new Outbox(() => true);
    const p = outbox.enqueue("r1", "listPanes", "f", ms(1000));
    expect(
      outbox.settle(
        received({
          k: "result",
          id: "r1",
          ok: true,
          response: [{ ...pane, extra: true }],
        }),
      ),
    ).toBeUndefined();
    await expect(p).resolves.toEqual([pane]);
  });

  it("resolves each pane process state, a running one with no cwd included, with only its declared fields", async () => {
    const outbox = new Outbox(() => true);
    const p = outbox.enqueue("r1", "listPanes", "f", ms(1000));
    const states = [
      { state: "running", pid: 42, cwd: null, currentCommand: "zsh" },
      { state: "dead" },
      { state: "empty" },
    ];
    outbox.settle(
      received({
        k: "result",
        id: "r1",
        ok: true,
        response: states.map((s) => ({ ...pane, process: { ...s, pid: 7 } })),
      }),
    );
    await expect(p).resolves.toEqual(
      states.map((s) => ({
        ...pane,
        process: s.state === "running" ? { ...s, pid: 7 } : s,
      })),
    );
  });

  it.each([
    [
      "execute",
      { commandNumber: 1, timestamp: 0, output: [1], success: true },
      "result(execute).response.output must be a string[]",
    ],
    [
      "listPanes",
      [pane, { ...pane, process: { ...pane.process, pid: "42" } }],
      "result(listPanes).response[1].process(running).pid must be a number",
    ],
    [
      "listPanes",
      [{ ...pane, process: { ...pane.process, cwd: 0 } }],
      "result(listPanes).response[0].process(running).cwd must be a string or null",
    ],
    [
      "listPanes",
      [{ ...pane, process: { state: "exited" } }],
      "result(listPanes).response[0].process.state",
    ],
    [
      "listWindows",
      { sessionId: 1 },
      "result(listWindows).response must be an array",
    ],
    [
      "listSessions",
      [{ sessionId: 1, sessionName: "s", windowCount: 1, attached: 1 }],
      "result(listSessions).response[0].attached must be a boolean",
    ],
  ] as const)(
    "rejects a %s response that breaks its shape, naming the field",
    async (method, response, message) => {
      const outbox = new Outbox(() => true);
      const p = outbox.enqueue("r1", method, "f", ms(1000));
      const violation = outbox.settle(
        received({
          k: "result",
          id: "r1",
          ok: true,
          response,
        }),
      );
      expect(violation).toMatchObject({ code: "BRIDGE_PROTOCOL_ERROR" });
      expect(violation?.message).toContain(message);
      await expect(p).rejects.toBe(violation);
    },
  );
});
