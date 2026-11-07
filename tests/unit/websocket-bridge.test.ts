// tests/unit/websocket-bridge.test.ts
// Unit tests for the WebSocket bridge server using a fake ServerWebSocketLike
// and a real TmuxClient over a fake TmuxTransport.
//
// What's hard to test in tests/integration/websocket-bridge.test.ts:
//   - Backpressure thresholds tied to ws.bufferedAmount — real OS send
//     buffers don't fill up under test load, so a real `ws` connection's
//     bufferedAmount stays at 0 and the watermark loop never trips.
//   - Per-call interception of subscribe/unsubscribe — under a real socket
//     these involve a tmux round-trip; here we drive them synchronously.
//
// The fake socket in this file is a thin imitation of the `ws` package's
// server-side API: enough surface to satisfy ServerWebSocketLike, plus a
// test hook to set bufferedAmount for the watermark probes.

import { describe, it, expect, vi } from "vitest";

import { TmuxClient } from "../../src/client.js";
import type { TmuxTransport } from "../../src/transport/types.js";

import { createWebSocketBridge } from "../../src/connectors/websocket/server.js";
import type { BridgeObservabilityEvent } from "../../src/connectors/websocket/types.js";
import {
  encodeClientFrame,
  parseServerFrame,
  type FatalErrorFrame,
  type ResultErrFrame,
  type ResultOkFrame,
  type ServerFrame,
} from "../../src/connectors/websocket/protocol.js";
import {
  WEBSOCKET_OPEN,
  type ServerWebSocketLike,
} from "../../src/connectors/websocket/types.js";
import { STARTUP_GREETING } from "./_helpers/greeting.js";
import { windowLayoutFields } from "../../src/protocol/layout.js";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FakeWs extends ServerWebSocketLike {
  // Test-only: drive the OS-buffer signal the watermark loop reads. Default
  // is 0 (fast client); raise it to simulate a slow consumer whose OS send
  // buffer is filling up.
  bufferedAmount: number;
  setBuffered(n: number): void;
  feedClient(frame: object): void;
  fireClose(code?: number, reason?: string): void;
  // Drained on every `send` call — string for JSON frames, Uint8Array for
  // binary pane-output frames.
  readonly outbound: (string | Uint8Array)[];
  // Every `close(code, reason)` the bridge issued, so the close reason it
  // hands the peer is assertable.
  readonly closeCalls: { code?: number; reason?: string }[];
}

function createFakeWs(): FakeWs {
  let buffered = 0;
  interface Listeners {
    message?: (data: unknown, isBinary: boolean) => void;
    close?: (code: number, reason: Buffer | string) => void;
    error?: (err: Error) => void;
    pong?: () => void;
    ping?: () => void;
  }
  const listeners: Listeners = {};

  const outbound: (string | Uint8Array)[] = [];
  const closeCalls: { code?: number; reason?: string }[] = [];
  let readyState: number = WEBSOCKET_OPEN;

  const ws: FakeWs = {
    get readyState() {
      return readyState;
    },
    get bufferedAmount() {
      return buffered;
    },
    set bufferedAmount(n: number) {
      buffered = n;
    },
    setBuffered(n) {
      buffered = n;
    },
    feedClient(frame) {
      listeners.message?.(encodeClientFrame(frame as never), false);
    },
    fireClose(code = 1000, reason = "") {
      readyState = 3;
      listeners.close?.(code, reason);
    },
    outbound,
    closeCalls,

    send(data) {
      if (typeof data === "string") {
        outbound.push(data);
      } else if (data instanceof Uint8Array) {
        outbound.push(data);
      } else if (ArrayBuffer.isView(data)) {
        // ArrayBufferView (DataView, typed arrays other than Uint8Array) —
        // wrap the underlying buffer with the view's offset/length so the
        // copy reflects the view, not the entire backing buffer. The bridge
        // only sends Uint8Array binary frames today, so this branch is
        // reachable only if a future encoder switches representations.
        const view = data as ArrayBufferView;
        outbound.push(
          new Uint8Array(view.buffer, view.byteOffset, view.byteLength),
        );
      } else {
        // Raw ArrayBuffer.
        outbound.push(new Uint8Array(data as ArrayBuffer));
      }
    },
    ping() {
      // Fake auto-replies pong synchronously so heartbeat code stays happy.
      listeners.pong?.();
    },
    close(code?: number, reason?: string) {
      readyState = 3;
      closeCalls.push({ code, reason });
    },
    terminate() {
      readyState = 3;
    },
    // The bridge supports either typed event channel (`on('message', ...)`,
    // etc.). We type-erase here to avoid duplicating every overload in the
    // structural ServerWebSocketLike definition.
    on(event: string, listener: (...args: unknown[]) => unknown) {
      (listeners as Record<string, unknown>)[event] = listener;
    },
  } as FakeWs;

  return ws;
}

interface FakeTransport {
  readonly transport: TmuxTransport;
  readonly sent: string[];
  feed(chunk: string): void;
}

function createFakeTransport(): FakeTransport {
  let dataCb: ((chunk: string) => void) | null = null;
  let closeCb: ((reason?: string) => void) | null = null;
  const sent: string[] = [];
  const transport: TmuxTransport = {
    send(cmd) {
      sent.push(cmd);
      return { ok: true };
    },
    onData(cb) {
      dataCb = cb;
    },
    onClose(cb) {
      closeCb = cb;
    },
    close() {
      closeCb?.("closed");
    },
  };
  return {
    transport,
    sent,
    feed(chunk) {
      dataCb?.(chunk);
    },
  };
}

function feedCommandResponse(
  t: FakeTransport,
  commandNumber: number,
  outputLines: readonly string[] = [],
): void {
  t.feed(`%begin ${commandNumber} ${commandNumber} 0\n`);
  for (const line of outputLines) t.feed(line + "\n");
  t.feed(`%end ${commandNumber} ${commandNumber} 0\n`);
}

function readJsonFrames(ws: FakeWs): ServerFrame[] {
  return ws.outbound
    .filter((f): f is string => typeof f === "string")
    .map((f) => parseServerFrame(f));
}

// ---------------------------------------------------------------------------
// Subscription scoping (audit C2 mirror)
// ---------------------------------------------------------------------------

describe("WebSocket bridge — qz5.5 C2 subscription scoping", () => {
  it("rejects unsubscribe of a name the connection does not own", async () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    t.feed(STARTUP_GREETING);
    const bridge = createWebSocketBridge({ createClient: () => client });

    // Connection A (the only owner of "focus").
    const wsA = createFakeWs();
    void bridge.handleConnection(wsA);
    wsA.feedClient({ k: "hello" });
    // Hello processing is async (authenticate → createClient → state
    // transition). Without this drain the next call frame would race the
    // state being still "pending-hello" and the bridge would send a fatal.
    await flush();
    // Drive A's subscribe through and complete the tmux round-trip.
    wsA.feedClient({
      k: "call",
      id: "a-sub",
      method: "subscribeRaw",
      args: ["focus", "", "#{pane_id}"],
    });
    // Drain microtasks so the bridge reaches the point where it has called
    // client.subscribeRaw (which writes to the transport). Only then can the
    // fake transport feed the matching tmux response.
    await flush();
    feedCommandResponse(t, 1);
    await flush();
    const aResult = readJsonFrames(wsA).find(
      (f): f is ResultOkFrame =>
        f.k === "result" && (f as ResultOkFrame).id === "a-sub",
    );
    expect(aResult?.ok).toBe(true);

    // Connection B tries to unsubscribe "focus" — must be rejected with
    // BRIDGE_UNKNOWN_SUBSCRIPTION; the helper checks ownership first so
    // tmux never sees a second call (A's subscription is preserved).
    const wsB = createFakeWs();
    void bridge.handleConnection(wsB);
    wsB.feedClient({ k: "hello" });
    await flush();
    const sentBefore = t.sent.length;
    wsB.feedClient({
      k: "call",
      id: "b-unsub",
      method: "unsubscribe",
      args: ["focus"],
    });
    await flush();

    const bResult = readJsonFrames(wsB).find(
      (f): f is ResultErrFrame =>
        f.k === "result" && (f as ResultErrFrame).id === "b-unsub",
    );
    expect(bResult?.ok).toBe(false);
    expect((bResult as ResultErrFrame).error.code).toBe(
      "BRIDGE_UNKNOWN_SUBSCRIPTION",
    );
    // No tmux unsubscribe was issued — A's binding survives.
    expect(t.sent.slice(sentBefore)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Backpressure (audit C3 fix)
// ---------------------------------------------------------------------------

describe("WebSocket bridge — qz5.5 C3 backpressure", () => {
  it("emits setPaneAction(Pause) once per-pane outstanding crosses the high watermark", async () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    t.feed(STARTUP_GREETING);
    const bridge = createWebSocketBridge({
      createClient: () => client,
      // Tiny watermarks so the test triggers without ballooning.
      outputHighWatermark: 100,
      outputLowWatermark: 25,
    });

    const ws = createFakeWs();
    void bridge.handleConnection(ws);
    ws.feedClient({ k: "hello" });
    await flush();
    // Hold bufferedAmount above the low watermark so the bridge does NOT
    // immediately clear outstanding on every send. (Without this, every
    // send would observe bufferedAmount==0 and treat the OS buffer as
    // drained, cancelling the per-pane accounting before the watermark can
    // trip.) This simulates a slow consumer whose OS send buffer is
    // filling up.
    ws.setBuffered(80);

    // 5 chunks of 30 bytes = 150 bytes outstanding > high=100 → exactly one
    // pause emitted. The bridge does NOT re-pause on every chunk while
    // already paused (mirrors Electron's invariant).
    for (let i = 0; i < 5; i++) {
      t.feed(`%output %2 ${"x".repeat(30)}\n`);
    }
    await flush();

    const pauseCmds = t.sent.filter(
      (c) => c.includes("refresh-client") && c.includes("%2:pause"),
    );
    expect(pauseCmds).toHaveLength(1);
  });

  it("clears outstanding and resumes when bufferedAmount drains below low watermark", async () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    t.feed(STARTUP_GREETING);
    const bridge = createWebSocketBridge({
      createClient: () => client,
      outputHighWatermark: 100,
      outputLowWatermark: 25,
    });

    const ws = createFakeWs();
    void bridge.handleConnection(ws);
    ws.feedClient({ k: "hello" });
    await flush();
    ws.setBuffered(80);

    // Drive the connection across the high watermark.
    for (let i = 0; i < 5; i++) {
      t.feed(`%output %3 ${"x".repeat(30)}\n`);
    }
    await flush();
    expect(t.sent.filter((c) => c.includes("%3:pause"))).toHaveLength(1);
    expect(t.sent.filter((c) => c.includes("%3:continue"))).toHaveLength(0);

    // Now drain the OS buffer (simulating the slow consumer catching up).
    // The next send observes bufferedAmount <= low and clears outstanding;
    // setPaneAction(Continue) fires exactly once.
    ws.setBuffered(0);
    t.feed(`%output %3 ${"x".repeat(1)}\n`);
    await flush();

    expect(t.sent.filter((c) => c.includes("%3:continue"))).toHaveLength(1);
  });

  it("resumes a paused pane when bufferedAmount drains via a non-pane-output send", async () => {
    // Regression: previously the watermark drain sample only fired on
    // pane-output sends. Once a pane was paused tmux stopped emitting its
    // output, so the OS-buffer drain was never re-observed and the pane
    // could stay paused indefinitely. The fix routes every outbound send
    // (JSON event frames + RPC results) through the same chokepoint that
    // samples bufferedAmount, so any traffic — not just pane-output —
    // unsticks a paused pane once the OS buffer drains.
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    t.feed(STARTUP_GREETING);
    const bridge = createWebSocketBridge({
      createClient: () => client,
      outputHighWatermark: 100,
      outputLowWatermark: 25,
    });

    const ws = createFakeWs();
    void bridge.handleConnection(ws);
    ws.feedClient({ k: "hello" });
    await flush();
    ws.setBuffered(80);

    // Drive the connection across the high watermark — pause fires once.
    for (let i = 0; i < 5; i++) {
      t.feed(`%output %5 ${"x".repeat(30)}\n`);
    }
    await flush();
    expect(t.sent.filter((c) => c.includes("%5:pause"))).toHaveLength(1);
    expect(t.sent.filter((c) => c.includes("%5:continue"))).toHaveLength(0);

    // Simulate the OS buffer draining while pane output stays silent (tmux
    // stops emitting %5 because it's paused). A non-pane tmux notification
    // arrives — under the old code, this JSON event would be sent without
    // sampling bufferedAmount, leaving the pause stuck. With the fix, the
    // JSON send routes through wsSend → maybeFlushBuffered → resume.
    ws.setBuffered(0);
    t.feed("%session-changed $0 main\n");
    await flush();

    expect(t.sent.filter((c) => c.includes("%5:continue"))).toHaveLength(1);
  });

  it("does not pause for a fast consumer whose bufferedAmount stays drained", async () => {
    // Sanity check: the watermark is a slow-consumer guard, not a per-event
    // hairtrigger. A peer whose OS buffer flushes immediately should never
    // trip the threshold even under sustained load.
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    t.feed(STARTUP_GREETING);
    const bridge = createWebSocketBridge({
      createClient: () => client,
      outputHighWatermark: 100,
      outputLowWatermark: 25,
    });

    const ws = createFakeWs();
    void bridge.handleConnection(ws);
    ws.feedClient({ k: "hello" });
    await flush();
    // Default bufferedAmount=0 — every send drains immediately.

    for (let i = 0; i < 20; i++) {
      t.feed(`%output %4 ${"x".repeat(30)}\n`);
    }
    await flush();

    expect(t.sent.filter((c) => c.includes("%4:pause"))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Divergent re-subscribe (C1 mirror — same helper, different transport)
// ---------------------------------------------------------------------------

describe("WebSocket bridge — qz5.5 C1 divergent re-subscribe within one connection", () => {
  it("rejects re-subscribing the same name with a different (what, format) on the same connection", async () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    t.feed(STARTUP_GREETING);
    const bridge = createWebSocketBridge({ createClient: () => client });

    const ws = createFakeWs();
    void bridge.handleConnection(ws);
    ws.feedClient({ k: "hello" });
    await flush();

    // First subscribe — proxied to tmux. Drain microtasks first so the
    // bridge has actually issued client.subscribeRaw before we feed the
    // matching response.
    ws.feedClient({
      k: "call",
      id: "s1",
      method: "subscribeRaw",
      args: ["foo", "", "#{a}"],
    });
    await flush();
    feedCommandResponse(t, 1);
    await flush();
    expect(
      readJsonFrames(ws).some(
        (f) =>
          f.k === "result" && (f as ResultOkFrame).id === "s1" && f.ok === true,
      ),
    ).toBe(true);

    // Same connection re-subscribes "foo" with a DIFFERENT format. Bridge
    // rejects with BRIDGE_SUBSCRIPTION_FORMAT_CONFLICT — same enforcement
    // the Electron path gets, exact same error code, because the
    // BridgeConnection helper is the single source of truth.
    ws.feedClient({
      k: "call",
      id: "s2",
      method: "subscribeRaw",
      args: ["foo", "", "#{b}"],
    });
    await flush();

    const errFrame = readJsonFrames(ws).find(
      (f) => f.k === "result" && (f as { id?: string }).id === "s2",
    );
    expect(errFrame?.k).toBe("result");
    expect((errFrame as ResultErrFrame).ok).toBe(false);
    expect((errFrame as ResultErrFrame).error.code).toBe(
      "BRIDGE_SUBSCRIPTION_FORMAT_CONFLICT",
    );
  });
});

// ---------------------------------------------------------------------------
// zng.5 — onHello's invariant across its two awaits
// ---------------------------------------------------------------------------

describe("WebSocket bridge — zng.5 handshake races", () => {
  it("mid-handshake close leaves zero listeners/sinks on the shared client", async () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    t.feed(STARTUP_GREETING);

    let resolveCreate!: (c: TmuxClient) => void;
    const createClientPromise = new Promise<TmuxClient>((res) => {
      resolveCreate = res;
    });
    let disposeCalls = 0;
    const bridge = createWebSocketBridge({
      createClient: () => createClientPromise,
      disposeClient: () => {
        disposeCalls++;
      },
    });

    const ws = createFakeWs();
    void bridge.handleConnection(ws);
    ws.feedClient({ k: "hello" });
    // Let authenticate() resolve (no auth hook configured) so onHello is now
    // suspended awaiting createClient() — the exact window the ticket
    // describes: hello accepted, client not yet committed to state.
    await flush();

    // The TCP connection drops while createClient() is still pending.
    // finalize runs now; state was "handshaking" so it correctly finds
    // nothing to dispose yet.
    ws.fireClose(1006, "abnormal closure");

    // createClient() now resolves with the shared client, after finalize
    // already ran.
    resolveCreate(client);
    await flush();

    // onHello must have observed the closed state and aborted: no welcome
    // frame, and disposeClient was invoked for the client it created but
    // never got to use.
    expect(readJsonFrames(ws).some((f) => f.k === "welcome")).toBe(false);
    expect(disposeCalls).toBe(1);

    // Prove no listener/sink leaked: feed a tmux notification and an
    // %output chunk through the shared client's transport — if onHello had
    // wired `client.on("*", …)` or `client.attachBytesSink(…)` before
    // observing closed, one of these would produce outbound traffic on a
    // socket that is already gone.
    const before = ws.outbound.length;
    t.feed("%session-changed $0 main\n");
    t.feed(`%output %1 ${"x".repeat(10)}\n`);
    await flush();
    expect(ws.outbound.length).toBe(before);
  });

  it("duplicate hello during handshake is rejected; exactly one createClient call and one listener attachment", async () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    t.feed(STARTUP_GREETING);

    let createClientCalls = 0;
    let resolveCreate!: (c: TmuxClient) => void;
    const createClientPromise = new Promise<TmuxClient>((res) => {
      resolveCreate = res;
    });
    let disposeCalls = 0;
    const bridge = createWebSocketBridge({
      createClient: () => {
        createClientCalls++;
        return createClientPromise;
      },
      disposeClient: () => {
        disposeCalls++;
      },
    });

    const ws = createFakeWs();
    void bridge.handleConnection(ws);
    // Both hellos land synchronously, before the first onHello's initial
    // await (authenticate()) has a chance to resolve — the exact race the
    // old `pending-hello`-only guard missed, since state stayed
    // "pending-hello" across both awaits.
    ws.feedClient({ k: "hello" });
    ws.feedClient({ k: "hello" });
    await flush();

    // The duplicate is a *fatal* protocol error, per this file's existing
    // convention (any protocol violation tears down the whole connection,
    // not just the offending frame) — so the socket is closed here too.
    const fatal = readJsonFrames(ws).find(
      (f): f is FatalErrorFrame => f.k === "error" && f.fatal === true,
    );
    expect(fatal?.error.message).toMatch(/duplicate hello/);
    expect(createClientCalls).toBe(1);
    expect(ws.readyState).not.toBe(WEBSOCKET_OPEN);

    // `sendFatalAndClose` called `ws.close()` above, but the fake — like a
    // real socket — doesn't fire the `close` event synchronously; drive it
    // explicitly so `finalize` actually runs and commits state to "closed"
    // before createClient() resolves. Without this, the assertions below
    // would pass only because `wsSend` gates on `readyState`, never
    // exercising onHello's own `isClosed()` abort branch.
    ws.fireClose(1011, "duplicate hello frame");

    // createClient() resolves after finalize already ran. onHello must
    // observe the closed state and dispose the client it built instead of
    // wiring listeners onto it — the same abort path proven in the mid-
    // handshake-close test above, reached here via the duplicate-hello path
    // instead of a raw disconnect.
    const before = ws.outbound.length;
    resolveCreate(client);
    await flush();
    expect(disposeCalls).toBe(1);
    expect(ws.outbound.length).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function flush(): Promise<void> {
  // Three microtask drains. The hello → running transition chains three
  // awaits internally — safeAuthenticate (resolves synchronously when no
  // auth hook is configured but still consumes a microtask), createClient
  // (same), and the post-construction state assignment that unblocks
  // subsequent dispatch. Reducing this to two leaves the next call frame
  // racing the state being still "pending-hello" and the bridge sends a
  // fatal. Any tighter coupling than three drains would be an internal
  // brittleness signal worth fixing in the bridge, not the test.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

// ---------------------------------------------------------------------------
// Resume-failure surfacing (kwv.2)
//
// Proves the bridge's ResumeFailure reporter reaches the WS server's own
// observability channel as a `pane-resume-failed` event — the transport
// performing the emission the pure bridge only described.
// ---------------------------------------------------------------------------

describe("WebSocket bridge — resume-failure observability", () => {
  it("surfaces a live-pane Continue rejection as a pane-resume-failed event", async () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    t.feed(STARTUP_GREETING);
    const events: BridgeObservabilityEvent[] = [];
    const bridge = createWebSocketBridge({
      createClient: () => client,
      outputHighWatermark: 100,
      outputLowWatermark: 25,
      onEvent: (ev) => events.push(ev),
    });

    const ws = createFakeWs();
    void bridge.handleConnection(ws);
    ws.feedClient({ k: "hello" });
    await flush();
    ws.setBuffered(80);

    // Cross the high watermark → Pause (execute #1). Settle it so the FIFO
    // advances to the Continue.
    for (let i = 0; i < 5; i++) {
      t.feed(`%output %3 ${"x".repeat(30)}\n`);
    }
    await flush();
    expect(t.sent.filter((c) => c.includes("%3:pause"))).toHaveLength(1);
    feedCommandResponse(t, 1);
    await flush();

    // Drain the OS buffer → Continue (execute #2). Reject it as a tmux %error.
    ws.setBuffered(0);
    t.feed(`%output %3 ${"x".repeat(1)}\n`);
    await flush();
    expect(t.sent.filter((c) => c.includes("%3:continue"))).toHaveLength(1);
    t.feed(`%begin 2 2 0\n`);
    t.feed(`no current target\n`);
    t.feed(`%error 2 2 0\n`);
    await flush();

    const failures = events.filter((e) => e.kind === "pane-resume-failed");
    expect(failures).toHaveLength(1);
    const f = failures[0];
    // Narrow to the event variant so paneId/code are accessible.
    if (f.kind !== "pane-resume-failed") throw new Error("unreachable");
    expect(f.paneId).toBe(3);
    expect(f.code).toBe("TMUX_ERROR");
  });
});

// ---------------------------------------------------------------------------
// onHello failure-path observability (zng.5.1)
//
// Every onHello failure now surfaces a BridgeErrorCode to onEvent: either as
// connection-closed.errorCode (routed through sendFatalAndClose/finalize, the
// file's existing single close-enforcer) or, once that one enforcer is
// already claimed by an unrelated close/fatal, as its own
// handshake-failure-unreported event.
// ---------------------------------------------------------------------------
describe("WebSocket bridge — onHello failure-path observability (zng.5.1)", () => {
  it("auth-denied surfaces as connection-closed.errorCode BRIDGE_AUTH_DENIED", async () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    t.feed(STARTUP_GREETING);
    const events: BridgeObservabilityEvent[] = [];
    const bridge = createWebSocketBridge({
      createClient: () => client,
      authenticate: () => ({ ok: false, reason: "no credentials" }),
      onEvent: (ev) => events.push(ev),
    });

    const ws = createFakeWs();
    void bridge.handleConnection(ws);
    ws.feedClient({ k: "hello" });
    await flush();
    // sendFatalAndClose called ws.close() above; the fake, like a real
    // socket, doesn't fire the "close" event synchronously — drive it
    // explicitly so finalize runs and emits connection-closed, matching the
    // zng.5 handshake-races tests' existing convention in this file.
    ws.fireClose(4401, "no credentials");

    const closed = events.filter((e) => e.kind === "connection-closed");
    expect(closed).toHaveLength(1);
    const c = closed[0];
    if (c.kind !== "connection-closed") throw new Error("unreachable");
    expect(c.errorCode).toBe("BRIDGE_AUTH_DENIED");
    expect(c.reason).toMatch(/no credentials/);
  });

  it("createClient failure surfaces as connection-closed.errorCode BRIDGE_INTERNAL", async () => {
    const t = createFakeTransport();
    t.feed(STARTUP_GREETING);
    const events: BridgeObservabilityEvent[] = [];
    const bridge = createWebSocketBridge({
      createClient: () => {
        throw new Error("tmux spawn failed");
      },
      onEvent: (ev) => events.push(ev),
    });

    const ws = createFakeWs();
    void bridge.handleConnection(ws);
    ws.feedClient({ k: "hello" });
    await flush();
    ws.fireClose(1011, "createClient failed: tmux spawn failed");

    const closed = events.filter((e) => e.kind === "connection-closed");
    expect(closed).toHaveLength(1);
    const c = closed[0];
    if (c.kind !== "connection-closed") throw new Error("unreachable");
    expect(c.errorCode).toBe("BRIDGE_INTERNAL");
    expect(c.reason).toMatch(/tmux spawn failed/);
  });

  it("createBridgeConnection failure disposes the already-created client (tmux-lifecycle-zng.s5u)", async () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    t.feed(STARTUP_GREETING);
    let disposeCalls = 0;
    const bridge = createWebSocketBridge({
      createClient: () => Promise.resolve(client),
      // low > high is rejected by BackpressureLedger's constructor —
      // the single enforcer of watermark-config validity — so
      // createBridgeConnection throws BRIDGE_INVALID_ARG before any peer
      // state or listener is wired, landing in onHello's catch block.
      outputHighWatermark: 1,
      outputLowWatermark: 2,
      disposeClient: (c) => {
        expect(c).toBe(client);
        disposeCalls++;
      },
    });

    const ws = createFakeWs();
    void bridge.handleConnection(ws);
    ws.feedClient({ k: "hello" });
    await flush();
    ws.fireClose(1011, "bridge construction failed");

    // Without the fix, this catch block returned after sendFatalAndClose
    // with no disposeClient call — the client createClient() built leaks.
    expect(disposeCalls).toBe(1);
  });

  it("a throw from registerPeer()/listener wiring after createBridgeConnection succeeds disposes the client and bridge instead of leaking them (tmux-lifecycle-zng.7k0)", async () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    t.feed(STARTUP_GREETING);
    let disposeCalls = 0;
    // client.on is a plain method on the instance's prototype, not internally
    // relied on by TmuxClient itself (grep confirms no `this.on(` call site),
    // so overriding it to throw once exercises onHello's registerPeer/wiring
    // catch block without disturbing the client's own setup.
    const originalOn = client.on.bind(client);
    client.on = ((_event: "*", _handler: never) => {
      throw new Error("listener wiring boom");
    }) as typeof client.on;
    const bridge = createWebSocketBridge({
      createClient: () => Promise.resolve(client),
      disposeClient: (c) => {
        expect(c).toBe(client);
        disposeCalls++;
      },
    });

    const ws = createFakeWs();
    void bridge.handleConnection(ws);
    ws.feedClient({ k: "hello" });
    await flush();

    // Without the fix, this catch block didn't exist — the throw propagated
    // out of onHello with no disposeClient call and no fatal frame, leaking
    // both the client and the just-constructed bridge.
    const fatal = readJsonFrames(ws).find(
      (f): f is FatalErrorFrame => f.k === "error" && f.fatal === true,
    );
    expect(fatal).toBeDefined();
    expect(fatal?.error.code).toBe("BRIDGE_INTERNAL");
    expect(disposeCalls).toBe(1);

    client.on = originalOn;
    ws.fireClose(1011, "registerPeer/listener wiring failed");
  });

  it("a release that throws during unwind does not block the releases below it on the stack", async () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    t.feed(STARTUP_GREETING);
    let disposeCalls = 0;
    // client.off is pushed onto the release stack right after client.on
    // succeeds, so it is popped FIRST during unwind — above bridge.dispose()
    // and disposeClientSafely, both further down the stack. Making it throw
    // (via attachBytesSink failing, which triggers the catch after client.on
    // already succeeded) proves those two still run despite it.
    const originalOff = client.off.bind(client);
    client.off = ((_event: "*", _handler: never) => {
      throw new Error("client.off boom");
    }) as typeof client.off;
    client.attachBytesSink = (() => {
      throw new Error("attachBytesSink boom");
    }) as typeof client.attachBytesSink;
    const events: BridgeObservabilityEvent[] = [];
    const bridge = createWebSocketBridge({
      createClient: () => Promise.resolve(client),
      disposeClient: (c) => {
        expect(c).toBe(client);
        disposeCalls++;
      },
      onEvent: (ev) => events.push(ev),
    });

    const ws = createFakeWs();
    void bridge.handleConnection(ws);
    ws.feedClient({ k: "hello" });
    await flush();

    // Without the fix, client.off's throw aborted unwind() mid-stack:
    // bridge.dispose() and disposeClientSafely (below it on the stack) never
    // ran, and the escaping exception skipped sendFatalAndClose entirely,
    // becoming an unhandled rejection instead of a reported BRIDGE_INTERNAL.
    const fatal = readJsonFrames(ws).find(
      (f): f is FatalErrorFrame => f.k === "error" && f.fatal === true,
    );
    expect(fatal).toBeDefined();
    expect(fatal?.error.code).toBe("BRIDGE_INTERNAL");
    expect(disposeCalls).toBe(1);
    expect(events.find((e) => e.kind === "release-failed")).toBeDefined();

    client.off = originalOff;
    ws.fireClose(1011, "release failed during unwind");
  });

  it("a disposeClient hook that throws surfaces client-dispose-failed instead of an unhandled rejection or a swallowed failure", async () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    t.feed(STARTUP_GREETING);
    const events: BridgeObservabilityEvent[] = [];
    const bridge = createWebSocketBridge({
      createClient: () => Promise.resolve(client),
      outputHighWatermark: 1,
      outputLowWatermark: 2,
      disposeClient: () => {
        throw new Error("client.dispose boom");
      },
      onEvent: (ev) => events.push(ev),
    });

    const ws = createFakeWs();
    void bridge.handleConnection(ws);
    ws.feedClient({ k: "hello" });
    await flush();

    // The throw from disposeClient must not skip sendFatalAndClose — the
    // peer still gets a fatal frame and the socket still closes.
    const fatal = readJsonFrames(ws).find(
      (f): f is FatalErrorFrame => f.k === "error" && f.fatal === true,
    );
    expect(fatal).toBeDefined();
    ws.fireClose(1011, "bridge construction failed");

    const failed = events.find((e) => e.kind === "client-dispose-failed");
    expect(failed).toBeDefined();
    if (failed === undefined || failed.kind !== "client-dispose-failed") {
      throw new Error("unreachable");
    }
    expect(failed.message).toMatch(/client.dispose boom/);
  });

  it("createClient failing after the peer already disconnected surfaces as handshake-failure-unreported", async () => {
    const t = createFakeTransport();
    t.feed(STARTUP_GREETING);

    let rejectCreate!: (err: Error) => void;
    const createClientPromise = new Promise<TmuxClient>((_res, rej) => {
      rejectCreate = rej;
    });
    const events: BridgeObservabilityEvent[] = [];
    const bridge = createWebSocketBridge({
      createClient: () => createClientPromise,
      onEvent: (ev) => events.push(ev),
    });

    const ws = createFakeWs();
    void bridge.handleConnection(ws);
    ws.feedClient({ k: "hello" });
    await flush();

    // Peer disconnects while createClient() is still in flight — finalize
    // runs now and emits its own connection-closed with no internal failure
    // info (the same window proven in the zng.5 handshake-races tests above).
    ws.fireClose(1006, "abnormal closure");
    events.length = 0;

    // createClient() rejects after finalize already ran. No peer left to
    // notify, no open connection-closed event left to carry it.
    rejectCreate(new Error("tmux spawn failed"));
    await flush();

    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e.kind).toBe("handshake-failure-unreported");
    if (e.kind !== "handshake-failure-unreported") {
      throw new Error("unreachable");
    }
    expect(e.code).toBe("BRIDGE_INTERNAL");
    expect(e.message).toMatch(/tmux spawn failed/);
  });

  it("auth-denied racing a pending fatal from elsewhere surfaces as handshake-failure-unreported instead of being silently dropped", async () => {
    const t = createFakeTransport();
    t.feed(STARTUP_GREETING);

    let resolveAuth!: (r: { ok: false; reason: string }) => void;
    const authPromise = new Promise<{ ok: false; reason: string }>((res) => {
      resolveAuth = res;
    });
    const events: BridgeObservabilityEvent[] = [];
    const bridge = createWebSocketBridge({
      createClient: () => new TmuxClient(t.transport),
      authenticate: () => authPromise,
      onEvent: (ev) => events.push(ev),
    });

    const ws = createFakeWs();
    void bridge.handleConnection(ws);
    // Hello #1 commits to "handshaking" and suspends at authenticate().
    ws.feedClient({ k: "hello" });
    await flush();
    // Hello #2 is rejected as a duplicate — the connection's one fatal is
    // now claimed by BRIDGE_PROTOCOL_ERROR, with the real close not yet
    // landed (state stays "handshaking").
    ws.feedClient({ k: "hello" });
    await flush();

    // Hello #1's authenticate() now resolves denied. Without isTearingDown()
    // routing this to its own event, sendFatalAndClose's write-once guard
    // would silently drop the auth-denial with zero signal.
    resolveAuth({ ok: false, reason: "no credentials" });
    await flush();

    const unreported = events.filter(
      (e) => e.kind === "handshake-failure-unreported",
    );
    expect(unreported).toHaveLength(1);
    const u = unreported[0];
    if (u.kind !== "handshake-failure-unreported") {
      throw new Error("unreachable");
    }
    expect(u.code).toBe("BRIDGE_AUTH_DENIED");
    expect(u.message).toMatch(/no credentials/);
  });

  it("createClient succeeding after an unrelated fatal is already pending disposes the client instead of opening the connection", async () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    t.feed(STARTUP_GREETING);

    let resolveCreate!: (c: TmuxClient) => void;
    const createClientPromise = new Promise<TmuxClient>((res) => {
      resolveCreate = res;
    });
    let disposeCalls = 0;
    const events: BridgeObservabilityEvent[] = [];
    const bridge = createWebSocketBridge({
      createClient: () => createClientPromise,
      disposeClient: () => {
        disposeCalls++;
      },
      onEvent: (ev) => events.push(ev),
    });

    const ws = createFakeWs();
    void bridge.handleConnection(ws);
    // Hello #1 commits to "handshaking", authenticates (no hook configured),
    // and suspends at createClient().
    ws.feedClient({ k: "hello" });
    await flush();
    // Hello #2 is rejected as a duplicate — the connection's one fatal is now
    // claimed by BRIDGE_PROTOCOL_ERROR, with the real close not yet landed
    // (state stays "handshaking").
    ws.feedClient({ k: "hello" });
    await flush();

    // createClient() now resolves successfully. The old `isClosed()` gate
    // here was false (state never reached "closed"), so the connection
    // would wire itself into "running" and emit a false connection-opened
    // for a connection already fatally sealed. isTearingDown() must gate
    // this instead. [LAW:no-silent-failure]
    resolveCreate(client);
    await flush();

    expect(disposeCalls).toBe(1);
    expect(events.some((e) => e.kind === "connection-opened")).toBe(false);
  });

  it("a second fatal-close before the real close event lands does not overwrite the first's BridgeErrorCode", async () => {
    const t = createFakeTransport();
    t.feed(STARTUP_GREETING);
    const events: BridgeObservabilityEvent[] = [];
    const bridge = createWebSocketBridge({
      createClient: () => new TmuxClient(t.transport),
      // Never reached: the duplicate-hello fatal below fires first and the
      // write-once guard must block this one from overwriting it.
      authenticate: () => ({ ok: false, reason: "no creds" }),
      onEvent: (ev) => events.push(ev),
    });

    const ws = createFakeWs();
    void bridge.handleConnection(ws);
    // Hello #1 commits synchronously to "handshaking" and suspends at
    // authenticate(). Hello #2, landing in the same synchronous dispatch
    // before that await resolves, is rejected as a duplicate — the first
    // sendFatalAndClose, fixing BRIDGE_PROTOCOL_ERROR as the connection's
    // one fatal BridgeError.
    ws.feedClient({ k: "hello" });
    ws.feedClient({ k: "hello" });
    // Hello #1 then resumes past authenticate() and tries its own
    // sendFatalAndClose(BRIDGE_AUTH_DENIED) — the write-once guard must
    // make this a no-op rather than overwrite the duplicate-hello fatal.
    await flush();

    ws.fireClose(1011, "duplicate hello frame");

    const closed = events.filter((e) => e.kind === "connection-closed");
    expect(closed).toHaveLength(1);
    const c = closed[0];
    if (c.kind !== "connection-closed") throw new Error("unreachable");
    expect(c.errorCode).toBe("BRIDGE_PROTOCOL_ERROR");
  });
});

// ---------------------------------------------------------------------------
// Cross-session layout coverage over the bridge (tmux-server-events-6sp.494)
// ---------------------------------------------------------------------------

describe("WebSocket bridge — cross-session layout coverage", () => {
  it("delivers decoded events only to the connection that enabled them, and the relay's raw frames to none", async () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    t.feed(STARTUP_GREETING);
    const enable = vi
      .spyOn(client, "enableCrossSessionLayoutChange")
      .mockResolvedValue(undefined);
    const disable = vi
      .spyOn(client, "disableCrossSessionLayoutChange")
      .mockResolvedValue(undefined);
    const bridge = createWebSocketBridge({ createClient: () => client });

    const wsOn = createFakeWs();
    void bridge.handleConnection(wsOn);
    wsOn.feedClient({ k: "hello" });
    const wsOff = createFakeWs();
    void bridge.handleConnection(wsOff);
    wsOff.feedClient({ k: "hello" });
    await flush();

    wsOn.feedClient({
      k: "call",
      id: "en",
      method: "enableCrossSessionLayoutChange",
      args: [],
    });
    // The peer's coverage queue adds hops after dispatch.
    await flush();
    await flush();
    const enabled = readJsonFrames(wsOn).find(
      (f): f is ResultOkFrame => f.k === "result" && f.id === "en",
    );
    expect(enabled).toEqual({
      k: "result",
      id: "en",
      ok: true,
      response: null,
    });
    expect(enable).toHaveBeenCalledTimes(1);

    // The relay's own subscription delivery, straight off the wire.
    t.feed(
      "%subscription-changed ttcmjs-cross-session-layout $1 @0 0 %0 : 1:@7,\n",
    );
    // The decoded event the relay emits after fetching the window.
    const change = {
      type: "cross-session-layout-change",
      sessionId: 1,
      windowId: 7,
      ...windowLayoutFields("b25d,80x24,0,0,0", "b25d,80x24,0,0,0", "*"),
    } as const;
    (client as unknown as { emitter: { emit(m: unknown): void } }).emitter.emit(
      change,
    );

    const events = (ws: FakeWs) =>
      readJsonFrames(ws).flatMap((f) => (f.k === "event" ? [f.msg] : []));
    expect(events(wsOn)).toEqual([change]);
    expect(events(wsOff)).toEqual([]);

    // Disconnecting gives the connection's reference back.
    wsOn.fireClose();
    await flush();
    expect(disable).toHaveBeenCalledTimes(1);
  });

  it("records a tmux %error result as a failure in observability, as the client sees it", async () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    t.feed(STARTUP_GREETING);
    const events: BridgeObservabilityEvent[] = [];
    const bridge = createWebSocketBridge({
      createClient: () => client,
      onEvent: (ev) => events.push(ev),
    });
    const ws = createFakeWs();
    void bridge.handleConnection(ws);
    ws.feedClient({ k: "hello" });
    await flush();

    ws.feedClient({ k: "call", id: "x", method: "execute", args: ["bogus"] });
    await flush();
    t.feed(`%begin 1 1 0\n`);
    t.feed(`unknown command: bogus\n`);
    t.feed(`%error 1 1 0\n`);
    await flush();

    const frame = readJsonFrames(ws).find(
      (f) => f.k === "result" && f.id === "x",
    );
    expect(frame).toMatchObject({ ok: false, tmuxError: { success: false } });
    expect(
      events.find((e) => e.kind === "result" && e.id === "x"),
    ).toMatchObject({ ok: false, code: "TMUX_ERROR" });
  });

  it("rejects a cross-session layout event frame missing a payload field", () => {
    const frame = JSON.stringify({
      k: "event",
      msg: { type: "cross-session-layout-change", sessionId: 1 },
    });
    expect(() => parseServerFrame(frame)).toThrow(/windowId must be a number/);
    const ok = JSON.stringify({
      k: "event",
      msg: {
        type: "cross-session-layout-fetch-failed",
        windowId: 7,
        reason: "gone",
      },
    });
    expect(parseServerFrame(ok)).toMatchObject({ k: "event" });
  });

  it.each([
    ["layout-change", { windowId: 7 }],
    ["cross-session-layout-change", { sessionId: 1, windowId: 7 }],
  ])(
    "derives %s geometry from the raw strings, never from the wire",
    (type, ids) => {
      const fields = windowLayoutFields(
        "b25d,80x24,0,0,0",
        "b25d,80x24,0,0,0",
        "*",
      );
      const frame = (extra: object) =>
        JSON.stringify({ k: "event", msg: { type, ...ids, ...extra } });
      const raw = {
        windowLayout: fields.windowLayout,
        windowVisibleLayout: fields.windowVisibleLayout,
        windowFlags: fields.windowFlags,
      };
      for (const forged of [
        {},
        { layout: { kind: "parsed", panes: [] } },
        { layout: null, visibleLayout: "b25d,80x24,0,0,0" },
      ]) {
        expect(parseServerFrame(frame({ ...raw, ...forged }))).toEqual({
          k: "event",
          msg: { type, ...ids, ...fields },
        });
      }
      const { windowLayout: _omitted, ...missing } = raw;
      expect(() => parseServerFrame(frame(missing))).toThrow(
        /windowLayout must be a string/,
      );
    },
  );
});

// ---------------------------------------------------------------------------
// Upstream close (tmux-server-events-6sp.41l)
//
// The connection's own TmuxClient closing — tmux killed, its transport
// failed, or it was disposed — is a fatal for the WebSocket peer: one fatal
// `error` frame naming the upstream, then the socket closes, so the browser's
// WebSocketTmuxClient reads it through its ordinary onClose path instead of
// sitting `ready` on a dead tmux. `createFakeTransport().transport.close()`
// drives TmuxClient's real close handler (reason "closed"), which emits
// `connection-state { closed, transport-error }` synchronously.
// ---------------------------------------------------------------------------

function connectRunning(
  bridge: ReturnType<typeof createWebSocketBridge>,
): FakeWs {
  const ws = createFakeWs();
  void bridge.handleConnection(ws);
  ws.feedClient({ k: "hello" });
  return ws;
}

function fatalFrames(ws: FakeWs): FatalErrorFrame[] {
  return readJsonFrames(ws).filter(
    (f): f is FatalErrorFrame => f.k === "error" && f.fatal === true,
  );
}

function closedEvents(
  events: BridgeObservabilityEvent[],
): Extract<BridgeObservabilityEvent, { kind: "connection-closed" }>[] {
  return events.filter(
    (e): e is Extract<BridgeObservabilityEvent, { kind: "connection-closed" }> =>
      e.kind === "connection-closed",
  );
}

describe("WebSocket bridge — upstream close", () => {
  it("closes the socket with a fatal naming the upstream; the in-flight call's reply is recorded but never reaches the closing socket", async () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    t.feed(STARTUP_GREETING);
    const events: BridgeObservabilityEvent[] = [];
    const bridge = createWebSocketBridge({
      createClient: () => client,
      onEvent: (ev) => events.push(ev),
    });
    const ws = connectRunning(bridge);
    await flush();

    ws.feedClient({
      k: "call",
      id: "x",
      method: "execute",
      args: ["list-windows"],
    });
    await flush();
    expect(t.sent).toContain("list-windows\n");
    expect(closedEvents(events)).toHaveLength(0);

    t.transport.close();

    // Synchronously, inside the upstream's connection-state emission.
    expect(fatalFrames(ws)).toEqual([
      {
        k: "error",
        fatal: true,
        error: {
          code: "BRIDGE_CLOSED",
          message: expect.stringMatching(/upstream/) as string,
        },
      },
    ]);
    expect(ws.closeCalls).toEqual([
      { code: 1011, reason: expect.stringMatching(/upstream/) as string },
    ]);
    const framesAtClose = ws.outbound.length;

    // The call TmuxClient rejected is replied to from onCall's continuation,
    // on a later microtask: the socket is already closing, so the result
    // frame is dropped, but the call's outcome is still observable.
    await flush();
    await flush();
    expect(ws.outbound.length).toBe(framesAtClose);
    expect(events.filter((e) => e.kind === "result")).toEqual([
      expect.objectContaining({ id: "x", ok: false, code: "BRIDGE_CLOSED" }),
    ]);

    // The real close event lands; finalize runs once.
    ws.fireClose(1011, ws.closeCalls[0].reason);
    await flush();
    expect(closedEvents(events)).toEqual([
      expect.objectContaining({
        errorCode: "BRIDGE_CLOSED",
        reason: expect.stringMatching(/upstream/) as string,
      }),
    ]);
  });

  it("one shared upstream closing closes every connection on it", async () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    t.feed(STARTUP_GREETING);
    const events: BridgeObservabilityEvent[] = [];
    const bridge = createWebSocketBridge({
      createClient: () => client,
      onEvent: (ev) => events.push(ev),
    });
    const wsA = connectRunning(bridge);
    const wsB = connectRunning(bridge);
    await flush();
    expect(events.filter((e) => e.kind === "connection-opened")).toHaveLength(
      2,
    );

    t.transport.close();

    for (const ws of [wsA, wsB]) {
      expect(fatalFrames(ws).map((f) => f.error.code)).toEqual([
        "BRIDGE_CLOSED",
      ]);
      expect(ws.closeCalls).toHaveLength(1);
      ws.fireClose(1011, ws.closeCalls[0].reason);
    }
    await flush();
    expect(closedEvents(events).map((e) => e.errorCode)).toEqual([
      "BRIDGE_CLOSED",
      "BRIDGE_CLOSED",
    ]);
  });

  it("an upstream closing during drain closes the socket and lets shutdown resolve", async () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    t.feed(STARTUP_GREETING);
    const events: BridgeObservabilityEvent[] = [];
    const bridge = createWebSocketBridge({
      createClient: () => client,
      onEvent: (ev) => events.push(ev),
    });
    const ws = connectRunning(bridge);
    await flush();

    const shutdown = bridge.shutdown(10_000);
    expect(readJsonFrames(ws).some((f) => f.k === "draining")).toBe(true);

    t.transport.close();
    expect(fatalFrames(ws).map((f) => f.error.code)).toEqual([
      "BRIDGE_CLOSED",
    ]);
    expect(ws.closeCalls).toHaveLength(1);
    ws.fireClose(1011, ws.closeCalls[0].reason);

    const outcome = await Promise.race([
      shutdown.then(() => "resolved"),
      new Promise<string>((r) => setTimeout(() => r("drain deadline"), 200)),
    ]);
    expect(outcome).toBe("resolved");
    expect(closedEvents(events).map((e) => e.errorCode)).toEqual([
      "BRIDGE_CLOSED",
    ]);
  });

  it("an upstream close after another fatal is pending folds into that close instead of adding a second fatal", async () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    t.feed(STARTUP_GREETING);
    const events: BridgeObservabilityEvent[] = [];
    const bridge = createWebSocketBridge({
      createClient: () => client,
      onEvent: (ev) => events.push(ev),
    });
    const ws = connectRunning(bridge);
    await flush();

    // A second hello on a running connection is a fatal protocol error; it
    // claims the connection's one fatal before the real close has landed.
    ws.feedClient({ k: "hello" });
    expect(fatalFrames(ws).map((f) => f.error.code)).toEqual([
      "BRIDGE_PROTOCOL_ERROR",
    ]);

    t.transport.close();
    expect(fatalFrames(ws).map((f) => f.error.code)).toEqual([
      "BRIDGE_PROTOCOL_ERROR",
    ]);
    expect(ws.closeCalls).toEqual([
      { code: 1011, reason: "duplicate hello frame" },
    ]);

    ws.fireClose(1011, "duplicate hello frame");
    await flush();
    expect(closedEvents(events).map((e) => e.errorCode)).toEqual([
      "BRIDGE_PROTOCOL_ERROR",
    ]);
  });

  it("a shared upstream that already closed before createClient returned it is refused at hello, never opened", async () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    t.feed(STARTUP_GREETING);
    t.transport.close();
    expect(client.connectionState).toEqual({
      status: "closed",
      reason: "transport-error",
    });

    let disposeCalls = 0;
    const events: BridgeObservabilityEvent[] = [];
    const bridge = createWebSocketBridge({
      createClient: () => client,
      disposeClient: () => {
        disposeCalls++;
      },
      onEvent: (ev) => events.push(ev),
    });
    const ws = connectRunning(bridge);
    await flush();

    expect(fatalFrames(ws)).toEqual([
      {
        k: "error",
        fatal: true,
        error: {
          code: "BRIDGE_CLOSED",
          message: expect.stringMatching(/upstream/) as string,
        },
      },
    ]);
    expect(ws.closeCalls).toEqual([
      { code: 1011, reason: expect.stringMatching(/upstream/) as string },
    ]);
    expect(readJsonFrames(ws).some((f) => f.k === "welcome")).toBe(false);
    expect(events.some((e) => e.kind === "connection-opened")).toBe(false);
    // The client createClient() handed over was released, not leaked.
    expect(disposeCalls).toBe(1);

    ws.fireClose(1011, ws.closeCalls[0].reason);
    expect(closedEvents(events)).toEqual([
      expect.objectContaining({
        errorCode: "BRIDGE_CLOSED",
        reason: expect.stringMatching(/upstream/) as string,
      }),
    ]);
  });
});
