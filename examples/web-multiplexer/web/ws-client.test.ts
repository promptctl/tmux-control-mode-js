// examples/web-multiplexer/web/ws-client.test.ts
//
// tmux-lifecycle-zng.6: WebSocketBridge is the showcase's hand-rolled
// WebSocket implementation of TmuxBridge. It used to have the same hang
// defect the core TmuxClient had before tmux-lifecycle-zng.2 — a socket
// close or disconnect() would drop every in-flight `pending` entry without
// ever settling its promise, so a consumer awaiting execute()/sendKeys()
// hung forever. These tests assert the fix: every pending call is rejected
// with a typed BridgeError, not left unsettled.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { BridgeError } from "@promptctl/tmux-control-mode-js/websocket/protocol";
import { WebSocketBridge } from "./ws-client.ts";

type Listener = (event?: { data?: unknown }) => void;

/** A `WebSocket`-shaped double the test drives by hand: no real socket, no
 *  real async I/O — `fireOpen`/`fireClose` synchronously invoke whatever
 *  `WebSocketBridge.connect()` registered. */
class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState: number = FakeSocket.CONNECTING;
  binaryType: "blob" | "arraybuffer" = "blob";
  readonly sent: string[] = [];
  private readonly listeners: Record<string, Listener[]> = {
    open: [],
    close: [],
    error: [],
    message: [],
  };

  constructor(readonly url: string) {}

  addEventListener(type: string, listener: Listener): void {
    this.listeners[type].push(listener);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = FakeSocket.CLOSED;
  }

  fireOpen(): void {
    this.readyState = FakeSocket.OPEN;
    this.listeners.open.forEach((l) => l());
  }

  fireClose(): void {
    this.readyState = FakeSocket.CLOSED;
    this.listeners.close.forEach((l) => l());
  }

  fireMessage(data: string): void {
    this.listeners.message.forEach((l) => l({ data }));
  }
}

let lastSocket: FakeSocket | undefined;
let socketsCreated = 0;

class FakeWebSocketCtor extends FakeSocket {
  constructor(url: string) {
    super(url);
    lastSocket = this;
    socketsCreated += 1;
  }
}

beforeEach(() => {
  lastSocket = undefined;
  socketsCreated = 0;
  vi.stubGlobal("WebSocket", FakeWebSocketCtor);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function connectedBridge(): { bridge: WebSocketBridge; socket: FakeSocket } {
  const bridge = new WebSocketBridge();
  bridge.connect("ws://test");
  const socket = lastSocket;
  if (socket === undefined) throw new Error("expected a socket to be created");
  socket.fireOpen();
  return { bridge, socket };
}

describe("WebSocketBridge — pending settlement on close", () => {
  it("rejects an in-flight execute() with a typed BridgeError when the socket closes mid-flight, not a hang", async () => {
    const { bridge, socket } = connectedBridge();

    const p = bridge.execute("list-sessions");
    // The drain reaction fires synchronously on state change (fireImmediately),
    // so the request has already reached the fake wire.
    expect(socket.sent).toHaveLength(1);

    socket.fireClose();

    await expect(p).rejects.toBeInstanceOf(BridgeError);
    await expect(p).rejects.toMatchObject({ code: "BRIDGE_CLOSED" });
  });

  it("settles an in-flight sendKeys() the same way", async () => {
    const { bridge, socket } = connectedBridge();

    const p = bridge.sendKeys("%1", "echo hi");
    socket.fireClose();

    await expect(p).rejects.toBeInstanceOf(BridgeError);
  });

  it("disconnect() during an in-flight call rejects it rather than leaving it pending", async () => {
    const { bridge } = connectedBridge();

    const p = bridge.execute("list-sessions");
    bridge.disconnect();

    await expect(p).rejects.toBeInstanceOf(BridgeError);
    await expect(p).rejects.toMatchObject({ code: "BRIDGE_CLOSED" });
  });

  it("rejects every pending entry, not just the first, on close", async () => {
    const { bridge, socket } = connectedBridge();

    const p1 = bridge.execute("list-sessions");
    const p2 = bridge.execute("list-windows");
    const p3 = bridge.sendKeys("%1", "ls");
    socket.fireClose();

    await expect(p1).rejects.toBeInstanceOf(BridgeError);
    await expect(p2).rejects.toBeInstanceOf(BridgeError);
    await expect(p3).rejects.toBeInstanceOf(BridgeError);
  });

  it("disconnect() with no in-flight calls is a safe no-op", () => {
    const { bridge } = connectedBridge();
    expect(() => {
      bridge.disconnect();
    }).not.toThrow();
  });

  it("rejects a pending call when the server sends a correlated ErrorFrame (a bridge-dispatch failure, distinct from a tmux %error), not a hang", async () => {
    const { bridge, socket } = connectedBridge();

    const p = bridge.execute("list-sessions");
    const sentRequest = JSON.parse(socket.sent[0]) as { id: string };
    socket.fireMessage(
      JSON.stringify({
        kind: "error",
        id: sentRequest.id,
        message: "dispatch failed",
      }),
    );

    await expect(p).rejects.toBeInstanceOf(BridgeError);
    await expect(p).rejects.toMatchObject({ code: "BRIDGE_INTERNAL" });
  });

  it("disconnect() clears the outbox so a message queued but never drained isn't sent stale on the next connect()", () => {
    const bridge = new WebSocketBridge();
    bridge.connect("ws://test");
    const firstSocket = lastSocket;
    if (firstSocket === undefined) throw new Error("expected a socket");
    // Never opened, so the drain reaction never fires — this message sits in
    // the outbox untouched.
    void bridge.execute("list-sessions").catch(() => {});
    expect(firstSocket.sent).toHaveLength(0);

    bridge.disconnect();

    bridge.connect("ws://test");
    const secondSocket = lastSocket;
    if (secondSocket === undefined || secondSocket === firstSocket) {
      throw new Error("expected a fresh socket");
    }
    secondSocket.fireOpen();

    expect(secondSocket.sent).toHaveLength(0);
  });

  it("settles a new execute() issued synchronously from an onState('closed') reaction during disconnect(), instead of leaving it to hang", async () => {
    const { bridge } = connectedBridge();

    let reacted: Promise<unknown> | undefined;
    bridge.onState((s) => {
      if (s === "closed" && reacted === undefined) {
        reacted = bridge.execute("list-sessions");
      }
    });

    bridge.disconnect();

    expect(reacted).toBeDefined();
    await expect(reacted).rejects.toBeInstanceOf(BridgeError);
  });

  it("rejects immediately (not a hang) when execute()/sendKeys() is called after disconnect() has already completed", async () => {
    const { bridge } = connectedBridge();
    bridge.disconnect();

    const p1 = bridge.execute("list-sessions");
    const p2 = bridge.sendKeys("%1", "ls");

    await expect(p1).rejects.toBeInstanceOf(BridgeError);
    await expect(p1).rejects.toMatchObject({ code: "BRIDGE_CLOSED" });
    await expect(p2).rejects.toBeInstanceOf(BridgeError);
  });

  it("does not sweep a fresh connection's pending/outbox when an onState('closed') reaction reconnects synchronously (tmux-ws-lifecycle-2vk)", async () => {
    const { bridge, socket: firstSocket } = connectedBridge();

    let reconnected:
      | { promise: Promise<unknown>; socket: FakeSocket }
      | undefined;
    bridge.onState((s) => {
      if (s === "closed" && reconnected === undefined) {
        bridge.connect("ws://test");
        const socket = lastSocket;
        if (socket === undefined || socket === firstSocket) {
          throw new Error(
            "expected a fresh socket from the synchronous reconnect",
          );
        }
        reconnected = { promise: bridge.execute("list-sessions"), socket };
      }
    });

    // The old connection's close teardown is still unwinding when the
    // reaction above reconnects and sends — that reconnect's message must
    // not be swept as if it belonged to the connection that just closed.
    firstSocket.fireClose();

    if (reconnected === undefined) {
      throw new Error("onState('closed') handler did not run");
    }
    expect(reconnected.socket.sent).toHaveLength(0);

    reconnected.socket.fireOpen();
    expect(reconnected.socket.sent).toHaveLength(1);

    const sentRequest = JSON.parse(reconnected.socket.sent[0]) as {
      id: string;
    };
    reconnected.socket.fireMessage(
      JSON.stringify({
        kind: "response",
        id: sentRequest.id,
        response: {
          commandNumber: 1,
          timestamp: Date.now(),
          output: [],
          success: true,
        },
      }),
    );

    await expect(reconnected.promise).resolves.toMatchObject({
      success: true,
    });
  });

  it("rejects a prior generation's in-flight call instead of orphaning it when connect() is called while the old socket is still CLOSING", async () => {
    const { bridge, socket: firstSocket } = connectedBridge();

    const p = bridge.execute("list-sessions");
    // The old socket has entered CLOSING (e.g. a server-initiated close)
    // but its `close` event hasn't fired yet -- readyState alone, no
    // fireClose(). connect()'s single-connection guard only excludes
    // OPEN/CONNECTING, so a reconnect must proceed here without ever
    // getting a chance to run the old socket's own close-listener sweep.
    firstSocket.readyState = FakeSocket.CLOSING;

    bridge.connect("ws://test");
    const secondSocket = lastSocket;
    if (secondSocket === undefined || secondSocket === firstSocket) {
      throw new Error("expected a fresh socket from the reconnect");
    }

    await expect(p).rejects.toBeInstanceOf(BridgeError);
    await expect(p).rejects.toMatchObject({ code: "BRIDGE_CLOSED" });
  });

  it("doesn't create an orphaned second socket when an onError handler reconnects synchronously from inside the pre-reconnect sweep", async () => {
    const bridge = new WebSocketBridge();
    bridge.connect("ws://test");
    const firstSocket = lastSocket;
    if (firstSocket === undefined) throw new Error("expected a socket");
    firstSocket.fireOpen();

    // Undrained (readyState no longer OPEN) so sweepGeneration's pre-reconnect
    // sweep below finds it and emits an error -- the trigger for the
    // reentrant connect() this test drives.
    firstSocket.readyState = FakeSocket.CLOSING;
    const stale = bridge.execute("stale-command");
    stale.catch(() => {});

    let reconnectTriggered = false;
    bridge.onError((message) => {
      if (message.includes("undelivered") && !reconnectTriggered) {
        reconnectTriggered = true;
        // A reentrant call from inside the sweep this same connect() is
        // running -- must be a no-op, not a second socket racing the
        // outer call's socket assignment.
        bridge.connect("ws://test");
      }
    });

    bridge.connect("ws://test");

    expect(reconnectTriggered).toBe(true);
    expect(socketsCreated).toBe(2);
    await expect(stale).rejects.toBeInstanceOf(BridgeError);
  });

  it("settles the outbox and pending map before notifying error handlers, so a throwing errorHandler can't abort cleanup (sweepGeneration)", async () => {
    const { bridge, socket: firstSocket } = connectedBridge();

    // Undrained, so sweepGeneration's outbox cleanup has something to do
    // and emits an error -- the trigger for the throwing handler below.
    firstSocket.readyState = FakeSocket.CLOSING;
    const stale = bridge.execute("stale-command");
    stale.catch(() => {});

    bridge.onError(() => {
      throw new Error("boom from a misbehaving error handler");
    });

    expect(() => bridge.disconnect()).toThrow(
      "boom from a misbehaving error handler",
    );

    // Despite the handler throwing, cleanup must have already happened --
    // it runs before the (risky, caller-code-invoking) notification, not
    // after.
    expect(bridge.outbox).toHaveLength(0);
    await expect(stale).rejects.toBeInstanceOf(BridgeError);
  });
});
