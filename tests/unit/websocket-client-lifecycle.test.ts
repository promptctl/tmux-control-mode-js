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
  encodePaneOutput,
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
  // Listener registry as `ws` implements it: removeEventListener is the
  // only teardown. `ws` ignores an `{ signal }` option, so this mock does
  // not take one — a client that relied on it would leak listeners here
  // exactly as it does under `ws`.
  addEventListener(event: string, listener: Listener): void;
  removeEventListener(event: string, listener: Listener): void;
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
      removeEventListener(event, listener) {
        listeners.get(event)?.delete(listener);
      },
      fire(event, payload) {
        const set = listeners.get(event) ?? new Set();
        // `ws`'s WebSocket is an EventEmitter: an 'error' nobody listens
        // for throws in the host process.
        if (event === "error" && set.size === 0) {
          throw new Error("unhandled 'error' event");
        }
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
  opts: {
    reconnect?: boolean;
    onDraining?: (deadlineMs: number) => void;
    onError?: (error: BridgeError) => void;
  } = {},
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
    onError: opts.onError,
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

      // [LAW:verifiable-goals] Poll until the reconnect timer has fired
      // and openSocket created the second socket. A fixed sleep would be
      // a guess about timer scheduling on the runner; this predicate is
      // exact. Matches the pattern in connection-state.test.ts.
      const deadline = Date.now() + 100;
      while (hub.sockets.length < 2 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2));
      }
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
      // removed every listener the client added to that socket, so these
      // `fire` calls find an empty listener set and invoke nothing.
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

  describe("6sp.sak: a finalized socket says nothing to the next connection", () => {
    it("close() then connect(): the first socket's late close leaves the second connection up", async () => {
      const { client, hub } = makeClient();
      void client.connect();
      hub.open(0);
      hub.welcome(0);
      await client.close();
      void client.connect();
      expect(hub.sockets.length).toBe(2);
      expect(client.connectionState.status).toBe("connecting");

      // The first socket's close handshake completes after the second
      // socket exists — the order a real `ws` delivers it in.
      hub.fireClose(0, 1000, "client close");
      expect(client.connectionState.status).toBe("connecting");

      hub.open(1);
      hub.welcome(1);
      expect(client.connectionState.status).toBe("ready");
      const call = client.execute("list-windows");
      const id = sentFrames(hub.sockets[1]).find((f) => f.k === "call")?.id;
      const result: ResultFrame = {
        k: "result",
        id: id as string,
        ok: true,
        response: { commandNumber: 0, timestamp: 0, success: true, output: [] },
      };
      hub.sockets[1].fire("message", {
        data: encodeServerFrame(result satisfies ServerFrame),
      });
      await expect(call).resolves.toMatchObject({ success: true });
      expect(client.connectionState.status).toBe("ready");
    });

    it("close() during CONNECTING then connect(): the first socket's late error and close are absorbed", async () => {
      const errors: BridgeError[] = [];
      const { client, hub } = makeClient({ onError: (e) => errors.push(e) });
      void client.connect();
      await client.close();
      void client.connect();

      // `ws` aborts the handshake of a socket closed while CONNECTING and
      // emits 'error' on the next tick, after the client has let it go.
      expect(() => hub.sockets[0].fire("error", {})).not.toThrow();
      hub.fireClose(0, 1006, "aborted");
      expect(errors).toEqual([]);

      hub.open(1);
      hub.welcome(1);
      expect(client.connectionState.status).toBe("ready");
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
      const deadline = Date.now() + 100;
      while (hub.sockets.length < 2 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2));
      }
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
      let deadline = Date.now() + 100;
      while (hub.sockets.length < 2 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2));
      }
      hub.fireClose(1, 1006, "abnormal");
      expect(client.connectionState).toMatchObject({
        status: "reconnecting",
        attempt: 2,
      });
      deadline = Date.now() + 100;
      while (hub.sockets.length < 3 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2));
      }

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

      const deadline = Date.now() + 100;
      while (hub.sockets.length < 2 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2));
      }
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
    const deadline = Date.now() + 100;
    while (hub.sockets.length < 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2));
    }
    hub.open(1);
    hub.welcome(1);

    // Two enables, one disable: the new server-side peer gets one enable.
    expect(enableCalls(hub.sockets[1])).toBe(1);
    answerCalls(hub.sockets[1], answered);
    await client.close();
  });

  it("calls queued during the outage land on the replayed coverage in the order they were made", async () => {
    const { client, hub } = makeClient({ reconnect: true });
    void client.connect();
    hub.open(0);
    hub.welcome(0);
    const answered = new Set<string>();
    const held = client.enableCrossSessionLayoutChange();
    answerCalls(hub.sockets[0], answered);
    await held;

    hub.fireClose(0, 1006, "abnormal");
    const enabled = client.enableCrossSessionLayoutChange();
    const disabled = client.disableCrossSessionLayoutChange();
    const deadline = Date.now() + 100;
    while (hub.sockets.length < 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2));
    }
    hub.open(1);
    hub.welcome(1);

    // The replay rebuilds the old peer's one enable; the queued enable and
    // disable then net to nothing, leaving the new peer the one the
    // consumer still holds.
    const calls = sentFrames(hub.sockets[1])
      .filter((f) => f.k === "call")
      .map((f) => (f as { method?: string }).method);
    expect(calls).toEqual([
      "enableCrossSessionLayoutChange",
      "enableCrossSessionLayoutChange",
      "disableCrossSessionLayoutChange",
    ]);
    answerCalls(hub.sockets[1], answered);
    await Promise.all([enabled, disabled]);

    // The count settled at one: the next connection replays exactly one.
    hub.fireClose(1, 1006, "abnormal");
    while (hub.sockets.length < 3 && Date.now() < deadline + 100) {
      await new Promise((r) => setTimeout(r, 2));
    }
    hub.open(2);
    hub.welcome(2);
    expect(enableCalls(hub.sockets[2])).toBe(1);
    answerCalls(hub.sockets[2], answered);
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

    const deadline = Date.now() + 100;
    while (hub.sockets.length < 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2));
    }
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

  it("a welcome advertising requestTimeoutMs: 0 is reported as BRIDGE_PROTOCOL_ERROR naming the field", () => {
    const { client, hub, errors } = connected(5_000);
    hub.latest().fire("message", {
      data: JSON.stringify({
        k: "welcome",
        limits: {
          requestTimeoutMs: 0,
          heartbeatIntervalMs: 0,
          maxInflight: 16,
        },
      }),
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]!.code).toBe("BRIDGE_PROTOCOL_ERROR");
    expect(errors[0]!.message).toContain(
      "welcome.limits.requestTimeoutMs (0) must be",
    );
    // The malformed welcome failed the handshake rather than making the
    // connection ready.
    expect(client.connectionState).toEqual({
      status: "closed",
      reason: "transport-error",
    });
    void client.close();
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
// A callback may close() or connect() at any transition (6sp.9f7): the client
// ends in the state its last call asked for, and nothing a transition did
// after the callback's call survives it — no heartbeat, retry or socket runs
// on a closed client.
// ---------------------------------------------------------------------------

describe("WebSocketTmuxClient — a callback may close() or connect() at any transition", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const HEARTBEAT = parseDurationMs("heartbeatIntervalMs", 1_000);

  function harness() {
    const hub = new MockWebSocketHub();
    const slots: {
      onError: (err: BridgeError) => void;
      onDraining: (deadlineMs: number) => void;
    } = { onError: () => {}, onDraining: () => {} };
    const client = new WebSocketTmuxClient({
      url: "ws://test/",
      autoConnect: false,
      createWebSocket: hub.factory as unknown as (
        url: string,
      ) => BrowserWebSocketLike,
      onError: (err) => slots.onError(err),
      onDraining: (deadlineMs) => slots.onDraining(deadlineMs),
      reconnect: {
        maxAttempts: 3,
        initialDelayMs: 1,
        maxDelayMs: 1,
        factor: 1,
        jitterMs: 0,
      },
    });
    const ready = (idx = -1) => {
      hub.open(idx);
      hub.welcome(idx, HEARTBEAT);
    };
    // A dropped first connection, retried and welcomed: a re-ready.
    const reReady = async () => {
      ready();
      hub.fireClose();
      await vi.advanceTimersByTimeAsync(1);
      ready();
    };
    return { hub, client, slots, ready, reReady };
  }

  function pings(hub: MockWebSocketHub): number {
    return hub.sockets
      .flatMap((ws) => sentFrames(ws))
      .filter((f) => f.k === "ping").length;
  }

  // Closed for good: no socket opens and no ping leaves after the close.
  async function expectStaysClosed(
    hub: MockWebSocketHub,
    client: WebSocketTmuxClient,
  ): Promise<void> {
    expect(client.connectionState.status).toBe("closed");
    const sockets = hub.sockets.length;
    const sent = pings(hub);
    await vi.advanceTimersByTimeAsync(HEARTBEAT * 5);
    expect(client.connectionState.status).toBe("closed");
    expect(hub.sockets.length).toBe(sockets);
    expect(pings(hub)).toBe(sent);
  }

  // One-shot: the first time `status` is announced, run `act`.
  function onFirst(
    client: WebSocketTmuxClient,
    status: string,
    act: () => void,
  ): void {
    let done = false;
    client.on("connection-state", (ev) => {
      if (done || ev.state.status !== status) return;
      done = true;
      act();
    });
  }

  it("close() from a ready listener", async () => {
    const h = harness();
    onFirst(h.client, "ready", () => void h.client.close());
    void h.client.connect();
    h.ready();
    await expectStaysClosed(h.hub, h.client);
  });

  it("close() from a ready listener on a re-ready", async () => {
    const h = harness();
    let readies = 0;
    h.client.on("connection-state", (ev) => {
      if (ev.state.status === "ready" && ++readies === 2) void h.client.close();
    });
    void h.client.connect();
    await h.reReady();
    await expectStaysClosed(h.hub, h.client);
  });

  it("close() from a reconnected listener", async () => {
    const h = harness();
    h.client.on("reconnected", () => void h.client.close());
    void h.client.connect();
    await h.reReady();
    await expectStaysClosed(h.hub, h.client);
  });

  it("close() from a reconnecting listener", async () => {
    const h = harness();
    onFirst(h.client, "reconnecting", () => void h.client.close());
    void h.client.connect();
    h.ready();
    h.hub.fireClose();
    await expectStaysClosed(h.hub, h.client);
  });

  it("close() from a connecting listener on the retry", async () => {
    const h = harness();
    // The client starts in connecting, so the retry's is the first announced.
    onFirst(h.client, "connecting", () => void h.client.close());
    void h.client.connect();
    h.ready();
    h.hub.fireClose();
    await vi.advanceTimersByTimeAsync(1);
    await expectStaysClosed(h.hub, h.client);
  });

  it("close() from onError", async () => {
    const h = harness();
    h.slots.onError = () => void h.client.close();
    void h.client.connect();
    h.ready();
    h.hub.latest().fire("message", { data: 42 });
    await expectStaysClosed(h.hub, h.client);
  });

  it("close() from onDraining", async () => {
    const h = harness();
    h.slots.onDraining = () => void h.client.close();
    void h.client.connect();
    h.ready();
    h.hub.latest().fire("message", {
      data: encodeServerFrame({ k: "draining", deadlineMs: 5_000 }),
    });
    await expectStaysClosed(h.hub, h.client);
  });

  it("close() from a ready listener ends with the closed it asked for, heard after ready and reconnected", async () => {
    const h = harness();
    const heard: string[] = [];
    let readies = 0;
    h.client.on("connection-state", (ev) => {
      heard.push(ev.state.status);
      if (ev.state.status === "ready" && ++readies === 2) void h.client.close();
    });
    h.client.on("reconnected", () => heard.push("reconnected"));
    void h.client.connect();
    await h.reReady();
    expect(heard.slice(-3)).toEqual(["ready", "reconnected", "closed"]);
  });

  it("connect() from a closed listener after close() opens a new connection", async () => {
    const h = harness();
    onFirst(h.client, "closed", () => void h.client.connect());
    void h.client.connect();
    h.ready();
    await h.client.close();
    expect(h.hub.sockets).toHaveLength(2);
    h.ready();
    expect(h.client.connectionState.status).toBe("ready");
  });

  it("close() then connect() from a ready listener leaves one live connection", async () => {
    const h = harness();
    onFirst(h.client, "ready", () => {
      void h.client.close();
      void h.client.connect();
    });
    void h.client.connect();
    h.ready(0);
    expect(h.hub.sockets).toHaveLength(2);
    expect(h.client.connectionState.status).toBe("connecting");
    h.ready(1);
    expect(h.client.connectionState.status).toBe("ready");
    const before = sentFrames(h.hub.sockets[0]!).length;
    await vi.advanceTimersByTimeAsync(HEARTBEAT * 2);
    // The first connection's heartbeat died with it.
    expect(sentFrames(h.hub.sockets[0]!)).toHaveLength(before);
    expect(sentFrames(h.hub.sockets[1]!).some((f) => f.k === "ping")).toBe(
      true,
    );
  });

  it("a re-ready listener's close() then connect() replays an outstanding enable once, with no onError", async () => {
    const h = harness();
    const errors: BridgeError[] = [];
    h.slots.onError = (err) => errors.push(err);
    void h.client.connect();
    h.ready();
    const enabled = h.client.enableCrossSessionLayoutChange();
    const call = sentFrames(h.hub.latest()).find((f) => f.k === "call")!;
    h.hub.latest().fire("message", {
      data: encodeServerFrame({
        k: "result",
        id: call.id!,
        ok: true,
        response: null,
      }),
    });
    await enabled;
    let readies = 0;
    h.client.on("connection-state", (ev) => {
      if (ev.state.status === "ready" && ++readies === 1) {
        void h.client.close();
        void h.client.connect();
      }
    });
    h.hub.fireClose();
    await vi.advanceTimersByTimeAsync(1);
    h.ready();
    await vi.advanceTimersByTimeAsync(0);
    h.ready();
    await vi.advanceTimersByTimeAsync(0);
    const replays = sentFrames(h.hub.latest()).filter(
      (f) =>
        f.k === "call" &&
        (f as { method?: string }).method === "enableCrossSessionLayoutChange",
    );
    expect(replays).toHaveLength(1);
    expect(errors).toEqual([]);
    // The refused replay of the closed connection wrote no lastError, so a
    // later clean drop reads as one.
    h.hub.fireClose(-1, 1000, "");
    expect(h.client.connectionState).toEqual({
      status: "reconnecting",
      attempt: 1,
    });
  });

  it("a socket that closes inside the welcome's replay ends that welcome: the next one replays the count once", async () => {
    const h = harness();
    const errors: BridgeError[] = [];
    h.slots.onError = (err) => errors.push(err);
    void h.client.connect();
    h.ready();
    const enableOnce = async () => {
      const enabled = h.client.enableCrossSessionLayoutChange();
      const call = sentFrames(h.hub.latest()).at(-1)!;
      h.hub.latest().fire("message", {
        data: encodeServerFrame({
          k: "result",
          id: call.id!,
          ok: true,
          response: null,
        }),
      });
      await enabled;
    };
    await enableOnce();
    await enableOnce();
    h.hub.fireClose();
    await vi.advanceTimersByTimeAsync(1);
    // The second connection dies on its first replayed enable, synchronously
    // inside send().
    const dying = h.hub.latest();
    const send = dying.send.bind(dying);
    dying.send = (data) => {
      send(data);
      if (typeof data === "string" && data.includes('"call"')) {
        h.hub.fireClose();
      }
    };
    h.ready();
    expect(h.client.connectionState.status).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(1);
    h.ready();
    await vi.advanceTimersByTimeAsync(0);
    const replays = sentFrames(h.hub.latest()).filter(
      (f) =>
        f.k === "call" &&
        (f as { method?: string }).method === "enableCrossSessionLayoutChange",
    );
    expect(replays).toHaveLength(2);
    expect(errors).toEqual([]);
  });

  it("a ready listener that throws leaves the connection fully up, and its error is reported", async () => {
    const reported: (() => void)[] = [];
    vi.stubGlobal("queueMicrotask", (fn: () => void) => reported.push(fn));
    const h = harness();
    const boom = new Error("listener broke");
    onFirst(h.client, "ready", () => {
      throw boom;
    });
    void h.client.connect();
    const queued = h.client.execute("list-windows");
    void queued.catch(() => undefined);
    h.hub.open();
    expect(() => h.hub.welcome(-1, HEARTBEAT)).not.toThrow();
    expect(h.client.connectionState.status).toBe("ready");
    // The outbox flushed: the call queued before welcome was transmitted.
    expect(sentFrames(h.hub.latest()).some((f) => f.k === "call")).toBe(true);
    // The heartbeat started.
    await vi.advanceTimersByTimeAsync(HEARTBEAT);
    expect(pings(h.hub)).toBeGreaterThan(0);
    expect(reported).toHaveLength(1);
    expect(() => reported[0]?.()).toThrow(boom);
  });
});

describe("WebSocketTmuxClient — a protocol fault before ready fails the handshake", () => {
  function started(opts: { reconnect?: boolean } = {}) {
    const errors: BridgeError[] = [];
    const { client, hub } = makeClient({
      ...opts,
      onError: (e) => errors.push(e),
    });
    void client.connect();
    const ws = hub.latest();
    const close = vi.spyOn(ws, "close");
    hub.open();
    return { client, hub, ws, close, errors };
  }

  const LIMITS = { requestTimeoutMs: 30_000, maxInflight: 16 };

  it.each([
    [
      "a negative heartbeatIntervalMs (a previous release's bridge)",
      { k: "welcome", limits: { ...LIMITS, heartbeatIntervalMs: -1 } },
      "welcome.limits.heartbeatIntervalMs",
    ],
    ["missing limits", { k: "welcome" }, "welcome.limits"],
  ])(
    "a welcome with %s closes the socket and leaves 'connecting'",
    (_, welcome, field) => {
      const { client, ws, close, errors } = started();
      ws.fire("message", { data: JSON.stringify(welcome) });

      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({ code: "BRIDGE_PROTOCOL_ERROR" });
      expect(errors[0]?.message).toContain(field);
      expect(close).toHaveBeenCalledWith(4002, expect.stringContaining(field));
      expect(ws.readyState).toBe(3);
      expect(client.connectionState).toEqual({
        status: "closed",
        reason: "transport-error",
      });
    },
  );

  it("a result for a queued call before welcome fails the handshake and does not settle the call", async () => {
    const { client, ws, close, errors } = started();
    const queued = client.execute("list-windows");
    // Nothing transmitted: the client sends calls only once ready.
    expect(sentFrames(ws).filter((f) => f.k === "call")).toEqual([]);
    const result: ResultFrame = {
      k: "result",
      id: "r1",
      ok: true,
      response: { commandNumber: 0, timestamp: 0, success: true, output: [] },
    };
    ws.fire("message", {
      data: encodeServerFrame(result satisfies ServerFrame),
    });

    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain("result frame before welcome");
    expect(close).toHaveBeenCalledWith(4002, expect.any(String));
    expect(client.connectionState).toEqual({
      status: "closed",
      reason: "transport-error",
    });
    await expect(queued).rejects.toMatchObject({ code: "BRIDGE_CLOSED" });
  });

  it.each([
    [
      "an event",
      encodeServerFrame({ k: "event", msg: { type: "sessions-changed" } }),
      "event frame before welcome",
    ],
    [
      "a pong",
      encodeServerFrame({ k: "pong", id: "p1" }),
      "pong frame before welcome",
    ],
    [
      "a drain notice",
      encodeServerFrame({ k: "draining", deadlineMs: 5_000 }),
      "draining frame before welcome",
    ],
    [
      "pane output",
      encodePaneOutput({ paneId: 1, data: new Uint8Array([104, 105]) }).buffer,
      "output frame before welcome",
    ],
  ])(
    "%s before welcome fails the handshake and reaches no listener",
    (_, data, message) => {
      const { client, ws, close, errors } = started();
      const heard: unknown[] = [];
      client.on("*", (ev) => heard.push(ev));
      ws.fire("message", { data });

      expect(errors).toHaveLength(1);
      expect(errors[0]?.message).toContain(message);
      expect(close).toHaveBeenCalledWith(4002, expect.any(String));
      expect(client.connectionState).toEqual({
        status: "closed",
        reason: "transport-error",
      });
      expect(
        heard.filter(
          (ev) => (ev as { type: string }).type !== "connection-state",
        ),
      ).toEqual([]);
    },
  );

  it("a fatal error before welcome is reported, and the server's close ends the connection", () => {
    const { client, hub, ws, close, errors } = started();
    ws.fire("message", {
      data: encodeServerFrame({
        k: "error",
        fatal: true,
        error: { code: "BRIDGE_AUTH_DENIED", message: "denied" },
      }),
    });

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: "BRIDGE_AUTH_DENIED" });
    expect(close).not.toHaveBeenCalled();
    hub.fireClose(-1, 4001, "denied");
    expect(client.connectionState).toEqual({
      status: "closed",
      reason: "transport-error",
    });
  });

  it("under a reconnect policy the failed handshake reads reconnecting, with the protocol error as lastError", async () => {
    const { client, ws, errors } = started({ reconnect: true });
    ws.fire("message", { data: JSON.stringify({ k: "welcome" }) });

    expect(client.connectionState).toMatchObject({
      status: "reconnecting",
      attempt: 1,
      lastError: errors[0],
    });
    expect(errors[0]).toMatchObject({ code: "BRIDGE_PROTOCOL_ERROR" });
    await client.close();
  });

  it("a malformed frame once ready is reported and the connection stays up", () => {
    const { client, hub, ws, close, errors } = started();
    hub.welcome();
    ws.fire("message", { data: "{not json" });

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: "BRIDGE_PROTOCOL_ERROR" });
    expect(close).not.toHaveBeenCalled();
    expect(client.connectionState.status).toBe("ready");
  });

  it("a socket closing after a failed handshake delivers nothing more, so the fault stays the cause", async () => {
    const { client, ws, errors } = started({ reconnect: true });
    // ws's close handshake: close() moves to CLOSING, and the close event
    // waits for the peer's close frame. Frames keep arriving meanwhile.
    ws.close = () => {
      ws.readyState = 2;
    };
    ws.fire("message", { data: JSON.stringify({ k: "welcome" }) });
    ws.fire("message", {
      data: encodeServerFrame({
        k: "event",
        msg: { type: "sessions-changed" },
      }),
    });
    ws.fire("message", {
      data: JSON.stringify({
        k: "welcome",
        limits: { ...LIMITS, heartbeatIntervalMs: 1_000 },
      }),
    });

    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain("welcome.limits");
    expect(client.connectionState.status).toBe("connecting");

    ws.readyState = 3;
    ws.fire("close", { code: 4002, reason: "" });
    expect(client.connectionState).toMatchObject({
      status: "reconnecting",
      lastError: errors[0],
    });
    await client.close();
  });

  it("a second welcome once ready is reported and does not re-run the handshake", () => {
    const { client, hub, ws, close, errors } = started();
    hub.welcome();
    const sentBefore = ws.sent.length;
    hub.welcome();

    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain("welcome frame after welcome");
    // No replayed enables, flushed calls or router bootstrap went out.
    expect(ws.sent).toHaveLength(sentBefore);
    expect(close).not.toHaveBeenCalled();
    expect(client.connectionState.status).toBe("ready");
  });

  it("a createWebSocket that throws is reported and reads transport-error", () => {
    const errors: BridgeError[] = [];
    const client = new WebSocketTmuxClient({
      url: "ws://test/",
      autoConnect: false,
      createWebSocket: () => {
        throw new Error("no sockets here");
      },
      onError: (e) => errors.push(e),
    });
    void client.connect();

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: "BRIDGE_INTERNAL" });
    expect(errors[0]?.message).toContain("no sockets here");
    expect(client.connectionState).toEqual({
      status: "closed",
      reason: "transport-error",
    });
  });
});
