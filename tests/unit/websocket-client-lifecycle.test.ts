// tests/unit/websocket-client-lifecycle.test.ts
// Lifecycle invariants for WebSocketTmuxClient — qz5.4:
//   M2:  outbox + pending lifecycle is one operation. A call frame queued
//        before the socket opens, then rejected via finalize, must NOT be
//        re-sent on a subsequent reconnect (silent state divergence is the
//        worst-case failure mode this prevents).
//   M3:  close() must settle every pending promise before its own promise
//        resolves. A caller doing `await client.close(); /* check promise */`
//        cannot see the pending promise resolve later.
//   M11: outbox cleared on permanent close — i.e. pending Map is empty after
//        close(), and post-close calls reject immediately.
//
// These tests drive the client through a fake browser WebSocket so we can
// inspect exactly which frames left the wire on each connection.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WebSocketTmuxClient } from "../../src/connectors/websocket/client.js";
import { TmuxInvalidCommandError } from "../../src/errors.js";
import type {
  BrowserWebSocketLike,
  ReconnectPolicy,
} from "../../src/connectors/websocket/types.js";
import {
  BridgeError,
  closeReason,
  encodeServerFrame,
  parseDurationMs,
  parsePositiveInt,
  type DurationMs,
  type HeartbeatInterval,
  type ResultFrame,
  type ServerFrame,
  type WelcomeFrame,
} from "../../src/connectors/websocket/protocol.js";
import { windowLayoutFields } from "../../src/protocol/layout.js";
import { sessionScope } from "../../src/pane-output.js";

// [LAW:no-ambient-temporal-coupling] The client's timers run on a test-owned
// clock: a reconnect backoff fires when a test advances it, not when the
// runner gets round to it. setImmediate stays real so a test can still let
// queued work drain. Describes that need the heartbeat's interval fake every
// timer in their own beforeEach.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Mock WebSocket hub. One hub per test; produces one MockWS per `openSocket`
// call. Each MockWS records every frame the client tried to send so tests
// can assert which frames crossed which connection.
// ---------------------------------------------------------------------------

type Listener = (ev: unknown) => void;

interface MockWS {
  url: string;
  readyState: number;
  readonly sent: string[];
  send(data: string | ArrayBufferLike | Uint8Array): void;
  close(code?: number, reason?: string): void;
  // Like the `ws` package, a listener once added stays for the socket's
  // life: a client that counted on anything else to silence a socket it is
  // done with would see that socket's events here.
  addEventListener(event: string, listener: Listener): void;
  fire(event: string, payload: unknown): void;
}

class MockWebSocketHub {
  readonly sockets: MockWS[] = [];

  factory = (url: string): MockWS => {
    const listeners = new Map<string, Set<Listener>>();
    const sent: string[] = [];
    const ws: MockWS = {
      url,
      readyState: 0, // CONNECTING
      sent,
      send(data) {
        sent.push(typeof data === "string" ? data : "<binary>");
      },
      close(code = 1000, reason = "") {
        ws.readyState = 3; // CLOSED
        ws.fire("close", { code, reason });
      },
      addEventListener(event, listener) {
        let set = listeners.get(event);
        if (!set) {
          set = new Set();
          listeners.set(event, set);
        }
        set.add(listener);
      },
      fire(event, payload) {
        const set = listeners.get(event);
        if (!set) return;
        for (const cb of set) cb(payload);
      },
    };
    this.sockets.push(ws);
    return ws;
  };

  latest(): MockWS {
    const ws = this.sockets.at(-1);
    if (!ws) throw new Error("no socket created yet");
    return ws;
  }

  open(idx = -1): void {
    const ws = idx === -1 ? this.latest() : this.sockets[idx];
    if (!ws) throw new Error("no socket at index " + idx);
    ws.readyState = 1; // OPEN
    ws.fire("open", {});
  }

  /** Advertise a welcome; the heartbeat is off and the server's call timeout
   *  is 30s unless a test is about them. */
  welcome(
    idx = -1,
    heartbeatIntervalMs: HeartbeatInterval = 0,
    requestTimeoutMs: DurationMs = parseDurationMs("requestTimeoutMs", 30_000),
  ): void {
    const ws = idx === -1 ? this.latest() : this.sockets[idx];
    if (!ws) return;
    const welcome: WelcomeFrame = {
      k: "welcome",
      limits: {
        requestTimeoutMs,
        heartbeatIntervalMs,
        maxInflight: parsePositiveInt("maxInflight", 16),
      },
    };
    ws.fire("message", {
      data: encodeServerFrame(welcome satisfies ServerFrame),
    });
  }

  fireClose(idx = -1, code = 1006, reason = "abnormal"): void {
    const ws = idx === -1 ? this.latest() : this.sockets[idx];
    if (!ws) return;
    ws.readyState = 3;
    ws.fire("close", { code, reason });
  }
}

function makeClient(
  opts: { reconnect?: boolean; onDraining?: (deadlineMs: number) => void } = {},
): {
  client: WebSocketTmuxClient;
  hub: MockWebSocketHub;
} {
  const hub = new MockWebSocketHub();
  const client = new WebSocketTmuxClient({
    url: "ws://test/",
    autoConnect: false,
    createWebSocket: hub.factory as unknown as (
      url: string,
    ) => BrowserWebSocketLike,
    onDraining: opts.onDraining,
    reconnect: opts.reconnect
      ? {
          maxAttempts: 3,
          initialDelayMs: 1,
          maxDelayMs: 1,
          factor: 1,
          jitterMs: 0,
        }
      : undefined,
  });
  return { client, hub };
}

// Returns the parsed JSON for every text frame that looks like a JSON
// client frame; binary placeholders are skipped.
function sentFrames(ws: MockWS): { k: string; id?: string }[] {
  const out: { k: string; id?: string }[] = [];
  for (const s of ws.sent) {
    if (s === "<binary>") continue;
    try {
      out.push(JSON.parse(s));
    } catch {
      // skip non-JSON
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WebSocketTmuxClient — lifecycle (qz5.4)", () => {
  describe("M2: outbox + pending lifecycle is one operation", () => {
    it("queued call rejected on close is NOT re-sent on the next connection", async () => {
      const { client, hub } = makeClient({ reconnect: true });
      void client.connect();

      // First ws is created but never opened. The call queues onto pending
      // because ws.readyState is CONNECTING, not OPEN.
      const callPromise = client.execute("list-windows");

      // Trigger close BEFORE the socket ever opens. finalizeConnection runs,
      // rejects pending, schedules reconnect. With the bug, outbox would
      // still contain the call frame; with the fix, pending IS the queue,
      // so clearing pending clears the queue.
      hub.fireClose(0, 1006, "abnormal");
      await expect(callPromise).rejects.toMatchObject({
        code: "BRIDGE_CLOSED",
      });

      // The 1ms backoff elapses; the retry opens the second socket.
      await vi.advanceTimersByTimeAsync(1);
      expect(hub.sockets.length).toBe(2);

      // Drive the second connection to ready. The fix: flushOutbox iterates
      // pending, which is empty, so only hello is sent — no stale call frame.
      hub.open(1);
      hub.welcome(1);
      await new Promise((r) => setImmediate(r));

      const newWsFrames = sentFrames(hub.sockets[1]);
      const calls = newWsFrames.filter((f) => f.k === "call");
      expect(calls).toEqual([]);
      // Sanity: hello did get sent on the new connection.
      expect(newWsFrames.some((f) => f.k === "hello")).toBe(true);
    });

    it("queued call before first open is transmitted exactly once after welcome", async () => {
      const { client, hub } = makeClient();
      void client.connect();

      // Call before socket opens. Goes into pending with transmitted=false.
      const callPromise = client.execute("list-windows");

      // No call frame on the wire yet — ws is CONNECTING.
      expect(sentFrames(hub.latest()).filter((f) => f.k === "call")).toEqual(
        [],
      );

      hub.open();
      hub.welcome();
      await new Promise((r) => setImmediate(r));

      // Exactly one call frame, with the expected id.
      const calls = sentFrames(hub.latest()).filter((f) => f.k === "call");
      expect(calls.length).toBe(1);

      // Deliver a result and confirm the promise resolves.
      const id = calls[0].id;
      expect(id).toBeDefined();
      const result: ResultFrame = {
        k: "result",
        id: id as string,
        ok: true,
        response: { commandNumber: 0, timestamp: 0, success: true, output: [] },
      };
      hub.latest().fire("message", {
        data: encodeServerFrame(result satisfies ServerFrame),
      });
      await expect(callPromise).resolves.toMatchObject({ success: true });
    });
  });

  describe("M3: close() settles pending synchronously", () => {
    it("pending promise is rejected before close() resolves", async () => {
      const { client, hub } = makeClient();
      void client.connect();
      hub.open();
      hub.welcome();
      await new Promise((r) => setImmediate(r));

      // Fire a call; never deliver a result.
      const callPromise = client.execute("list-windows");
      let settled = false;
      // Don't await yet — we want to observe state immediately after close().
      callPromise.catch(() => {
        settled = true;
      });

      await client.close();
      // Microtask flush so the .catch handler can run after rejection.
      await Promise.resolve();
      await Promise.resolve();

      expect(settled).toBe(true);
      await expect(callPromise).rejects.toMatchObject({
        code: "BRIDGE_CLOSED",
      });
    });

    it("a subsequent ws.onclose after close() is a no-op (finalize idempotent)", async () => {
      const { client, hub } = makeClient();
      void client.connect();
      hub.open();
      hub.welcome();
      await new Promise((r) => setImmediate(r));

      const callPromise = client.execute("list-windows");
      callPromise.catch(() => {});

      await client.close();
      // close() called ws.close(), which inside the mock fires "close".
      // The mock's close handler doesn't re-fire if already CLOSED, but
      // call it explicitly to prove finalize's idempotency guard.
      hub.fireClose(0, 1006, "post-close");
      await new Promise((r) => setImmediate(r));

      // State stays closed; promise still rejected with the close()'s reason
      // (NOT overwritten by the post-close event — finalize is idempotent so
      // the later onClose with reason "post-close" was a no-op).
      expect(client.connectionState.status).toBe("closed");
      const err = await callPromise.catch((e: unknown) => e);
      expect(err).toMatchObject({ code: "BRIDGE_CLOSED" });
      expect((err as Error).message).toContain("client close");
      expect((err as Error).message).not.toContain("post-close");
    });
  });

  describe("PR #29 review findings — post-open-pre-welcome window", () => {
    it("call frame is NOT transmitted between ws OPEN and server welcome", async () => {
      const { client, hub } = makeClient();
      void client.connect();

      // Open the socket but DO NOT send welcome yet. hello is sent via
      // rawSend (immediate). The server in this state is pending-hello
      // and would reject any non-hello frame with a protocol error.
      // ConnectionState stays "connecting" until welcome arrives.
      hub.open();
      await new Promise((r) => setImmediate(r));
      expect(client.connectionState.status).toBe("connecting");

      // Sanity: hello is on the wire, nothing else.
      const beforeCall = sentFrames(hub.latest()).filter(
        (f) => f.k !== "hello",
      );
      expect(beforeCall).toEqual([]);

      // Fire a call while in pre-welcome (socket open, welcome not yet received).
      const callPromise = client.execute("list-windows");
      // Microtask flush — transmit would have run synchronously if it
      // were going to fire.
      await Promise.resolve();

      // No call frame leaked to the wire yet — the state guard kept it
      // queued in pending.
      const duringOpen = sentFrames(hub.latest()).filter((f) => f.k === "call");
      expect(duringOpen).toEqual([]);

      // Now deliver welcome. flushOutbox runs, transmits the queued call.
      hub.welcome();
      await new Promise((r) => setImmediate(r));

      const afterWelcome = sentFrames(hub.latest()).filter(
        (f) => f.k === "call",
      );
      expect(afterWelcome.length).toBe(1);
      const id = afterWelcome[0].id;
      expect(id).toBeDefined();

      // Resolve the call so the test doesn't dangle a promise.
      const result: ResultFrame = {
        k: "result",
        id: id as string,
        ok: true,
        response: { commandNumber: 0, timestamp: 0, success: true, output: [] },
      };
      hub.latest().fire("message", {
        data: encodeServerFrame(result satisfies ServerFrame),
      });
      await expect(callPromise).resolves.toMatchObject({ success: true });
    });
  });

  describe("PR #29 review findings — close() during CONNECTING", () => {
    it("orphaned CONNECTING ws cannot re-transition a closed client", async () => {
      const { client, hub } = makeClient();
      void client.connect();
      // ws exists but is CONNECTING. Previously close() in this state
      // left the socket alive and its open/message handlers could move
      // the client back to "open"/"ready" through the closure-bound
      // `this`.
      expect(hub.latest().readyState).toBe(0); // CONNECTING

      await client.close();
      expect(client.connectionState.status).toBe("closed");

      // Now simulate the orphaned socket completing its handshake AFTER
      // close(): open arrives first, then welcome. finalizeConnection
      // retired the socket's route, so its listeners still fire but reach
      // nothing.
      hub.open();
      hub.welcome();
      await new Promise((r) => setImmediate(r));

      // State stayed closed; no resurrection.
      expect(client.connectionState.status).toBe("closed");
    });

    it("close() during CONNECTING aborts the underlying socket", async () => {
      const { client, hub } = makeClient();
      void client.connect();
      const ws = hub.latest();
      expect(ws.readyState).toBe(0); // CONNECTING

      let closeCalled = false;
      const realClose = ws.close;
      ws.close = (code, reason) => {
        closeCalled = true;
        realClose(code, reason);
      };

      await client.close();
      // The fix: close() unconditionally calls ws.close() to abort the
      // handshake, regardless of readyState. Pre-fix the OPEN-only guard
      // would have left a leaked socket alive.
      expect(closeCalled).toBe(true);
    });
  });

  describe("wwo.5.1: connect() gates on physical facts, not connectionState", () => {
    it("connect() with autoConnect:false opens a socket despite the initial 'connecting' state", () => {
      const { client, hub } = makeClient();
      // The unified union has no idle variant; the pre-connect state reads
      // "connecting" even though no socket exists yet. connect() must not
      // trust it.
      expect(client.connectionState.status).toBe("connecting");
      expect(hub.sockets.length).toBe(0);
      void client.connect();
      expect(hub.sockets.length).toBe(1);
    });

    it("connect() is a no-op while a live socket exists", async () => {
      const { client, hub } = makeClient();
      void client.connect();
      void client.connect(); // during CONNECTING
      hub.open();
      hub.welcome();
      await new Promise((r) => setImmediate(r));
      void client.connect(); // while ready
      expect(hub.sockets.length).toBe(1);
      await client.close();
    });

    it("connect() during reconnect backoff does not create a second socket", async () => {
      const { client, hub } = makeClient({ reconnect: true });
      void client.connect();
      hub.open();
      hub.welcome();
      await new Promise((r) => setImmediate(r));

      // Sever the connection; the client enters backoff with the retry
      // timer armed.
      hub.fireClose(0, 1006, "abnormal");
      expect(client.connectionState.status).toBe("reconnecting");
      expect(hub.sockets.length).toBe(1);

      // "Retry now" during backoff must not open a socket underneath the
      // one the timer owns.
      void client.connect();
      expect(hub.sockets.length).toBe(1);

      // The timer fires and opens exactly one new socket.
      await vi.advanceTimersByTimeAsync(1);
      expect(hub.sockets.length).toBe(2);

      hub.open(1);
      hub.welcome(1);
      await new Promise((r) => setImmediate(r));
      expect(client.connectionState.status).toBe("ready");
      expect(hub.sockets.length).toBe(2);
      await client.close();
    });

    it("connect() after close() starts a fresh reconnect budget", async () => {
      const { client, hub } = makeClient({ reconnect: true }); // maxAttempts: 3
      void client.connect();
      hub.open();
      hub.welcome();
      await new Promise((r) => setImmediate(r));

      // Burn two reconnect attempts in this episode.
      hub.fireClose(0, 1006, "abnormal");
      expect(client.connectionState).toMatchObject({
        status: "reconnecting",
        attempt: 1,
      });
      await vi.advanceTimersByTimeAsync(1);
      hub.fireClose(1, 1006, "abnormal");
      expect(client.connectionState).toMatchObject({
        status: "reconnecting",
        attempt: 2,
      });
      await vi.advanceTimersByTimeAsync(1);

      // Consumer ends the episode, then starts a new one. The stale count
      // (2) must not leak into the new episode's budget.
      await client.close();
      void client.connect();
      hub.fireClose(hub.sockets.length - 1, 1006, "abnormal");
      expect(client.connectionState).toMatchObject({
        status: "reconnecting",
        attempt: 1,
      });
      await client.close();
    });

    it("connect() after close() re-arms the client", async () => {
      const { client, hub } = makeClient();
      void client.connect();
      hub.open();
      hub.welcome();
      await new Promise((r) => setImmediate(r));
      await client.close();
      expect(client.connectionState.status).toBe("closed");

      void client.connect();
      expect(hub.sockets.length).toBe(2);
      hub.open(1);
      hub.welcome(1);
      await new Promise((r) => setImmediate(r));
      expect(client.connectionState.status).toBe("ready");
      await client.close();
    });
  });

  describe("wwo.5.1: server drain is a fact, not a lifecycle phase", () => {
    it("draining keeps the connection ready and refuses new calls truthfully", async () => {
      const deadlines: number[] = [];
      const { client, hub } = makeClient({
        onDraining: (dl) => deadlines.push(dl),
      });
      void client.connect();
      hub.open();
      hub.welcome();
      await new Promise((r) => setImmediate(r));
      expect(client.connectionState.status).toBe("ready");

      hub.latest().fire("message", {
        data: encodeServerFrame({
          k: "draining",
          deadlineMs: 1234,
        } satisfies ServerFrame),
      });
      await new Promise((r) => setImmediate(r));

      expect(deadlines).toEqual([1234]);
      // The socket is still open and in-flight calls are still served;
      // reporting "closed" here would be a lie.
      expect(client.connectionState.status).toBe("ready");
      await expect(client.execute("list-windows")).rejects.toMatchObject({
        code: "BRIDGE_CLOSED",
        message: expect.stringContaining("draining"),
      });

      // The server closing the socket drives the ordinary finalize path;
      // no error occurred, so the reason is a clean exit.
      hub.fireClose(0, 1001, "drain complete");
      expect(client.connectionState).toEqual({
        status: "closed",
        reason: "exit",
      });
      await expect(client.execute("list-windows")).rejects.toMatchObject({
        code: "BRIDGE_CLOSED",
        message: expect.stringContaining("closed"),
      });
    });

    it("a drain notice does not outlive its connection: calls during post-drain backoff queue for the new connection", async () => {
      const { client, hub } = makeClient({ reconnect: true });
      void client.connect();
      hub.open();
      hub.welcome();
      await new Promise((r) => setImmediate(r));

      // Drain notice on connection 0, then the server closes the socket.
      hub.latest().fire("message", {
        data: encodeServerFrame({
          k: "draining",
          deadlineMs: 99,
        } satisfies ServerFrame),
      });
      await new Promise((r) => setImmediate(r));
      hub.fireClose(0, 1001, "drain complete");
      expect(client.connectionState).toMatchObject({
        status: "reconnecting",
        attempt: 1,
      });

      // The drain fact was scoped to the dead connection. A call during
      // backoff queues in pending — a stale "server is draining" rejection
      // here is the regression under test.
      const callPromise = client.execute("list-windows");

      await vi.advanceTimersByTimeAsync(1);
      hub.open(1);
      hub.welcome(1);
      await new Promise((r) => setImmediate(r));

      // The queued call went out on the new connection and resolves there.
      const calls = sentFrames(hub.sockets[1]).filter((f) => f.k === "call");
      expect(calls.length).toBe(1);
      const id = calls[0].id;
      expect(id).toBeDefined();
      const result: ResultFrame = {
        k: "result",
        id: id as string,
        ok: true,
        response: { commandNumber: 0, timestamp: 0, success: true, output: [] },
      };
      hub.sockets[1].fire("message", {
        data: encodeServerFrame(result satisfies ServerFrame),
      });
      await expect(callPromise).resolves.toMatchObject({ success: true });
      await client.close();
    });
  });

  describe("M11: post-close calls reject; no queued frames survive", () => {
    it("queued call rejects and a subsequent call rejects immediately", async () => {
      const { client, hub } = makeClient();
      void client.connect();

      const callA = client.execute("list-windows");
      await client.close();
      await Promise.resolve();

      await expect(callA).rejects.toMatchObject({ code: "BRIDGE_CLOSED" });

      // No queued frame should have been sent on the (still-CONNECTING) socket.
      const calls = sentFrames(hub.latest()).filter((f) => f.k === "call");
      expect(calls).toEqual([]);

      // Subsequent call rejects synchronously per the closed-state guard.
      await expect(client.execute("list-panes")).rejects.toMatchObject({
        code: "BRIDGE_CLOSED",
      });
    });
  });
});

describe("WebSocketTmuxClient — cross-session layout coverage", () => {
  it("enables over RPC and emits the decoded events the server forwards", async () => {
    const { client, hub } = makeClient();
    void client.connect();
    hub.open();
    hub.welcome();
    const ws = hub.latest();

    const enabled = client.enableCrossSessionLayoutChange();
    const call = sentFrames(ws).find((f) => f.k === "call");
    expect(call).toMatchObject({
      method: "enableCrossSessionLayoutChange",
      args: [],
    });
    ws.fire("message", {
      data: encodeServerFrame({
        k: "result",
        id: call!.id!,
        ok: true,
        response: null,
      }),
    });
    await expect(enabled).resolves.toBeUndefined();

    const seen: unknown[] = [];
    client.on("cross-session-layout-change", (ev) => seen.push(ev));
    const change = {
      type: "cross-session-layout-change",
      sessionId: 1,
      windowId: 7,
      ...windowLayoutFields("b25d,80x24,0,0,0", "b25d,80x24,0,0,0", "*"),
    } as const;
    ws.fire("message", {
      data: encodeServerFrame({ k: "event", msg: change }),
    });
    expect(seen).toEqual([change]);
  });
});

describe("WebSocketTmuxClient — reply-stream reports", () => {
  it("emits the unsolicited-response and protocol-error events the server forwards", () => {
    const { client, hub } = makeClient();
    void client.connect();
    hub.open();
    hub.welcome();
    const ws = hub.latest();

    const seen: unknown[] = [];
    client.on("unsolicited-response", (ev) => seen.push(ev));
    client.on("protocol-error", (ev) => seen.push(ev));
    const unsolicited = {
      type: "unsolicited-response",
      response: {
        commandNumber: 6,
        timestamp: 7,
        output: ["hook ran"],
        success: true,
      },
    } as const;
    const protocolError = {
      type: "protocol-error",
      kind: "terminator",
      commandNumber: 9,
      line: "%end 7 9",
    } as const;
    for (const msg of [unsolicited, protocolError]) {
      ws.fire("message", { data: encodeServerFrame({ k: "event", msg }) });
    }
    expect(seen).toEqual([unsolicited, protocolError]);
  });
});

describe("WebSocketTmuxClient — cross-session layout coverage across reconnect", () => {
  // Answer every call frame on `ws` that has not been answered yet.
  function answerCalls(ws: MockWS, answered: Set<string>): void {
    for (const f of sentFrames(ws)) {
      if (f.k !== "call" || f.id === undefined || answered.has(f.id)) continue;
      answered.add(f.id);
      ws.fire("message", {
        data: encodeServerFrame({
          k: "result",
          id: f.id,
          ok: true,
          response: null,
        }),
      });
    }
  }

  function enableCalls(ws: MockWS): number {
    return sentFrames(ws).filter(
      (f) =>
        f.k === "call" &&
        (f as { method?: string }).method === "enableCrossSessionLayoutChange",
    ).length;
  }

  it("replays the outstanding enables on the new connection", async () => {
    const { client, hub } = makeClient({ reconnect: true });
    void client.connect();
    hub.open(0);
    hub.welcome(0);
    const answered = new Set<string>();

    for (const call of [
      () => client.enableCrossSessionLayoutChange(),
      () => client.enableCrossSessionLayoutChange(),
      () => client.disableCrossSessionLayoutChange(),
    ]) {
      const p = call();
      answerCalls(hub.sockets[0], answered);
      await p;
    }

    hub.fireClose(0, 1006, "abnormal");
    await vi.advanceTimersByTimeAsync(1);
    hub.open(1);
    hub.welcome(1);

    // Two enables, one disable: the new server-side peer gets one enable.
    expect(enableCalls(hub.sockets[1])).toBe(1);
    answerCalls(hub.sockets[1], answered);
    await client.close();
  });
});

describe("topology across a reconnect", () => {
  it("does not report a bootstrap the drop rejected, and re-seeds on the next connection", async () => {
    const { client, hub } = makeClient({ reconnect: true });
    const errors: unknown[] = [];
    client.on("topology-error", (ev) => errors.push(ev));
    void client.connect();
    hub.open();
    hub.welcome();
    await new Promise((r) => setImmediate(r));
    client.attachBytesSink(
      { write() {}, end() {} },
      { scope: sessionScope(1) },
    );
    const bootstraps = (ws: MockWS) =>
      ws.sent.filter((s) => s.includes("list-panes -a")).length;
    expect(bootstraps(hub.sockets[0]!)).toBe(1);

    hub.fireClose(0, 1006, "abnormal");
    expect(client.connectionState.status).toBe("reconnecting");
    await new Promise((r) => setImmediate(r));
    expect(errors).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    hub.open(1);
    hub.welcome(1);
    await new Promise((r) => setImmediate(r));
    // One bootstrap: the new connection's own, not a recovery query beside it.
    expect(bootstraps(hub.sockets[1]!)).toBe(1);
    expect(errors).toEqual([]);
    await client.close();
  });
});

// ---------------------------------------------------------------------------
// Heartbeat cadence is parsed at construction (6sp.lr4). A pong deadline no
// pong could meet fails here, naming the option, instead of closing every
// connection one interval after welcome.
// ---------------------------------------------------------------------------

describe("WebSocketTmuxClient — heartbeat options are parsed at construction", () => {
  function build(opts: {
    heartbeatIntervalMs?: number;
    heartbeatTimeoutMs?: number;
  }): { fn: () => unknown; hub: MockWebSocketHub } {
    const hub = new MockWebSocketHub();
    const fn = (): unknown =>
      new WebSocketTmuxClient({
        url: "ws://test/",
        createWebSocket: hub.factory as unknown as (
          url: string,
        ) => BrowserWebSocketLike,
        ...opts,
      });
    return { fn, hub };
  }

  it("heartbeatTimeoutMs: 0 throws BRIDGE_INVALID_ARG naming the option and value, and opens no socket", () => {
    const { fn, hub } = build({ heartbeatTimeoutMs: 0 });
    expect(fn).toThrow(BridgeError);
    expect(fn).toThrow(/BRIDGE_INVALID_ARG/);
    expect(fn).toThrow("heartbeatTimeoutMs (0) must be");
    expect(hub.sockets).toHaveLength(0);
  });

  it("a negative heartbeatIntervalMs throws naming the option, the value, and the off switch", () => {
    const { fn, hub } = build({ heartbeatIntervalMs: -1 });
    expect(fn).toThrow(/BRIDGE_INVALID_ARG/);
    expect(fn).toThrow("heartbeatIntervalMs (-1) must be 0 (heartbeat off) or");
    expect(hub.sockets).toHaveLength(0);
  });

  it("heartbeatIntervalMs: 0 constructs and connects", () => {
    const { fn, hub } = build({ heartbeatIntervalMs: 0 });
    expect(fn).not.toThrow();
    expect(hub.sockets).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The call timeout and the reconnect policy are parsed at the same border
// (6sp.1lh). A deadline no reply could meet used to reject every call with
// BRIDGE_TIMEOUT one macrotask after it was sent; a negative retry delay was
// an immediate retry storm. Both fail here, naming the option.
// ---------------------------------------------------------------------------

describe("WebSocketTmuxClient — call timeout and reconnect policy are parsed at construction", () => {
  function build(opts: {
    requestTimeoutMs?: number;
    reconnect?: ReconnectPolicy;
  }): { fn: () => unknown; hub: MockWebSocketHub } {
    const hub = new MockWebSocketHub();
    const fn = (): unknown =>
      new WebSocketTmuxClient({
        url: "ws://test/",
        createWebSocket: hub.factory as unknown as (
          url: string,
        ) => BrowserWebSocketLike,
        ...opts,
      });
    return { fn, hub };
  }

  it("requestTimeoutMs: 0 throws BRIDGE_INVALID_ARG naming the option and value, and opens no socket", () => {
    const { fn, hub } = build({ requestTimeoutMs: 0 });
    expect(fn).toThrow(BridgeError);
    expect(fn).toThrow(/BRIDGE_INVALID_ARG/);
    expect(fn).toThrow("requestTimeoutMs (0) must be an integer number of ms");
    expect(hub.sockets).toHaveLength(0);
  });

  it("a negative reconnect.initialDelayMs throws naming the policy field and value, and opens no socket", () => {
    const { fn, hub } = build({
      reconnect: { maxAttempts: 1, initialDelayMs: -1 },
    });
    expect(fn).toThrow(BridgeError);
    expect(fn).toThrow(/BRIDGE_INVALID_ARG/);
    expect(fn).toThrow("reconnect.initialDelayMs (-1) must be");
    expect(hub.sockets).toHaveLength(0);
  });

  it("reconnect.maxAttempts: 0 with default delays constructs and connects", () => {
    const { fn, hub } = build({ reconnect: { maxAttempts: 0 } });
    expect(fn).not.toThrow();
    expect(hub.sockets).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The server's advertised call timeout is stamped at the wire and reconciled
// with the consumer's: a call's deadline is the stricter of the two, and a
// welcome advertising a bound no timer honors is a protocol fault on the
// error channel, not a deadline every call then fails.
// ---------------------------------------------------------------------------

describe("WebSocketTmuxClient — the per-call deadline is the stricter of the consumer's and the server's", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function connected(requestTimeoutMs: number): {
    client: WebSocketTmuxClient;
    hub: MockWebSocketHub;
    errors: BridgeError[];
  } {
    const hub = new MockWebSocketHub();
    const errors: BridgeError[] = [];
    const client = new WebSocketTmuxClient({
      url: "ws://test/",
      requestTimeoutMs,
      createWebSocket: hub.factory as unknown as (
        url: string,
      ) => BrowserWebSocketLike,
      onError: (e) => errors.push(e),
    });
    hub.open();
    return { client, hub, errors };
  }

  async function timesOutAt(p: Promise<unknown>, ms: number): Promise<void> {
    let settled: unknown = null;
    p.catch((e: unknown) => {
      settled = e;
    });
    await vi.advanceTimersByTimeAsync(ms - 1);
    expect(settled).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBeInstanceOf(BridgeError);
    expect((settled as BridgeError).code).toBe("BRIDGE_TIMEOUT");
  }

  it("uses the server's bound when it is the smaller", async () => {
    const { client, hub } = connected(5_000);
    hub.welcome(-1, 0, parseDurationMs("requestTimeoutMs", 1_000));
    await timesOutAt(client.listSessions(), 1_000);
    await client.close();
  });

  it("uses the consumer's bound when it is the smaller", async () => {
    const { client, hub } = connected(500);
    hub.welcome(-1, 0, parseDurationMs("requestTimeoutMs", 1_000));
    await timesOutAt(client.listSessions(), 500);
    await client.close();
  });
});

// ---------------------------------------------------------------------------
// Cadence policy: the client pings at the consumer's interval when one was
// given, else at the one the server advertised in its welcome.
// ---------------------------------------------------------------------------

describe("WebSocketTmuxClient — heartbeat cadence is the consumer's interval, else the server's", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const SERVER_INTERVAL = parseDurationMs("heartbeatIntervalMs", 1_000);

  function connected(opts: { heartbeatIntervalMs?: number }): {
    client: WebSocketTmuxClient;
    hub: MockWebSocketHub;
  } {
    const hub = new MockWebSocketHub();
    const client = new WebSocketTmuxClient({
      url: "ws://test/",
      createWebSocket: hub.factory as unknown as (
        url: string,
      ) => BrowserWebSocketLike,
      ...opts,
    });
    hub.open();
    hub.welcome(-1, SERVER_INTERVAL);
    return { client, hub };
  }

  function pingsSent(ws: MockWS): number {
    return ws.sent.filter((s) => (JSON.parse(s) as { k: string }).k === "ping")
      .length;
  }

  it("an omitted interval adopts the server's advertised one", async () => {
    const { client, hub } = connected({});
    await vi.advanceTimersByTimeAsync(SERVER_INTERVAL - 1);
    expect(pingsSent(hub.latest())).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(pingsSent(hub.latest())).toBe(1);
    await client.close();
  });

  it("the consumer's 0 silences the probe the server advertised", async () => {
    const { client, hub } = connected({ heartbeatIntervalMs: 0 });
    await vi.advanceTimersByTimeAsync(SERVER_INTERVAL * 5);
    expect(pingsSent(hub.latest())).toBe(0);
    await client.close();
  });

  it("the consumer's interval wins over the server's", async () => {
    const { client, hub } = connected({ heartbeatIntervalMs: 250 });
    await vi.advanceTimersByTimeAsync(250);
    expect(pingsSent(hub.latest())).toBe(1);
    await client.close();
  });
});

describe("WebSocketTmuxClient — one command is one non-empty line", () => {
  it.each([["new-window -c '/tmp/a\nb'"], ["new-window -e 'A=x\0y'"]])(
    "refuses %j with the TmuxInvalidCommandError a local TmuxClient throws, and sends no call",
    async (bad) => {
      const { client, hub } = makeClient();
      const ready = client.connect();
      hub.open();
      hub.welcome();
      await ready;

      await expect(client.execute(bad)).rejects.toBeInstanceOf(
        TmuxInvalidCommandError,
      );
      expect(sentFrames(hub.latest()).filter((f) => f.k === "call")).toEqual(
        [],
      );
      await client.close();
    },
  );
});

// ---------------------------------------------------------------------------
// The handshake: the welcome is the only frame that moves a connection out
// of "connecting", so a frame the client cannot read before then fails the
// connection instead of leaving it open and silent.
// ---------------------------------------------------------------------------

describe("WebSocketTmuxClient — a protocol fault before ready fails the handshake", () => {
  const limits = (over: Record<string, unknown>) =>
    JSON.stringify({
      k: "welcome",
      limits: {
        requestTimeoutMs: 30_000,
        heartbeatIntervalMs: 0,
        maxInflight: 16,
        ...over,
      },
    });
  const BAD_WELCOMES: readonly (readonly [string, string, string])[] = [
    [
      "heartbeatIntervalMs: -1 (a bridge from the previous release)",
      limits({ heartbeatIntervalMs: -1 }),
      "welcome.limits.heartbeatIntervalMs",
    ],
    [
      "requestTimeoutMs: 0",
      limits({ requestTimeoutMs: 0 }),
      "welcome.limits.requestTimeoutMs (0) must be",
    ],
    ["no limits", JSON.stringify({ k: "welcome" }), "limits"],
  ];

  it.each(BAD_WELCOMES)(
    "a welcome with %s closes the socket with 4002, rejects the queued call with the fault, and reads transport-error",
    async (_label, frame, field) => {
      const errors: BridgeError[] = [];
      const hub = new MockWebSocketHub();
      const client = new WebSocketTmuxClient({
        url: "ws://test/",
        createWebSocket: hub.factory as unknown as (
          url: string,
        ) => BrowserWebSocketLike,
        onError: (e) => errors.push(e),
      });
      const ws = hub.latest();
      const close = vi.spyOn(ws, "close");
      const call = client.listSessions();
      hub.open();
      ws.fire("message", { data: frame });

      expect(errors).toHaveLength(1);
      const fault = errors[0]!;
      expect(fault.code).toBe("BRIDGE_PROTOCOL_ERROR");
      expect(fault.message).toContain(field);
      expect(close).toHaveBeenCalledExactlyOnceWith(
        4002,
        closeReason(fault.bareMessage()),
      );
      expect(ws.readyState).toBe(3);
      expect(client.connectionState).toEqual({
        status: "closed",
        reason: "transport-error",
      });
      await expect(call).rejects.toBe(fault);
    },
  );

  it("with a reconnect policy the failed handshake retries, and an old bridge fails it again", async () => {
    const { client, hub } = makeClient({ reconnect: true });
    void client.connect();
    hub.open();
    hub.latest().fire("message", { data: BAD_WELCOMES[0]![1] });
    expect(client.connectionState).toMatchObject({
      status: "reconnecting",
      attempt: 1,
      lastError: { code: "BRIDGE_PROTOCOL_ERROR" },
    });

    await vi.advanceTimersByTimeAsync(1);
    expect(hub.sockets).toHaveLength(2);
    hub.open(1);
    hub.latest().fire("message", { data: BAD_WELCOMES[0]![1] });
    expect(client.connectionState).toMatchObject({
      status: "reconnecting",
      attempt: 2,
    });
    await client.close();
  });

  it("a malformed frame after a good welcome is reported and the connection stays up", async () => {
    const errors: BridgeError[] = [];
    const hub = new MockWebSocketHub();
    const client = new WebSocketTmuxClient({
      url: "ws://test/",
      createWebSocket: hub.factory as unknown as (
        url: string,
      ) => BrowserWebSocketLike,
      onError: (e) => errors.push(e),
    });
    hub.open();
    hub.welcome();
    hub.latest().fire("message", { data: "{not json" });

    expect(errors).toHaveLength(1);
    expect(errors[0]!.code).toBe("BRIDGE_PROTOCOL_ERROR");
    expect(client.connectionState.status).toBe("ready");
    expect(hub.latest().readyState).toBe(1);
    await client.close();
  });
});

// ---------------------------------------------------------------------------
// A heartbeat timeout: the peer is dead when the pong deadline passes, not
// when the runtime's close handshake eventually gives up on it.
// ---------------------------------------------------------------------------

describe("WebSocketTmuxClient — a heartbeat timeout ends the connection when it fires", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // A dead peer: the close handshake has nobody to answer it, so the
  // runtime fires no close event.
  function deadPeerClient(reconnect: ReconnectPolicy | undefined) {
    const errors: BridgeError[] = [];
    const hub = new MockWebSocketHub();
    const client = new WebSocketTmuxClient({
      url: "ws://test/",
      heartbeatTimeoutMs: 500,
      reconnect,
      createWebSocket: hub.factory as unknown as (
        url: string,
      ) => BrowserWebSocketLike,
      onError: (e) => errors.push(e),
    });
    const dead = hub.latest();
    const close = vi.spyOn(dead, "close").mockImplementation(() => {
      dead.readyState = 2; // CLOSING
    });
    hub.open();
    hub.welcome(-1, parseDurationMs("heartbeatIntervalMs", 1_000));
    return { client, hub, dead, close, errors };
  }

  it("settles pending calls and leaves ready at the deadline, though no close event arrives", async () => {
    const { client, close, errors } = deadPeerClient(undefined);
    let settled: unknown = null;
    client.listSessions().catch((e: unknown) => {
      settled = e;
    });

    await vi.advanceTimersByTimeAsync(1_499);
    expect(settled).toBeNull();
    await vi.advanceTimersByTimeAsync(1);

    expect(settled).toMatchObject({
      code: "BRIDGE_CLOSED",
      message: expect.stringContaining("heartbeat timeout"),
    });
    expect(close).toHaveBeenCalledExactlyOnceWith(4000, "heartbeat timeout");
    expect(errors).toEqual([settled]);
    expect(client.connectionState).toEqual({
      status: "closed",
      reason: "transport-error",
    });
  });

  it("the timed-out socket's late result and close reach nothing once the reconnect is ready", async () => {
    const { client, hub, dead, errors } = deadPeerClient({
      maxAttempts: 3,
      initialDelayMs: 1,
      maxDelayMs: 1,
      factor: 1,
      jitterMs: 0,
    });
    void client.listSessions().catch(() => undefined);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(client.connectionState.status).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(1);
    expect(hub.sockets).toHaveLength(2);
    hub.open();
    hub.welcome();
    const reported = errors.length;

    // The answer to the call the timeout already rejected, then the close
    // event the runtime fires when it finally gives up on the dead socket.
    const late: ResultFrame = {
      k: "result",
      id: "r1",
      ok: true,
      response: { commandNumber: 0, timestamp: 0, success: true, output: [] },
    };
    dead.fire("message", {
      data: encodeServerFrame(late satisfies ServerFrame),
    });
    dead.fire("close", { code: 1006, reason: "" });

    expect(errors).toHaveLength(reported);
    expect(client.connectionState.status).toBe("ready");
    expect(hub.latest().readyState).toBe(1);
    await client.close();
  });
});
