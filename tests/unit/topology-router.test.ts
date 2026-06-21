// tests/unit/topology-router.test.ts
// Unit tests for TopologyRouter — the shared substrate component.
//
// Tests are derived from the type-shape design's promises, not from any
// implementation detail. Each test names the behavior it asserts.

import { describe, expect, it, vi } from "vitest";

import { TopologyRouter } from "../../src/topology-router.js";
import type { BytesSink, ChunkPayload } from "../../src/pane-output.js";
import { windowScope, sessionScope, paneScope } from "../../src/pane-output.js";
import type { CommandResponse } from "../../src/protocol/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeChunk(paneId: number, data?: Uint8Array): ChunkPayload {
  return { paneId, data: data ?? new Uint8Array([paneId]) };
}

function makeOkResponse(lines: string[] = []): CommandResponse {
  return { commandNumber: 1, timestamp: 0, output: lines, success: true };
}

function makeSink(): BytesSink & {
  chunks: ChunkPayload[];
  ended: number;
} {
  const sink = {
    chunks: [] as ChunkPayload[],
    ended: 0,
    write(msg: ChunkPayload) {
      sink.chunks.push(msg);
    },
    end() {
      sink.ended++;
    },
  };
  return sink;
}

// A runCommand that always resolves immediately with empty output.
const noop: (cmd: string) => Promise<CommandResponse> = () =>
  Promise.resolve(makeOkResponse());

// ---------------------------------------------------------------------------
// 1. Transport lifecycle
// ---------------------------------------------------------------------------

describe("TopologyRouter — transport lifecycle", () => {
  it("onTransportReady provides the runCommand and triggers bootstrap when topology-dependent sinks exist", async () => {
    const router = new TopologyRouter();
    const calls: string[] = [];
    const run = (cmd: string) => {
      calls.push(cmd);
      return Promise.resolve(makeOkResponse());
    };

    // Attach a session-scoped sink (topology-dependent)
    router.attachBytesSink(makeSink(), { scope: sessionScope(1) });
    expect(calls).toHaveLength(0); // Not ready yet — no bootstrap

    router.onTransportReady(run);
    // Allow the async bootstrap to settle
    await Promise.resolve();
    expect(calls.some((c) => c.includes("list-panes"))).toBe(true);
  });

  it("onTransportReady does NOT trigger bootstrap when only server-scoped sinks exist", async () => {
    const router = new TopologyRouter();
    const calls: string[] = [];
    const run = (cmd: string) => {
      calls.push(cmd);
      return Promise.resolve(makeOkResponse());
    };

    router.attachBytesSink(makeSink()); // default = server scope
    router.onTransportReady(run);
    await Promise.resolve();
    expect(calls).toHaveLength(0);
  });

  it("onTransportClose calls end() on all attached sinks", () => {
    const router = new TopologyRouter();
    const a = makeSink();
    const b = makeSink();
    router.attachBytesSink(a);
    router.attachBytesSink(b, { scope: paneScope(1) });

    router.onTransportClose();
    expect(a.ended).toBe(1);
    expect(b.ended).toBe(1);
  });

  it("onTransportClose makes subsequent disposer calls no-ops (end fires exactly once)", () => {
    const router = new TopologyRouter();
    const sink = makeSink();
    const dispose = router.attachBytesSink(sink);

    router.onTransportClose();
    dispose(); // already closed — must not fire end() again
    expect(sink.ended).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 2. Sink registration and dispatch
// ---------------------------------------------------------------------------

describe("TopologyRouter — sink registration", () => {
  it("dispatchBytes reaches a server-scoped sink for any paneId", () => {
    const router = new TopologyRouter();
    const sink = makeSink();
    router.attachBytesSink(sink); // default scope = server

    const chunk = makeChunk(42);
    router.dispatchBytes(chunk);
    expect(sink.chunks).toHaveLength(1);
    expect(sink.chunks[0]).toBe(chunk);
  });

  it("dispatchBytes reaches a pane-scoped sink only for the matching paneId", () => {
    const router = new TopologyRouter();
    const a = makeSink();
    const b = makeSink();
    router.attachBytesSink(a, { scope: paneScope(1) });
    router.attachBytesSink(b, { scope: paneScope(2) });

    router.dispatchBytes(makeChunk(1));
    expect(a.chunks).toHaveLength(1);
    expect(b.chunks).toHaveLength(0);
  });

  it("disposer calls end() exactly once regardless of how many chunks arrived", () => {
    const router = new TopologyRouter();
    const sink = makeSink();
    const dispose = router.attachBytesSink(sink);

    router.dispatchBytes(makeChunk(1));
    router.dispatchBytes(makeChunk(1));
    dispose();
    dispose(); // idempotent — must not call end() again
    expect(sink.ended).toBe(1);
  });

  it("attachBytesSink triggers bootstrap for session-scoped sink when transport is already ready", async () => {
    const router = new TopologyRouter();
    const calls: string[] = [];
    const run = (cmd: string) => {
      calls.push(cmd);
      return Promise.resolve(makeOkResponse());
    };

    router.onTransportReady(run); // no topology-dependent sinks yet → no bootstrap
    expect(calls).toHaveLength(0);

    router.attachBytesSink(makeSink(), { scope: sessionScope(5) });
    await Promise.resolve();
    expect(calls.some((c) => c.includes("list-panes"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Notification routing
// ---------------------------------------------------------------------------

describe("TopologyRouter — handleNotification topology updates", () => {
  it("window-close removes panes in that window from subsequent dispatch", async () => {
    const router = new TopologyRouter();
    // Seed topology: pane 1 in window 10, session 100
    const run = () =>
      Promise.resolve(makeOkResponse(["%1 @10 $100"]));

    const windowSink = makeSink();
    router.attachBytesSink(windowSink, { scope: windowScope(10) });
    // Attach first so onTransportReady sees a topology-dependent sink and boots.
    router.onTransportReady(run);
    // One microtask tick lets bootstrap's `await run(...)` resolve and seed().
    await Promise.resolve();

    // Before close: pane 1 is in window 10, so window sink gets dispatch
    router.dispatchBytes(makeChunk(1));
    expect(windowSink.chunks).toHaveLength(1);

    // window-close removes the mapping
    router.handleNotification({ type: "window-close", windowId: 10 });

    // After close: pane 1 no longer in topology, window sink no longer matches
    router.dispatchBytes(makeChunk(1));
    expect(windowSink.chunks).toHaveLength(1); // unchanged
  });

  it("window-add triggers a window refresh when topology-dependent sinks exist", async () => {
    const router = new TopologyRouter();
    const calls: string[] = [];
    router.onTransportReady((cmd) => {
      calls.push(cmd);
      return Promise.resolve(makeOkResponse());
    });
    await Promise.resolve();

    // Attach a window-scoped sink to make sinks topology-dependent
    router.attachBytesSink(makeSink(), { scope: windowScope(20) });
    calls.length = 0; // reset after bootstrap

    router.handleNotification({ type: "window-add", windowId: 20 });
    await Promise.resolve();
    expect(calls.some((c) => c.includes("list-panes") && c.includes("@20"))).toBe(true);
  });

  it("sessions-changed triggers a full bootstrap when topology-dependent sinks exist", async () => {
    const router = new TopologyRouter();
    const calls: string[] = [];
    router.onTransportReady((cmd) => {
      calls.push(cmd);
      return Promise.resolve(makeOkResponse());
    });
    await Promise.resolve();

    router.attachBytesSink(makeSink(), { scope: sessionScope(1) });
    calls.length = 0;

    router.handleNotification({ type: "sessions-changed" });
    await Promise.resolve();
    expect(calls.some((c) => c.includes("list-panes -a"))).toBe(true);
  });

  it("pane-scope and server-scope sinks still receive bytes after window-close (topology race safe)", async () => {
    const router = new TopologyRouter();
    router.onTransportReady(noop);
    await Promise.resolve();

    const serverSink = makeSink();
    const paneSink = makeSink();
    router.attachBytesSink(serverSink);
    router.attachBytesSink(paneSink, { scope: paneScope(3) });

    router.handleNotification({ type: "window-close", windowId: 99 });
    router.dispatchBytes(makeChunk(3)); // pane 3 not in topology anymore but pane+server still match
    expect(serverSink.chunks).toHaveLength(1);
    expect(paneSink.chunks).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 4. Topology race protection
// ---------------------------------------------------------------------------

describe("TopologyRouter — topology race protection (single epoch mechanism)", () => {
  it("synchronous window-close supersedes a stale async list-panes response", async () => {
    const router = new TopologyRouter();
    let resolveListPanes!: (r: CommandResponse) => void;
    const run = (cmd: string) => {
      if (cmd.includes("list-panes -a")) {
        return new Promise<CommandResponse>((res) => {
          resolveListPanes = res;
        });
      }
      return Promise.resolve(makeOkResponse());
    };

    router.attachBytesSink(makeSink(), { scope: sessionScope(1) });
    router.onTransportReady(run); // bootstrap starts, hangs

    // Synchronous window-close invalidates the in-flight bootstrap epoch
    router.handleNotification({ type: "window-close", windowId: 10 });

    // Now let the stale list-panes respond with pane 1 in window 10
    resolveListPanes(makeOkResponse(["%1 @10 $100"]));
    await Promise.resolve();
    await Promise.resolve();

    // The stale response must NOT have seeded pane 1 in the topology
    const windowSink = makeSink();
    router.attachBytesSink(windowSink, { scope: windowScope(10) });
    router.dispatchBytes(makeChunk(1));
    expect(windowSink.chunks).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 5. endAll contract
// ---------------------------------------------------------------------------

describe("TopologyRouter — onTransportClose endAll contract", () => {
  it("ends all sinks across all scope types", () => {
    const router = new TopologyRouter();
    const server = makeSink();
    const session = makeSink();
    const window = makeSink();
    const pane = makeSink();
    router.attachBytesSink(server);
    router.attachBytesSink(session, { scope: sessionScope(1) });
    router.attachBytesSink(window, { scope: windowScope(2) });
    router.attachBytesSink(pane, { scope: paneScope(3) });

    router.onTransportClose();
    expect(server.ended).toBe(1);
    expect(session.ended).toBe(1);
    expect(window.ended).toBe(1);
    expect(pane.ended).toBe(1);
  });

  it("ends sinks only once when both onTransportClose and disposer are called", () => {
    const router = new TopologyRouter();
    const sink = makeSink();
    const dispose = router.attachBytesSink(sink);

    router.onTransportClose();
    dispose();
    expect(sink.ended).toBe(1);
  });
});
