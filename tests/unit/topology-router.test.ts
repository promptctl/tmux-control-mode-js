// tests/unit/topology-router.test.ts
// Unit tests for TopologyRouter — the shared substrate component.
//
// Tests are derived from the type-shape design's promises, not from any
// implementation detail. Each test names the behavior it asserts.

import { describe, expect, it } from "vitest";

import { HELD_BYTES_LIMIT, TopologyRouter } from "../../src/topology-router.js";
import type { TopologyRouterOptions } from "../../src/topology-router.js";
import type { BytesSink, ChunkPayload } from "../../src/pane-output.js";
import { windowScope, sessionScope, paneScope } from "../../src/pane-output.js";
import type { CommandResponse } from "../../src/protocol/types.js";
import { windowLayoutFields } from "../../src/protocol/layout.js";

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

// Most tests do not exercise bootstrap failure — supply a no-op topology-error
// reporter. The failure/recovery suite below builds its own router with a
// capturing reporter.
function newRouter(options?: TopologyRouterOptions): TopologyRouter {
  return new TopologyRouter(() => undefined, options);
}

// ---------------------------------------------------------------------------
// 1. Transport lifecycle
// ---------------------------------------------------------------------------

describe("TopologyRouter — transport lifecycle", () => {
  it("onTransportReady provides the runCommand and triggers bootstrap when topology-dependent sinks exist", async () => {
    const router = newRouter();
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
    const router = newRouter();
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
    const router = newRouter();
    const a = makeSink();
    const b = makeSink();
    router.attachBytesSink(a);
    router.attachBytesSink(b, { scope: paneScope(1) });

    router.onTransportClose();
    expect(a.ended).toBe(1);
    expect(b.ended).toBe(1);
  });

  it("onTransportClose makes subsequent disposer calls no-ops (end fires exactly once)", () => {
    const router = newRouter();
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
    const router = newRouter();
    const sink = makeSink();
    router.attachBytesSink(sink); // default scope = server

    const chunk = makeChunk(42);
    router.dispatchBytes(chunk);
    expect(sink.chunks).toHaveLength(1);
    expect(sink.chunks[0]).toBe(chunk);
  });

  it("dispatchBytes reaches a pane-scoped sink only for the matching paneId", () => {
    const router = newRouter();
    const a = makeSink();
    const b = makeSink();
    router.attachBytesSink(a, { scope: paneScope(1) });
    router.attachBytesSink(b, { scope: paneScope(2) });

    router.dispatchBytes(makeChunk(1));
    expect(a.chunks).toHaveLength(1);
    expect(b.chunks).toHaveLength(0);
  });

  it("disposer calls end() exactly once regardless of how many chunks arrived", () => {
    const router = newRouter();
    const sink = makeSink();
    const dispose = router.attachBytesSink(sink);

    router.dispatchBytes(makeChunk(1));
    router.dispatchBytes(makeChunk(1));
    dispose();
    dispose(); // idempotent — must not call end() again
    expect(sink.ended).toBe(1);
  });

  it("attachBytesSink triggers bootstrap for session-scoped sink when transport is already ready", async () => {
    const router = newRouter();
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
    const router = newRouter();
    // Seed topology: pane 1 in window 10, session 100
    const run = () => Promise.resolve(makeOkResponse(["%1 @10 $100"]));

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
    const router = newRouter();
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
    expect(
      calls.some((c) => c.includes("list-panes") && c.includes("@20")),
    ).toBe(true);
  });

  it("sessions-changed triggers a full bootstrap when topology-dependent sinks exist", async () => {
    const router = newRouter();
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
    const router = newRouter();
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
    const router = newRouter();
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
    const router = newRouter();
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
    const router = newRouter();
    const sink = makeSink();
    const dispose = router.attachBytesSink(sink);

    router.onTransportClose();
    dispose();
    expect(sink.ended).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 6. Bootstrap failure is observable and non-terminal
//
// [LAW:no-silent-failure] A failed `list-panes -a` must not silently leave
//   session/window-scoped sinks starved. The router reports the failure through
//   its injected seam, and the failure is recoverable via the existing
//   event-driven bootstrap triggers.
// ---------------------------------------------------------------------------

describe("TopologyRouter — bootstrap failure surfacing", () => {
  // A router whose reporter captures reported errors, plus a controllable
  // list-panes runCommand that can be flipped from rejecting to succeeding.
  function makeFailingSetup(firstOutcome: "reject" | "ok") {
    const errors: Error[] = [];
    const router = new TopologyRouter((e) => errors.push(e));
    let listPanesShouldReject = firstOutcome === "reject";
    const run = (cmd: string): Promise<CommandResponse> => {
      if (cmd.includes("list-panes -a")) {
        return listPanesShouldReject
          ? Promise.reject(new Error("list-panes failed: no server"))
          : Promise.resolve(makeOkResponse(["%1 @10 $100"]));
      }
      return Promise.resolve(makeOkResponse());
    };
    return {
      errors,
      router,
      run,
      recover() {
        listPanesShouldReject = false;
      },
    };
  }

  it("reports a topology error when the bootstrap command rejects", async () => {
    const { errors, router, run } = makeFailingSetup("reject");

    router.attachBytesSink(makeSink(), { scope: sessionScope(100) });
    router.onTransportReady(run);
    await Promise.resolve();
    await Promise.resolve();

    // (a) The failure is a consumer-visible signal, not a swallowed catch.
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(Error);
    // Self-describing prefix so a consumer logging only `.message` sees the
    // bootstrap context; the original is preserved as `.cause`.
    expect(errors[0]?.message).toMatch(/^topology bootstrap failed:/);
    expect(errors[0]?.message).toContain("list-panes failed");
    expect((errors[0] as Error & { cause?: unknown })?.cause).toBeInstanceOf(
      Error,
    );
  });

  it("does NOT report when the bootstrap succeeds (empty tmux is not a failure)", async () => {
    const errors: Error[] = [];
    const router = new TopologyRouter((e) => errors.push(e));

    router.attachBytesSink(makeSink(), { scope: sessionScope(100) });
    // Succeeds with zero panes — a genuinely empty tmux, not a failure.
    router.onTransportReady(() => Promise.resolve(makeOkResponse([])));
    await Promise.resolve();
    await Promise.resolve();

    expect(errors).toHaveLength(0);
  });

  it("a session-scoped sink starts receiving after a later bootstrap succeeds (non-terminal)", async () => {
    const { errors, router, run, recover } = makeFailingSetup("reject");

    const sink = makeSink();
    router.attachBytesSink(sink, { scope: sessionScope(100) });
    router.onTransportReady(run);
    await Promise.resolve();
    await Promise.resolve();

    // Failure surfaced, and the sink is (correctly) starved: topology is empty,
    // so a session-scoped chunk matches nothing.
    expect(errors).toHaveLength(1);
    router.dispatchBytes(makeChunk(1));
    expect(sink.chunks).toHaveLength(0);

    // (b) Recovery: the command heals and an existing re-bootstrap trigger fires.
    recover();
    router.handleNotification({ type: "sessions-changed" });
    await Promise.resolve();
    await Promise.resolve();

    // Pane 1 (session 100) is now in topology, so the session sink receives it.
    router.dispatchBytes(makeChunk(1));
    expect(sink.chunks).toHaveLength(1);
  });

  // A router driving a NON-FIFO transport: bootstrap A hangs while a newer
  // bootstrap B runs to completion, then A rejects. This is the reviewer's
  // concurrent-bootstrap scenario.
  it("suppresses a superseded bootstrap's failure — a newer bootstrap owns the outcome", async () => {
    const errors: Error[] = [];
    const router = new TopologyRouter((e) => errors.push(e));
    let rejectA!: (e: Error) => void;
    let call = 0;
    const run = (cmd: string): Promise<CommandResponse> => {
      if (cmd.includes("list-panes -a")) {
        call++;
        if (call === 1) {
          // Bootstrap A: hangs until we reject it below.
          return new Promise<CommandResponse>((_res, rej) => {
            rejectA = rej;
          });
        }
        // Bootstrap B (the superseding attempt): succeeds and seeds.
        return Promise.resolve(makeOkResponse(["%1 @10 $100"]));
      }
      return Promise.resolve(makeOkResponse());
    };

    router.attachBytesSink(makeSink(), { scope: sessionScope(100) });
    router.onTransportReady(run); // starts bootstrap A (hangs)
    router.handleNotification({ type: "sessions-changed" }); // starts bootstrap B
    await Promise.resolve();
    await Promise.resolve();

    // B has seeded a healthy topology. A's late rejection is superseded, so it
    // must NOT raise a false alarm on the now-healthy connection.
    rejectA(new Error("stale A failure"));
    await Promise.resolve();
    await Promise.resolve();

    expect(errors).toHaveLength(0);
  });

  // Distinguishes the correct guard (`isLatestBootstrap`) from the naive one
  // (`isBootstrapCurrent`): a window-close bumps the bootstrap epoch but starts
  // NO replacement, so a genuine failure here would be silently swallowed by the
  // naive guard — the exact silent-starve this PR removes.
  it("reports a failure whose epoch was bumped only by a window-close (no successor bootstrap)", async () => {
    const errors: Error[] = [];
    const router = new TopologyRouter((e) => errors.push(e));
    let rejectA!: (e: Error) => void;
    const run = (cmd: string): Promise<CommandResponse> => {
      if (cmd.includes("list-panes -a")) {
        return new Promise<CommandResponse>((_res, rej) => {
          rejectA = rej;
        });
      }
      return Promise.resolve(makeOkResponse());
    };

    router.attachBytesSink(makeSink(), { scope: sessionScope(100) });
    router.onTransportReady(run); // bootstrap A (hangs)
    // window-close invalidates the in-flight bootstrap's epoch but starts none.
    router.handleNotification({ type: "window-close", windowId: 5 });
    rejectA(new Error("real bootstrap failure"));
    await Promise.resolve();
    await Promise.resolve();

    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain("real bootstrap failure");
  });

  it("does NOT report a bootstrap failure that arrives after onTransportClose (shutdown artifact)", async () => {
    const errors: Error[] = [];
    const router = new TopologyRouter((e) => errors.push(e));
    let rejectA!: (e: Error) => void;
    const run = (cmd: string): Promise<CommandResponse> => {
      if (cmd.includes("list-panes -a")) {
        return new Promise<CommandResponse>((_res, rej) => {
          rejectA = rej;
        });
      }
      return Promise.resolve(makeOkResponse());
    };

    router.attachBytesSink(makeSink(), { scope: sessionScope(100) });
    router.onTransportReady(run); // bootstrap A (hangs)
    router.onTransportClose(); // nulls runCommand — connection-state:closed owns this
    rejectA(new Error("close 1006"));
    await Promise.resolve();
    await Promise.resolve();

    // The close event already represents the failure; no misleading second signal.
    expect(errors).toHaveLength(0);
  });

  // Isolates the IDENTITY guard (`this.runCommand !== run`) from the value-only
  // `=== null` check: the transport closes and REOPENS (ABA) before the stale
  // bootstrap rejects. onTransportClose ends the sinks, so the reopen starts no
  // new bootstrap — `isLatestBootstrap` stays true for the stale attempt, and
  // only the identity comparison suppresses it. A `=== null` guard would report
  // on the healthy reconnected connection (runCommand is the new, non-null runner).
  it("does NOT report a stale bootstrap failure after the transport closed and reopened (reconnect/ABA)", async () => {
    const errors: Error[] = [];
    const router = new TopologyRouter((e) => errors.push(e));
    let rejectA!: (e: Error) => void;
    const runA = (cmd: string): Promise<CommandResponse> =>
      cmd.includes("list-panes -a")
        ? new Promise<CommandResponse>((_res, rej) => {
            rejectA = rej;
          })
        : Promise.resolve(makeOkResponse());

    router.attachBytesSink(makeSink(), { scope: sessionScope(100) });
    router.onTransportReady(runA); // bootstrap A on transport episode 1 (hangs)
    await Promise.resolve();

    // Reconnect: close (ends sinks) then reopen with a NEW runner.
    router.onTransportClose();
    router.onTransportReady(() => Promise.resolve(makeOkResponse()));

    // A (dead episode 1) finally rejects. runCommand is now the new runner, so a
    // value-only guard would misreport; the identity guard suppresses it.
    rejectA(new Error("close 1006"));
    await Promise.resolve();
    await Promise.resolve();

    expect(errors).toHaveLength(0);
  });

  it("normalizes a non-Error, non-string-coercible rejection without itself throwing", async () => {
    const errors: Error[] = [];
    const router = new TopologyRouter((e) => errors.push(e));
    // A null-prototype object: `String(value)` throws on it, so bootstrapError
    // must fall back rather than convert the rejection into an unhandled one.
    const weird = Object.create(null) as object;
    const run = (cmd: string): Promise<CommandResponse> =>
      cmd.includes("list-panes -a")
        ? Promise.reject(weird)
        : Promise.resolve(makeOkResponse());

    router.attachBytesSink(makeSink(), { scope: sessionScope(100) });
    router.onTransportReady(run);
    await Promise.resolve();
    await Promise.resolve();

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(Error);
    expect(errors[0]?.message).toMatch(/^topology bootstrap failed:/);
    // The raw thrown value is preserved as `.cause`.
    expect((errors[0] as Error & { cause?: unknown })?.cause).toBe(weird);
  });
});

// ---------------------------------------------------------------------------
// Held chunks: output for a pane topology does not know yet, while a query
// that may place it is in flight, reaches topology-scoped sinks once placed.
// ---------------------------------------------------------------------------

describe("TopologyRouter — chunks that arrive before topology places their pane", () => {
  // A runner whose replies the test releases one at a time, in order.
  function controlledRun() {
    const replies: {
      cmd: string;
      resolve: (r: CommandResponse) => void;
      reject: (e: unknown) => void;
    }[] = [];
    const run = (cmd: string) =>
      new Promise<CommandResponse>((resolve, reject) => {
        replies.push({ cmd, resolve, reject });
      });
    return { run, replies };
  }
  const settle = () => new Promise<void>((r) => setTimeout(r, 0));
  const paneIdsOf = (s: ReturnType<typeof makeSink>) =>
    s.chunks.map((c) => c.paneId);

  it("delivers a chunk that beat the attach-triggered bootstrap once it lands", async () => {
    const router = newRouter();
    const { run, replies } = controlledRun();
    router.onTransportReady(run);
    const sink = makeSink();
    router.attachBytesSink(sink, { scope: sessionScope(1) });

    router.dispatchBytes(makeChunk(5));
    expect(sink.chunks).toHaveLength(0);

    replies[0]!.resolve(makeOkResponse(["%5 @2 $1"]));
    await settle();
    expect(paneIdsOf(sink)).toEqual([5]);
  });

  it("delivers a chunk that beat a window-add refresh once it lands", async () => {
    const router = newRouter();
    const { run, replies } = controlledRun();
    router.onTransportReady(run);
    const sink = makeSink();
    router.attachBytesSink(sink, { scope: windowScope(3) });
    replies[0]!.resolve(makeOkResponse([]));
    await settle();

    router.handleNotification({ type: "window-add", windowId: 3 });
    router.dispatchBytes(makeChunk(7));
    expect(sink.chunks).toHaveLength(0);
    replies[1]!.resolve(makeOkResponse(["%7 @3 $1"]));
    await settle();
    expect(paneIdsOf(sink)).toEqual([7]);
  });

  it("keeps per-pane order: a held chunk is replayed before later chunks", async () => {
    const router = newRouter();
    const { run, replies } = controlledRun();
    router.onTransportReady(run);
    const sink = makeSink();
    router.attachBytesSink(sink, { scope: sessionScope(1) });

    router.dispatchBytes(makeChunk(5, new Uint8Array([1])));
    replies[0]!.resolve(makeOkResponse(["%5 @2 $1"]));
    await settle();
    router.dispatchBytes(makeChunk(5, new Uint8Array([2])));
    expect(sink.chunks.map((c) => c.data[0])).toEqual([1, 2]);
  });

  it("does not replay to a sink attached after the chunk arrived", async () => {
    const router = newRouter();
    const { run, replies } = controlledRun();
    router.onTransportReady(run);
    const early = makeSink();
    router.attachBytesSink(early, { scope: sessionScope(1) });
    router.dispatchBytes(makeChunk(5));
    const late = makeSink();
    router.attachBytesSink(late, { scope: sessionScope(1) });

    for (const r of replies) r.resolve(makeOkResponse(["%5 @2 $1"]));
    await settle();
    expect(paneIdsOf(early)).toEqual([5]);
    expect(late.chunks).toHaveLength(0);
  });

  it("does not duplicate the chunk to pane- or server-scoped sinks", async () => {
    const router = newRouter();
    const { run, replies } = controlledRun();
    router.onTransportReady(run);
    router.attachBytesSink(makeSink(), { scope: sessionScope(1) });
    const server = makeSink();
    const pane = makeSink();
    router.attachBytesSink(server);
    router.attachBytesSink(pane, { scope: paneScope(5) });

    router.dispatchBytes(makeChunk(5));
    replies[0]!.resolve(makeOkResponse(["%5 @2 $1"]));
    await settle();
    expect(paneIdsOf(server)).toEqual([5]);
    expect(paneIdsOf(pane)).toEqual([5]);
  });

  it("waits for the superseding bootstrap rather than dropping at the stale one", async () => {
    const router = newRouter();
    const { run, replies } = controlledRun();
    router.onTransportReady(run);
    const sink = makeSink();
    router.attachBytesSink(sink, { scope: sessionScope(1) });
    router.dispatchBytes(makeChunk(5));
    router.handleNotification({ type: "sessions-changed" });

    replies[0]!.resolve(makeOkResponse([])); // stale, places nothing
    await settle();
    expect(sink.chunks).toHaveLength(0);
    replies[1]!.resolve(makeOkResponse(["%5 @2 $1"]));
    await settle();
    expect(paneIdsOf(sink)).toEqual([5]);
  });

  it("re-queries when a window-close makes the only bootstrap stale", async () => {
    const router = newRouter();
    const { run, replies } = controlledRun();
    router.onTransportReady(run);
    const sink = makeSink();
    router.attachBytesSink(sink, { scope: sessionScope(1) });
    router.handleNotification({ type: "window-close", windowId: 9 });
    router.dispatchBytes(makeChunk(5));

    replies[0]!.resolve(makeOkResponse(["%5 @2 $1"])); // stale: closed @9
    replies[1]!.reject(new Error("can't find window: @9"));
    await settle();
    expect(replies).toHaveLength(3);
    expect(sink.chunks).toHaveLength(0);
    replies[2]!.resolve(makeOkResponse(["%5 @2 $1"]));
    await settle();
    expect(paneIdsOf(sink)).toEqual([5]);
  });

  it("a superseded refresh that fails does not remove the window", async () => {
    const router = newRouter();
    const { run, replies } = controlledRun();
    router.onTransportReady(run);
    const sink = makeSink();
    router.attachBytesSink(sink, { scope: windowScope(3) });
    replies[0]!.resolve(makeOkResponse(["%7 @3 $1"]));
    await settle();

    router.handleNotification({ type: "window-add", windowId: 3 });
    router.handleNotification({ type: "window-add", windowId: 3 });
    replies[2]!.resolve(makeOkResponse(["%7 @3 $1"]));
    await settle();
    replies[1]!.reject(new Error("stale refresh failed"));
    await settle();
    router.dispatchBytes(makeChunk(7));
    expect(paneIdsOf(sink)).toEqual([7]);
  });

  it("re-queries when a window-add makes the only bootstrap stale", async () => {
    // move-window during the bootstrap: its reply can list @9 in its old
    // session, and move-window sends no layout to correct it.
    const router = newRouter();
    const { run, replies } = controlledRun();
    router.onTransportReady(run);
    const sink = makeSink();
    router.attachBytesSink(sink, { scope: sessionScope(1) });
    router.handleNotification({ type: "window-add", windowId: 9 });
    router.dispatchBytes(makeChunk(5));

    replies[0]!.resolve(makeOkResponse(["%5 @9 $2"])); // stale: before the move
    replies[1]!.resolve(makeOkResponse(["%5 @9 $1"])); // superseded by the re-query
    await settle();
    expect(replies).toHaveLength(3);
    expect(sink.chunks).toHaveLength(0);
    replies[2]!.resolve(makeOkResponse(["%5 @9 $1"]));
    await settle();
    expect(paneIdsOf(sink)).toEqual([5]);
  });

  it("drops held chunks once no query can place them (failed bootstrap)", async () => {
    const router = newRouter();
    const { run, replies } = controlledRun();
    router.onTransportReady(run);
    const sink = makeSink();
    router.attachBytesSink(sink, { scope: sessionScope(1) });
    router.dispatchBytes(makeChunk(5));
    replies[0]!.reject(new Error("boom"));
    await settle();

    // A later bootstrap placing %5 must not resurrect the dropped chunk.
    router.handleNotification({ type: "sessions-changed" });
    replies[1]!.resolve(makeOkResponse(["%5 @2 $1"]));
    await settle();
    expect(sink.chunks).toHaveLength(0);
  });

  it("replays the bytes as they arrived, not a buffer reused since", async () => {
    const router = newRouter();
    const { run, replies } = controlledRun();
    router.onTransportReady(run);
    const sink = makeSink();
    router.attachBytesSink(sink, { scope: sessionScope(1) });
    const buf = new Uint8Array([1]);
    router.dispatchBytes(makeChunk(5, buf));
    buf[0] = 9;

    replies[0]!.resolve(makeOkResponse(["%5 @2 $1"]));
    await settle();
    expect(sink.chunks.map((c) => c.data[0])).toEqual([1]);
  });

  it("refuses output past the hold cap and reports it", async () => {
    const errors: Error[] = [];
    const router = new TopologyRouter((e) => errors.push(e));
    const { run, replies } = controlledRun();
    router.onTransportReady(run);
    const sink = makeSink();
    router.attachBytesSink(sink, { scope: sessionScope(1) });
    router.dispatchBytes(makeChunk(5, new Uint8Array(HELD_BYTES_LIMIT)));
    router.dispatchBytes(makeChunk(5, new Uint8Array(1)));

    replies[0]!.resolve(makeOkResponse(["%5 @2 $1"]));
    await settle();
    expect(sink.chunks.map((c) => c.data.byteLength)).toEqual([
      HELD_BYTES_LIMIT,
    ]);
    expect(errors.map((e) => e.message)).toEqual([
      expect.stringMatching(/^topology hold overflow: 1 bytes/),
    ]);
  });

  // %4 and %5 start in @2/$1, %6 in @3/$2. Another client moves %5 into @3,
  // and %4 and %5 print before the refreshes that follow the move reply.
  const LAYOUT_4 = "b261,80x24,0,0,4";
  const LAYOUT_6_5 = "821f,80x24,0,0{40x24,0,0,6,39x24,41,0,5}";
  const BEFORE = ["%4 @2 $1", "%5 @2 $1", "%6 @3 $2"];
  const AFTER = { 2: ["%4 @2 $1"], 3: ["%6 @3 $2", "%5 @3 $2"] };

  // Answer the latest refresh of `@windowId` with the post-move panes.
  function answerRefresh(
    replies: ReturnType<typeof controlledRun>["replies"],
    windowId: 2 | 3,
  ) {
    const r = [...replies]
      .reverse()
      .find((q) => q.cmd.includes(`-t @${windowId} `));
    if (r === undefined)
      throw new Error(`expected a list-panes -t @${windowId} refresh`);
    r.resolve(makeOkResponse(AFTER[windowId]));
  }

  function answerRefreshWith(
    replies: ReturnType<typeof controlledRun>["replies"],
    windowId: number,
    lines: string[],
  ) {
    const r = replies.at(-1);
    if (r === undefined || !r.cmd.includes(`-t @${windowId} `))
      throw new Error(`expected a list-panes -t @${windowId} refresh`);
    r.resolve(makeOkResponse(lines));
  }

  function layoutChange(windowId: number, layout: string) {
    return {
      type: "layout-change" as const,
      windowId,
      ...windowLayoutFields(layout, layout, "*"),
    };
  }

  async function movedPane(layoutChanges: [number, string][]) {
    const router = newRouter();
    const { run, replies } = controlledRun();
    router.onTransportReady(run);
    const oldSession = makeSink();
    const newSession = makeSink();
    const newWindow = makeSink();
    const pane = makeSink();
    router.attachBytesSink(oldSession, { scope: sessionScope(1) });
    router.attachBytesSink(newSession, { scope: sessionScope(2) });
    router.attachBytesSink(newWindow, { scope: windowScope(3) });
    router.attachBytesSink(pane, { scope: paneScope(5) });
    for (const r of replies.splice(0)) r.resolve(makeOkResponse(BEFORE));
    await settle();
    for (const [windowId, layout] of layoutChanges) {
      router.handleNotification(layoutChange(windowId, layout));
    }
    router.dispatchBytes(makeChunk(4));
    router.dispatchBytes(makeChunk(5));
    return { router, replies, oldSession, newSession, newWindow, pane };
  }

  it("routes a moved pane's output to its new window and session, not its old ones", async () => {
    const s = await movedPane([
      [2, LAYOUT_4],
      [3, LAYOUT_6_5],
    ]);
    expect(paneIdsOf(s.pane)).toEqual([5]);
    expect(paneIdsOf(s.oldSession)).toEqual([4]);

    answerRefresh(s.replies, 2);
    await settle();
    answerRefresh(s.replies, 3);
    await settle();
    expect(paneIdsOf(s.oldSession)).toEqual([4]);
    expect(paneIdsOf(s.newSession)).toEqual([5]);
    expect(paneIdsOf(s.newWindow)).toEqual([5]);
  });

  it("routes a moved pane correctly when the new window's refresh lands first", async () => {
    const s = await movedPane([
      [2, LAYOUT_4],
      [3, LAYOUT_6_5],
    ]);
    answerRefresh(s.replies, 3);
    await settle();
    expect(paneIdsOf(s.newSession)).toEqual([5]);
    answerRefresh(s.replies, 2);
    await settle();
    expect(paneIdsOf(s.oldSession)).toEqual([4]);
    expect(paneIdsOf(s.newSession)).toEqual([5]);
  });

  // tmux sends %layout-change only for windows in the attached session, so a
  // pane joined in from another session's window announces itself only in
  // the destination's layout.
  it("routes a pane moved in from an unannounced window to its new session", async () => {
    const s = await movedPane([[3, LAYOUT_6_5]]);
    expect(paneIdsOf(s.oldSession)).toEqual([4]);
    answerRefresh(s.replies, 2);
    answerRefresh(s.replies, 3);
    await settle();
    expect(paneIdsOf(s.oldSession)).toEqual([4]);
    expect(paneIdsOf(s.newSession)).toEqual([5]);
  });

  // tmux 3.8 leaves floating panes out of the layout, so a floating pane
  // missing from it is not evidence it moved.
  it("keeps routing a floating pane live through its window's layout changes", async () => {
    const router = newRouter();
    const { run, replies } = controlledRun();
    router.onTransportReady(run);
    const sink = makeSink();
    router.attachBytesSink(sink, { scope: sessionScope(1) });
    replies[0]!.resolve(makeOkResponse(["%4 @2 $1 0", "%5 @2 $1 1"]));
    await settle();
    router.handleNotification(layoutChange(2, LAYOUT_4));
    router.dispatchBytes(makeChunk(5));
    expect(paneIdsOf(sink)).toEqual([5]);
  });

  it("routes a pane broken out of its window to the window it lands in", async () => {
    // break-pane: the source layout omits the pane, then %window-add.
    const s = await movedPane([[2, LAYOUT_4]]);
    s.router.handleNotification({ type: "window-add", windowId: 3 });
    expect(paneIdsOf(s.oldSession)).toEqual([4]);
    answerRefresh(s.replies, 2);
    answerRefresh(s.replies, 3);
    await settle();
    expect(paneIdsOf(s.oldSession)).toEqual([4]);
    expect(paneIdsOf(s.newSession)).toEqual([5]);
  });

  it("routes a window moved in from another session to its new session", async () => {
    // move-window: only %window-add; the window keeps its id and panes.
    const s = await movedPane([]);
    s.router.handleNotification({ type: "window-add", windowId: 2 });
    s.router.dispatchBytes(makeChunk(4));
    expect(paneIdsOf(s.oldSession)).toEqual([4, 5]);
    answerRefreshWith(s.replies, 2, ["%4 @2 $2"]);
    await settle();
    expect(paneIdsOf(s.oldSession)).toEqual([4, 5]);
    expect(paneIdsOf(s.newSession)).toEqual([4]);
  });

  it("keeps a window that a close only unlinked from another session", async () => {
    const s = await movedPane([]);
    s.router.handleNotification({ type: "window-close", windowId: 2 });
    s.router.dispatchBytes(makeChunk(4));
    answerRefreshWith(s.replies, 2, ["%4 @2 $1"]);
    await settle();
    expect(paneIdsOf(s.oldSession)).toEqual([4, 5, 4]);
  });

  it("removes a closed window once its refresh finds it gone", async () => {
    const s = await movedPane([]);
    s.router.handleNotification({ type: "window-close", windowId: 2 });
    s.replies.at(-1)!.reject(new Error("can't find window: @2"));
    await settle();
    s.router.dispatchBytes(makeChunk(4));
    expect(paneIdsOf(s.oldSession)).toEqual([4, 5]);
  });

  it("does not let a bootstrap sent before a move put the moved pane back", async () => {
    const router = newRouter();
    const { run, replies } = controlledRun();
    router.onTransportReady(run);
    const oldSession = makeSink();
    const newSession = makeSink();
    router.attachBytesSink(oldSession, { scope: sessionScope(1) });
    router.attachBytesSink(newSession, { scope: sessionScope(2) });
    const bootstraps = replies.splice(0);
    router.handleNotification(layoutChange(3, LAYOUT_6_5));
    for (const r of bootstraps) r.resolve(makeOkResponse(BEFORE));
    await settle();
    router.dispatchBytes(makeChunk(5));
    expect(oldSession.chunks).toHaveLength(0);
    answerRefresh(replies, 2);
    answerRefresh(replies, 3);
    await settle();
    expect(oldSession.chunks).toHaveLength(0);
    expect(paneIdsOf(newSession)).toEqual([5]);
  });
});
