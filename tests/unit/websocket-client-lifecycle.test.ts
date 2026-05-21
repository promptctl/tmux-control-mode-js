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

import { describe, expect, it } from "vitest";

import { WebSocketTmuxClient } from "../../src/connectors/websocket/client.js";
import type { BrowserWebSocketLike } from "../../src/connectors/websocket/types.js";
import {
  encodeServerFrame,
  type ResultFrame,
  type ServerFrame,
  type WelcomeFrame,
} from "../../src/connectors/websocket/protocol.js";

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
  // Match the real DOM signature: when options.signal aborts, the
  // listener is atomically removed from the EventTarget's registry.
  // A mock that ignored `signal` would silently leak the staleness
  // bug back in — defeating the whole point of binding listener
  // lifetime to connection lifetime.
  addEventListener(
    event: string,
    listener: Listener,
    options?: { signal?: AbortSignal },
  ): void;
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
      addEventListener(event, listener, options) {
        let set = listeners.get(event);
        if (!set) {
          set = new Set();
          listeners.set(event, set);
        }
        set.add(listener);
        // Honor the AbortSignal option exactly as the real DOM does:
        // on abort, remove this listener from the registry.
        if (options?.signal !== undefined) {
          const signal = options.signal;
          if (signal.aborted) {
            set.delete(listener);
            return;
          }
          signal.addEventListener(
            "abort",
            () => {
              listeners.get(event)?.delete(listener);
            },
            { once: true },
          );
        }
      },
      removeEventListener(event, listener) {
        listeners.get(event)?.delete(listener);
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

  welcome(idx = -1): void {
    const ws = idx === -1 ? this.latest() : this.sockets[idx];
    if (!ws) return;
    const welcome: WelcomeFrame = {
      k: "welcome",
      limits: {
        requestTimeoutMs: 30_000,
        heartbeatIntervalMs: 0, // disable heartbeat in tests
        maxInflight: 16,
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

function makeClient(opts: { reconnect?: boolean } = {}): {
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
function sentFrames(ws: MockWS): Array<{ k: string; id?: string }> {
  const out: Array<{ k: string; id?: string }> = [];
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
      expect(client.state).toBe("closed");
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

      // Open the socket but DO NOT send welcome yet. State transitions
      // to "open" via onOpen; hello is sent via rawSend (immediate). The
      // server in this state is pending-hello and would reject any
      // non-hello frame with a protocol error.
      hub.open();
      await new Promise((r) => setImmediate(r));
      expect(client.state).toBe("open");

      // Sanity: hello is on the wire, nothing else.
      const beforeCall = sentFrames(hub.latest()).filter(
        (f) => f.k !== "hello",
      );
      expect(beforeCall).toEqual([]);

      // Fire a call while in "open" (pre-welcome).
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
      expect(client.state).toBe("closed");

      // Now simulate the orphaned socket completing its handshake AFTER
      // close(): open arrives first, then welcome. The AbortController
      // bound to the connection was aborted in finalizeConnection, so
      // the DOM/`ws`-library removed every listener atomically. The
      // mock honors `{ signal }` the same way — these `fire` calls find
      // an empty listener set and invoke nothing.
      hub.open();
      hub.welcome();
      await new Promise((r) => setImmediate(r));

      // State stayed closed; no resurrection.
      expect(client.state).toBe("closed");
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
