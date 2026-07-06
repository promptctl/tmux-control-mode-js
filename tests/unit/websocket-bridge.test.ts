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

import { describe, it, expect } from "vitest";

import { TmuxClient } from "../../src/client.js";
import type { TmuxTransport } from "../../src/transport/types.js";

import { createWebSocketBridge } from "../../src/connectors/websocket/server.js";
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
  readonly outbound: Array<string | Uint8Array>;
}

function createFakeWs(): FakeWs {
  let buffered = 0;
  type Listeners = {
    message?: (data: unknown, isBinary: boolean) => void;
    close?: (code: number, reason: Buffer | string) => void;
    error?: (err: Error) => void;
    pong?: () => void;
    ping?: () => void;
  };
  const listeners: Listeners = {};

  const outbound: Array<string | Uint8Array> = [];
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
    close() {
      readyState = 3;
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
    const bridge = createWebSocketBridge({
      createClient: () => {
        createClientCalls++;
        return createClientPromise;
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

    // The first hello's createClient() eventually resolves — since only one
    // call to createClient ever happened, there is structurally only one
    // possible attach site (client.on / attachBytesSink execute exactly once,
    // gated by that single resolution). Resolving must not throw or send
    // anything further on the already-closed socket.
    const before = ws.outbound.length;
    resolveCreate(client);
    await flush();
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
