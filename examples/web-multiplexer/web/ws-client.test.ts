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

class FakeWebSocketCtor extends FakeSocket {
  constructor(url: string) {
    super(url);
    lastSocket = this;
  }
}

beforeEach(() => {
  lastSocket = undefined;
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
});
