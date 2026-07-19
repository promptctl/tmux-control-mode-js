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
  type ResultFrame,
} from "../../src/connectors/websocket/protocol.js";
import type { CommandResponse } from "../../src/protocol/types.js";

afterEach(() => {
  vi.useRealTimers();
});

function okResult(id: string): ResultFrame {
  const response: CommandResponse = {
    commandNumber: 1,
    timestamp: 0,
    output: [`out-${id}`],
    success: true,
  };
  return { k: "result", id, ok: true, response };
}

describe("Outbox — transmit", () => {
  it("transmits immediately and exactly once when send accepts the frame", () => {
    const sent: string[] = [];
    const outbox = new Outbox((frame) => {
      sent.push(frame);
      return true;
    });
    void outbox.enqueue("r1", "execute", "frame-1", 1000);
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
    void outbox.enqueue("r1", "execute", "frame-1", 1000);
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
    void outbox.enqueue("r1", "execute", "frame-1", 1000);
    void outbox.enqueue("r2", "execute", "frame-2", 1000);
    void outbox.enqueue("r3", "execute", "frame-3", 1000);
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
    const p = outbox.enqueue("r1", "execute", "frame-1", 1000);
    outbox.settle(okResult("r1"));
    await expect(p).resolves.toMatchObject({ output: ["out-r1"] });
  });

  it("rejects the matching pending on an error result", async () => {
    const outbox = new Outbox(() => true);
    const p = outbox.enqueue("r1", "execute", "frame-1", 1000);
    outbox.settle({
      k: "result",
      id: "r1",
      ok: false,
      error: { code: "BRIDGE_INTERNAL", message: "boom" },
    });
    await expect(p).rejects.toMatchObject({ code: "BRIDGE_INTERNAL" });
  });

  it("settling an unknown id is a no-op", () => {
    const outbox = new Outbox(() => true);
    expect(() => outbox.settle(okResult("ghost"))).not.toThrow();
  });
});

describe("Outbox — timeout", () => {
  it("rejects with BRIDGE_TIMEOUT when no result arrives in time", async () => {
    vi.useFakeTimers();
    const outbox = new Outbox(() => true);
    const p = outbox.enqueue("r1", "execute", "frame-1", 50);
    const settled = p.catch((e: unknown) => e);
    vi.advanceTimersByTime(50);
    const err = await settled;
    expect(err).toBeInstanceOf(BridgeError);
    expect((err as BridgeError).code).toBe("BRIDGE_TIMEOUT");
  });

  it("a result arriving after timeout is a no-op (pending already gone)", async () => {
    vi.useFakeTimers();
    const outbox = new Outbox(() => true);
    const p = outbox.enqueue("r1", "execute", "frame-1", 50);
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
    const p1 = outbox.enqueue("r1", "execute", "frame-1", 1000);
    const p2 = outbox.enqueue("r2", "execute", "frame-2", 1000);
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
    const p1 = outbox.enqueue("r1", "execute", "frame-1", 1000);
    const p2 = outbox.enqueue("r2", "execute", "frame-2", 1000);
    const c1 = p1.catch((e: unknown) => e);
    const c2 = p2.catch((e: unknown) => e);

    outbox.drain(new BridgeError("BRIDGE_CLOSED", "gone"));

    expect((await c1) as BridgeError).toMatchObject({ code: "BRIDGE_CLOSED" });
    expect((await c2) as BridgeError).toMatchObject({ code: "BRIDGE_CLOSED" });
    // A late result for a drained call is a no-op — the entry is gone.
    expect(() => outbox.settle(okResult("r1"))).not.toThrow();
  });
});
