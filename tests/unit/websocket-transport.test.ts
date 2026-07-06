// tests/unit/websocket-transport.test.ts
// Behavior-level tests for the thin WebSocket TmuxTransport adapter.
// Uses an in-memory fake satisfying BrowserWebSocketLike — no `ws` dep,
// no real socket. The fake's only job is to invert the event direction so
// the test can drive what would normally arrive from a relay.

import { websocketTransport } from "../../src/connectors/websocket/transport.js";
import {
  parseServerFrame,
  BridgeProtocolError,
} from "../../src/connectors/websocket/protocol.js";
import type { BrowserWebSocketLike } from "../../src/connectors/websocket/types.js";

// Event shapes per addEventListener overload, mirroring BrowserWebSocketLike.
// The generic implementation signature keys the listener type to the event
// name, so storage and dispatch stay cast-free.
interface FakeWebSocketEvents {
  open: (event: unknown) => void;
  error: (event: unknown) => void;
  message: (event: { data: unknown }) => void;
  close: (event: { code?: number; reason?: string }) => void;
}

class FakeWebSocket implements BrowserWebSocketLike {
  readyState = 1;
  binaryType: "blob" | "arraybuffer" = "blob";
  readonly sent: string[] = [];
  closed = false;
  private readonly listeners: {
    [K in keyof FakeWebSocketEvents]: FakeWebSocketEvents[K][];
  } = { open: [], error: [], message: [], close: [] };

  send(data: string | ArrayBufferLike | ArrayBufferView | Blob): void {
    // The transport only ever sends strings. Tests assert that.
    this.sent.push(data as string);
  }
  close(): void {
    this.closed = true;
  }
  addEventListener(
    type: "open" | "error",
    listener: (event: unknown) => void,
    options?: { signal?: AbortSignal },
  ): void;
  addEventListener(
    type: "message",
    listener: (event: { data: unknown }) => void,
    options?: { signal?: AbortSignal },
  ): void;
  addEventListener(
    type: "close",
    listener: (event: { code?: number; reason?: string }) => void,
    options?: { signal?: AbortSignal },
  ): void;
  addEventListener<K extends keyof FakeWebSocketEvents>(
    type: K,
    listener: FakeWebSocketEvents[K],
  ): void {
    this.listeners[type].push(listener);
  }
  emitMessage(data: unknown): void {
    this.listeners.message.forEach((l) => l({ data }));
  }
  emitClose(code?: number, reason?: string): void {
    this.listeners.close.forEach((l) => l({ code, reason }));
  }
  emitError(): void {
    this.listeners.error.forEach((l) => l({}));
  }
}

function createFake(): FakeWebSocket {
  return new FakeWebSocket();
}

describe("websocketTransport", () => {
  it("sets binaryType to 'arraybuffer' on construction", () => {
    const ws = createFake();
    websocketTransport(ws);
    expect(ws.binaryType).toBe("arraybuffer");
  });

  it("LF-terminates outbound commands", () => {
    const ws = createFake();
    const t = websocketTransport(ws);
    t.send("list-sessions");
    expect(ws.sent).toEqual(["list-sessions\n"]);
  });

  it("does not double-LF an already-terminated command", () => {
    const ws = createFake();
    const t = websocketTransport(ws);
    t.send("kill-server\n");
    expect(ws.sent).toEqual(["kill-server\n"]);
  });

  it("send on an open socket reports acceptance", () => {
    const ws = createFake();
    const t = websocketTransport(ws);
    expect(t.send("list-sessions")).toEqual({ ok: true });
  });

  it("send while the socket is not open refuses instead of throwing", () => {
    const ws = createFake();
    ws.readyState = 0; // CONNECTING — a real ws.send here throws InvalidStateError
    const t = websocketTransport(ws);
    expect(t.send("list-sessions")).toEqual({
      ok: false,
      reason: "websocket not open (readyState 0)",
    });
    expect(ws.sent).toEqual([]);
  });

  it("send after the close event refuses with the close reason", () => {
    const ws = createFake();
    const t = websocketTransport(ws);
    ws.emitClose(1006, "abnormal");
    expect(t.send("list-sessions")).toEqual({
      ok: false,
      reason: "transport closed: abnormal",
    });
    expect(ws.sent).toEqual([]);
  });

  it("a synchronous throw from the socket's send becomes a typed refusal", () => {
    const ws = createFake();
    ws.send = () => {
      throw new Error("clone failure");
    };
    const t = websocketTransport(ws);
    expect(t.send("list-sessions")).toEqual({
      ok: false,
      reason: "websocket send failed: clone failure",
    });
  });

  it("forwards string message frames verbatim to onData callbacks", () => {
    const ws = createFake();
    const t = websocketTransport(ws);
    const chunks: string[] = [];
    t.onData((c) => chunks.push(c));
    ws.emitMessage("%begin 1 2 1\n");
    ws.emitMessage("%output %1 hello\n");
    expect(chunks).toEqual(["%begin 1 2 1\n", "%output %1 hello\n"]);
  });

  it("decodes ArrayBuffer message frames byte-faithfully", () => {
    const ws = createFake();
    const t = websocketTransport(ws);
    const chunks: string[] = [];
    t.onData((c) => chunks.push(c));
    // Include 0x80–0x9F (windows-1252 landmine range): TextDecoder("latin1")
    // remaps those bytes; bytesToLatin1 must preserve them 1:1.
    const bytes = new Uint8Array([0x25, 0x6f, 0x75, 0x74, 0x80, 0x9f, 0x0a]);
    ws.emitMessage(bytes.buffer);
    expect(chunks).toEqual(["%out\x80\x9f\n"]);
  });

  it("decodes typed-array message frames byte-faithfully", () => {
    const ws = createFake();
    const t = websocketTransport(ws);
    const chunks: string[] = [];
    t.onData((c) => chunks.push(c));
    const bytes = new TextEncoder().encode("%session-changed $0 main\n");
    ws.emitMessage(bytes); // Uint8Array, not the underlying ArrayBuffer
    expect(chunks).toEqual(["%session-changed $0 main\n"]);
  });

  it("dispatches to every registered onData listener (multi-subscribe)", () => {
    const ws = createFake();
    const t = websocketTransport(ws);
    const a: string[] = [];
    const b: string[] = [];
    t.onData((c) => a.push(c));
    t.onData((c) => b.push(c));
    ws.emitMessage("data\n");
    expect(a).toEqual(["data\n"]);
    expect(b).toEqual(["data\n"]);
  });

  it("close event dispatches reason to every onClose listener", () => {
    const ws = createFake();
    const t = websocketTransport(ws);
    const reasons: (string | undefined)[] = [];
    t.onClose((r) => reasons.push(r));
    t.onClose((r) => reasons.push(r));
    ws.emitClose(1006, "abnormal closure");
    expect(reasons).toEqual(["abnormal closure", "abnormal closure"]);
  });

  it("a normal closure (1000, no reason) yields undefined — a clean exit, not a transport error", () => {
    const ws = createFake();
    const t = websocketTransport(ws);
    let captured: string | undefined = "unset";
    t.onClose((r) => {
      captured = r;
    });
    ws.emitClose(1000, "");
    expect(captured).toBeUndefined();
    // The post-close refusal likewise reads as a plain clean close.
    expect(t.send("x")).toEqual({ ok: false, reason: "transport closed" });
  });

  it("close event with no reason but a code surfaces the code", () => {
    const ws = createFake();
    const t = websocketTransport(ws);
    let captured: string | undefined = "unset";
    t.onClose((r) => {
      captured = r;
    });
    ws.emitClose(1001);
    expect(captured).toBe("code 1001");
  });

  it("close event with no code and no reason yields undefined", () => {
    const ws = createFake();
    const t = websocketTransport(ws);
    let called = false;
    let captured: string | undefined = "unset";
    t.onClose((r) => {
      called = true;
      captured = r;
    });
    ws.emitClose();
    expect(called).toBe(true);
    expect(captured).toBeUndefined();
  });

  it("error event dispatches a generic reason via onClose", () => {
    const ws = createFake();
    const t = websocketTransport(ws);
    const reasons: (string | undefined)[] = [];
    t.onClose((r) => reasons.push(r));
    ws.emitError();
    expect(reasons).toEqual(["websocket error"]);
  });

  it("error followed by close dispatches one onClose notification", () => {
    const ws = createFake();
    const t = websocketTransport(ws);
    const reasons: (string | undefined)[] = [];
    t.onClose((r) => reasons.push(r));
    ws.emitError();
    ws.emitClose(1006, "abnormal closure");
    expect(reasons).toEqual(["websocket error"]);
  });

  it("close() closes the underlying socket", () => {
    const ws = createFake();
    const t = websocketTransport(ws);
    expect(ws.closed).toBe(false);
    t.close();
    expect(ws.closed).toBe(true);
  });

  it("ignores unknown message data shapes (e.g. null) by emitting empty string", () => {
    // Defensive at a real trust boundary: a misbehaving relay sending null
    // shouldn't crash the transport. Empty chunk is a no-op for the parser.
    const ws = createFake();
    const t = websocketTransport(ws);
    const chunks: string[] = [];
    t.onData((c) => chunks.push(c));
    ws.emitMessage(null);
    expect(chunks).toEqual([""]);
  });
});

// ---------------------------------------------------------------------------
// parseServerFrame — event type discriminator validation
// ---------------------------------------------------------------------------

describe("parseServerFrame — event type validation", () => {
  const welcomeFrame = JSON.stringify({
    k: "welcome",
    limits: { requestTimeoutMs: 5000, heartbeatIntervalMs: 30000, maxInflight: 4 },
  });

  it("accepts a valid event frame with known type", () => {
    const frame = parseServerFrame(
      JSON.stringify({ k: "event", msg: { type: "layout-change" } }),
    );
    expect(frame.k).toBe("event");
  });

  it("rejects event frame with unknown msg.type", () => {
    const fn = (): unknown =>
      parseServerFrame(
        JSON.stringify({ k: "event", msg: { type: "bogus" } }),
      );
    expect(fn).toThrow(BridgeProtocolError);
    expect(fn).toThrow(/known TmuxMessage discriminator/);
  });

  it("rejects event frame with non-string msg.type", () => {
    const fn = (): unknown =>
      parseServerFrame(
        JSON.stringify({ k: "event", msg: { type: 42 } }),
      );
    expect(fn).toThrow(BridgeProtocolError);
    expect(fn).toThrow(/known TmuxMessage discriminator/);
  });

  it("rejects event frame with missing msg.type", () => {
    const fn = (): unknown =>
      parseServerFrame(JSON.stringify({ k: "event", msg: {} }));
    expect(fn).toThrow(BridgeProtocolError);
    expect(fn).toThrow(/known TmuxMessage discriminator/);
  });

  it("still parses non-event frames (welcome) without change", () => {
    const frame = parseServerFrame(welcomeFrame);
    expect(frame.k).toBe("welcome");
  });
});
