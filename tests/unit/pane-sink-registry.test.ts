// tests/unit/pane-sink-registry.test.ts
// Direct behavior-level tests for `SinkRegistry` and `PaneTopologyManager`.
// Every TmuxClientLike implementation owns one of each; pinning their
// contracts here means every client that delegates to these classes inherits
// the assertions by construction.
//
// [LAW:behavior-not-structure] Tests assert WHAT the registry promises:
//   pre-dispatch snapshot (no back-fill on re-entrant attach), iteration-safe
//   detach inside a sink's write, per-scope isolation, per-attachment
//   lifecycle, disposer idempotency, and scope-bifurcated dispatch (pane →
//   window → session → server order). None of these assert HOW attachments
//   are stored internally.
//
// [LAW:single-enforcer] These assertions sit on the canonical classes.
//   Every TmuxClientLike-shaped object that owns a `SinkRegistry` is covered
//   without needing N parallel test suites.

import { describe, expect, it } from "vitest";

import {
  SinkRegistry,
  PaneTopologyManager,
  type BytesSink,
  paneScope,
  windowScope,
  sessionScope,
  serverScope,
} from "../../src/pane-output.js";
import type { OutputMessage } from "../../src/protocol/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function paneOutput(paneId: number, ...bytes: number[]): OutputMessage {
  return { type: "output", paneId, data: new Uint8Array(bytes) };
}

interface Recorder extends BytesSink {
  readonly messages: { paneId: number; data: Uint8Array }[];
  readonly endCount: { value: number };
}

function recorder(): Recorder {
  const messages: { paneId: number; data: Uint8Array }[] = [];
  const endCount = { value: 0 };
  return {
    messages,
    endCount,
    write(msg): void {
      // BytesSink contract: msg.data is read-only and not retained past write.
      // The recording sink copies before retaining.
      messages.push({ paneId: msg.paneId, data: msg.data.slice() });
    },
    end(): void {
      endCount.value += 1;
    },
  };
}

// ---------------------------------------------------------------------------
// SinkRegistry.dispatch — snapshot semantics and per-scope routing
// ---------------------------------------------------------------------------

describe("SinkRegistry.dispatch", () => {
  it("delivers a chunk only to sinks attached when the chunk arrived (pre-dispatch snapshot)", () => {
    const reg = new SinkRegistry();
    const a = recorder();
    const lateAttached = recorder();

    // `trigger`'s write attaches a sibling sink mid-dispatch. Per the contract,
    // the sibling MUST NOT see the current chunk (snapshot taken before iteration).
    const trigger: BytesSink = {
      write(): void {
        reg.attach(lateAttached, paneScope(1));
      },
    };
    reg.attach(trigger, paneScope(1));
    reg.attach(a, paneScope(1));

    reg.dispatch(paneOutput(1, 0x41), undefined);

    expect(a.messages).toHaveLength(1);
    expect(lateAttached.messages).toHaveLength(0);

    // The late-attached sink IS in the registry for any FUTURE chunk.
    reg.dispatch(paneOutput(1, 0x42), undefined);
    expect(lateAttached.messages).toHaveLength(1);
  });

  it("delivers a chunk to sinks even if a sibling detaches itself mid-dispatch", () => {
    const reg = new SinkRegistry();
    const observed: string[] = [];

    let disposeA!: () => void;
    const a: BytesSink = {
      write(): void {
        observed.push("a");
        disposeA();
      },
    };
    const b: BytesSink = {
      write(): void {
        observed.push("b");
      },
    };
    disposeA = reg.attach(a, paneScope(1));
    reg.attach(b, paneScope(1));

    reg.dispatch(paneOutput(1, 0x41), undefined);

    expect(observed).toEqual(["a", "b"]);
  });

  it("isolates per-pane attachments — bytes for pane X never reach a sink on pane Y", () => {
    const reg = new SinkRegistry();
    const onPane1 = recorder();
    const onPane2 = recorder();

    reg.attach(onPane1, paneScope(1));
    reg.attach(onPane2, paneScope(2));

    reg.dispatch(paneOutput(1, 0xa1, 0xa2), undefined);
    reg.dispatch(paneOutput(2, 0xb1), undefined);

    expect(onPane1.messages).toHaveLength(1);
    expect(onPane1.messages[0].data).toEqual(new Uint8Array([0xa1, 0xa2]));
    expect(onPane2.messages).toHaveLength(1);
    expect(onPane2.messages[0].data).toEqual(new Uint8Array([0xb1]));
  });

  it("treats each attach() call as independent — N attaches yield N disposers and N end() calls", () => {
    const reg = new SinkRegistry();
    const sink = recorder();

    const d1 = reg.attach(sink, paneScope(1));
    const d2 = reg.attach(sink, paneScope(1));

    reg.dispatch(paneOutput(1, 0x41), undefined);
    // Same sink attached twice → write fires twice for one chunk.
    expect(sink.messages).toHaveLength(2);

    d1();
    expect(sink.endCount.value).toBe(1);

    // Second attachment still active.
    reg.dispatch(paneOutput(1, 0x42), undefined);
    expect(sink.messages).toHaveLength(3);

    d2();
    expect(sink.endCount.value).toBe(2);

    // Both disposed.
    reg.dispatch(paneOutput(1, 0x43), undefined);
    expect(sink.messages).toHaveLength(3);
  });

  it("makes the disposer idempotent — a second call is a no-op (no extra end())", () => {
    const reg = new SinkRegistry();
    const sink = recorder();
    const dispose = reg.attach(sink, paneScope(1));

    dispose();
    dispose();
    dispose();

    expect(sink.endCount.value).toBe(1);
  });

  it("is a cheap no-op when there are no sinks for a given pane", () => {
    const reg = new SinkRegistry();
    const sink = recorder();
    reg.attach(sink, paneScope(1));

    // Pane with no attachments: no delivery.
    reg.dispatch(paneOutput(99, 0x41), undefined);
    expect(sink.messages).toHaveLength(0);

    // The attached pane still works.
    reg.dispatch(paneOutput(1, 0x42), undefined);
    expect(sink.messages).toHaveLength(1);
  });

  it("routes server-scope to all panes", () => {
    const reg = new SinkRegistry();
    const server = recorder();
    reg.attach(server, serverScope);

    reg.dispatch(paneOutput(1, 0x11), undefined);
    reg.dispatch(paneOutput(5, 0x55), undefined);

    expect(server.messages).toHaveLength(2);
    expect(server.messages[0].paneId).toBe(1);
    expect(server.messages[1].paneId).toBe(5);
  });

  it("routes window-scope via PaneMeta.windowId (fires when meta matches)", () => {
    const reg = new SinkRegistry();
    const win2sink = recorder();
    reg.attach(win2sink, windowScope(2));

    // Pane 10 is in window 2, pane 11 is in window 3.
    reg.dispatch(paneOutput(10, 0xaa), { sessionId: 1, windowId: 2 });
    reg.dispatch(paneOutput(11, 0xbb), { sessionId: 1, windowId: 3 });

    expect(win2sink.messages).toHaveLength(1);
    expect(win2sink.messages[0].paneId).toBe(10);
  });

  it("routes session-scope via PaneMeta.sessionId (fires when meta matches)", () => {
    const reg = new SinkRegistry();
    const sess1sink = recorder();
    reg.attach(sess1sink, sessionScope(1));

    reg.dispatch(paneOutput(10, 0xaa), { sessionId: 1, windowId: 2 });
    reg.dispatch(paneOutput(20, 0xbb), { sessionId: 2, windowId: 4 });

    expect(sess1sink.messages).toHaveLength(1);
    expect(sess1sink.messages[0].paneId).toBe(10);
  });

  it("routes in pane → window → session → server order (most-to-least-specific)", () => {
    const reg = new SinkRegistry();
    const order: string[] = [];

    reg.attach({ write() { order.push("pane"); } }, paneScope(5));
    reg.attach({ write() { order.push("window"); } }, windowScope(2));
    reg.attach({ write() { order.push("session"); } }, sessionScope(1));
    reg.attach({ write() { order.push("server"); } }, serverScope);

    reg.dispatch(paneOutput(5, 0x01), { sessionId: 1, windowId: 2 });

    expect(order).toEqual(["pane", "window", "session", "server"]);
  });

  it("skips window/session routing when meta is undefined (topology unknown)", () => {
    const reg = new SinkRegistry();
    const paneSink = recorder();
    const serverSink = recorder();
    const windowSink = recorder();
    reg.attach(paneSink, paneScope(5));
    reg.attach(serverSink, serverScope);
    reg.attach(windowSink, windowScope(99));

    reg.dispatch(paneOutput(5, 0x01), undefined);

    expect(paneSink.messages).toHaveLength(1);
    expect(serverSink.messages).toHaveLength(1);
    expect(windowSink.messages).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// SinkRegistry.hasTopologyDependentSinks
// ---------------------------------------------------------------------------

describe("SinkRegistry.hasTopologyDependentSinks", () => {
  it("returns false when no sinks are attached", () => {
    const reg = new SinkRegistry();
    expect(reg.hasTopologyDependentSinks()).toBe(false);
  });

  it("returns false for pane-scope and server-scope attachments only", () => {
    const reg = new SinkRegistry();
    const noop: BytesSink = { write() {} };
    reg.attach(noop, paneScope(1));
    reg.attach(noop, serverScope);
    expect(reg.hasTopologyDependentSinks()).toBe(false);
  });

  it("returns true when a window-scope sink is attached", () => {
    const reg = new SinkRegistry();
    const noop: BytesSink = { write() {} };
    const dispose = reg.attach(noop, windowScope(1));
    expect(reg.hasTopologyDependentSinks()).toBe(true);
    dispose();
    expect(reg.hasTopologyDependentSinks()).toBe(false);
  });

  it("returns true when a session-scope sink is attached", () => {
    const reg = new SinkRegistry();
    const noop: BytesSink = { write() {} };
    const dispose = reg.attach(noop, sessionScope(1));
    expect(reg.hasTopologyDependentSinks()).toBe(true);
    dispose();
    expect(reg.hasTopologyDependentSinks()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PaneTopologyManager — table management
// ---------------------------------------------------------------------------

describe("PaneTopologyManager", () => {
  it("get returns undefined for unknown paneId", () => {
    const t = new PaneTopologyManager();
    expect(t.get(99)).toBeUndefined();
  });

  it("seed populates the table from a full listing", () => {
    const t = new PaneTopologyManager();
    t.seed([
      { paneId: 1, windowId: 10, sessionId: 100 },
      { paneId: 2, windowId: 10, sessionId: 100 },
      { paneId: 3, windowId: 20, sessionId: 100 },
    ]);
    expect(t.get(1)).toEqual({ windowId: 10, sessionId: 100 });
    expect(t.get(3)).toEqual({ windowId: 20, sessionId: 100 });
    expect(t.get(99)).toBeUndefined();
  });

  it("seed replaces the table wholesale", () => {
    const t = new PaneTopologyManager();
    t.seed([{ paneId: 1, windowId: 10, sessionId: 100 }]);
    t.seed([{ paneId: 2, windowId: 20, sessionId: 200 }]);
    expect(t.get(1)).toBeUndefined();
    expect(t.get(2)).toEqual({ windowId: 20, sessionId: 200 });
  });

  it("removeWindow removes all panes in that window", () => {
    const t = new PaneTopologyManager();
    t.seed([
      { paneId: 1, windowId: 10, sessionId: 100 },
      { paneId: 2, windowId: 10, sessionId: 100 },
      { paneId: 3, windowId: 20, sessionId: 100 },
    ]);
    t.removeWindow(10);
    expect(t.get(1)).toBeUndefined();
    expect(t.get(2)).toBeUndefined();
    expect(t.get(3)).toEqual({ windowId: 20, sessionId: 100 });
  });

  it("updateWindow adds new panes and removes stale ones", () => {
    const t = new PaneTopologyManager();
    t.seed([
      { paneId: 1, windowId: 10, sessionId: 100 },
      { paneId: 2, windowId: 10, sessionId: 100 },
    ]);
    // Window 10 now only has pane 1 and a new pane 3.
    t.updateWindow(10, [
      { paneId: 1, sessionId: 100 },
      { paneId: 3, sessionId: 100 },
    ]);
    expect(t.get(1)).toEqual({ windowId: 10, sessionId: 100 });
    expect(t.get(2)).toBeUndefined();
    expect(t.get(3)).toEqual({ windowId: 10, sessionId: 100 });
  });
});
