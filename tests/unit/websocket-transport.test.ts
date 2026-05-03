// tests/unit/websocket-transport.test.ts
// Behavior-level tests for the thin WebSocket TmuxTransport adapter.
// Uses an in-memory fake satisfying BrowserWebSocketLike — no `ws` dep,
// no real socket. The fake's only job is to invert the event direction so
// the test can drive what would normally arrive from a relay.

import { websocketTransport } from "../../src/connectors/websocket/transport.js";
import type { BrowserWebSocketLike } from "../../src/connectors/websocket/types.js";

type Listener = (event: unknown) => void;

interface FakeWebSocket extends BrowserWebSocketLike {
  readonly sent: string[];
  emitMessage(data: unknown): void;
  emitClose(code?: number, reason?: string): void;
  emitError(): void;
  closed: boolean;
}

function createFake(): FakeWebSocket {
  const listeners: Record<string, Listener[]> = {
    message: [],
    close: [],
    error: [],
    open: [],
  };
  const sent: string[] = [];
  const fake: FakeWebSocket = {
    readyState: 1,
    binaryType: "blob",
    sent,
    closed: false,
    send(data: string | ArrayBufferLike | ArrayBufferView | Blob): void {
      // The transport only ever sends strings. Tests assert that.
      sent.push(data as string);
    },
    close(): void {
      fake.closed = true;
    },
    addEventListener(type: string, listener: Listener): void {
      (listeners[type] ?? []).push(listener);
    },
    emitMessage(data: unknown): void {
      listeners.message.forEach((l) => l({ data }));
    },
    emitClose(code?: number, reason?: string): void {
      listeners.close.forEach((l) => l({ code, reason }));
    },
    emitError(): void {
      listeners.error.forEach((l) => l({}));
    },
  };
  return fake;
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

  it("forwards string message frames verbatim to onData callbacks", () => {
    const ws = createFake();
    const t = websocketTransport(ws);
    const chunks: string[] = [];
    t.onData((c) => chunks.push(c));
    ws.emitMessage("%begin 1 2 1\n");
    ws.emitMessage("%output %1 hello\n");
    expect(chunks).toEqual(["%begin 1 2 1\n", "%output %1 hello\n"]);
  });

  it("decodes ArrayBuffer message frames as UTF-8", () => {
    const ws = createFake();
    const t = websocketTransport(ws);
    const chunks: string[] = [];
    t.onData((c) => chunks.push(c));
    const bytes = new TextEncoder().encode("%output %1 hé\n");
    ws.emitMessage(bytes.buffer);
    expect(chunks).toEqual(["%output %1 hé\n"]);
  });

  it("decodes typed-array message frames as UTF-8", () => {
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
