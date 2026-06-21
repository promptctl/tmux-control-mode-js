// tests/unit/websocket-sink.test.ts
// Behavior-level tests for `WebSocketSink` and `attachWebSocketSink`.
//
// What the contract promises:
//   - `WebSocketSink.write(msg)` encodes and sends exactly one binary frame
//     per call when ws.readyState === OPEN. The decoded frame's paneId and
//     data match the source chunk.
//   - `write` is a no-op when readyState is CLOSING or CLOSED.
//   - `write` catches ws.send() throws (TOCTOU race on socket teardown).
//   - `WebSocketSink.end()` is a no-op (no wire-level pane-end frame exists).
//   - `attachWebSocketSink(client, ws, options?)` is equivalent to
//     `client.attachBytesSink(new WebSocketSink(ws), options)` — it routes
//     chunks admitted by `options.scope` to the sink.
//   - Default scope is serverScope (all panes on the server).
//   - Narrowed scope (paneScope, sessionScope) filters correctly.
//   - The returned disposer stops forwarding and is idempotent.
//   - Multiple independent attachments (different scopes or separate calls)
//     on the same ws coexist without interference. There is NO exclusivity
//     registry — two attachments with the same scope are valid.
//
// [LAW:behavior-not-structure] Assertions target the wire contract (frame
//   format, lifecycle, scope filtering, disposer idempotence), not the
//   closure-internal structure of WebSocketSink. A re-implementation that
//   satisfies the contract passes these tests unchanged.

import { describe, expect, it } from "vitest";

import { TmuxClient } from "../../src/client.js";
import {
  decodePaneOutput,
  type WebSocketSinkTarget,
} from "../../src/connectors/websocket/index.js";
import {
  WebSocketSink,
  attachWebSocketSink,
} from "../../src/connectors/websocket/sink.js";
import {
  WEBSOCKET_CLOSED,
  WEBSOCKET_CLOSING,
  WEBSOCKET_OPEN,
} from "../../src/connectors/websocket/types.js";
import { paneScope } from "../../src/pane-output.js";
import type { TmuxTransport } from "../../src/transport/types.js";

// ---------------------------------------------------------------------------
// Test rigging
// ---------------------------------------------------------------------------

interface FakeTransport {
  readonly transport: TmuxTransport;
  feed(chunk: string): void;
}

function createFakeTransport(): FakeTransport {
  let dataCb: ((chunk: string) => void) | null = null;
  const transport: TmuxTransport = {
    send() {},
    onData(cb) {
      dataCb = cb;
    },
    onClose() {},
    close() {},
  };
  return {
    transport,
    feed(chunk) {
      dataCb?.(chunk);
    },
  };
}

interface FakeWebSocket {
  readonly ws: WebSocketSinkTarget;
  readonly sends: Uint8Array[];
  setReadyState(state: number): void;
  throwOnNextSend(err?: Error): void;
}

function createFakeWebSocket(): FakeWebSocket {
  const sends: Uint8Array[] = [];
  const state = {
    readyState: WEBSOCKET_OPEN as number,
    throwNext: null as Error | null,
  };
  const ws: WebSocketSinkTarget = {
    get readyState() {
      return state.readyState;
    },
    send(data) {
      if (state.throwNext !== null) {
        const err = state.throwNext;
        state.throwNext = null;
        throw err;
      }
      const buf =
        data instanceof Uint8Array
          ? new Uint8Array(data)
          : new Uint8Array(
              data instanceof ArrayBuffer
                ? data
                : (data as ArrayBufferView).buffer.slice(
                    (data as ArrayBufferView).byteOffset,
                    (data as ArrayBufferView).byteOffset +
                      (data as ArrayBufferView).byteLength,
                  ),
            );
      sends.push(buf);
    },
  };
  return {
    ws,
    sends,
    setReadyState(s) {
      state.readyState = s;
    },
    throwOnNextSend(err = new Error("simulated torn-down socket")) {
      state.throwNext = err;
    },
  };
}

function octEscape(bytes: readonly number[]): string {
  return bytes.map((b) => "\\" + b.toString(8).padStart(3, "0")).join("");
}

// ---------------------------------------------------------------------------
// WebSocketSink — class-level contract
// ---------------------------------------------------------------------------

describe("WebSocketSink", () => {
  it("write encodes the chunk and sends one binary frame", () => {
    const fake = createFakeWebSocket();
    const sink = new WebSocketSink(fake.ws);
    const data = new Uint8Array([0x00, 0x7f, 0x80, 0xc3, 0xa9, 0xff]);
    sink.write({ paneId: 42, data });

    expect(fake.sends).toHaveLength(1);
    const decoded = decodePaneOutput(fake.sends[0]);
    expect(decoded.type).toBe("output");
    expect(decoded.paneId).toBe(42);
    expect(Array.from(decoded.data)).toEqual([0x00, 0x7f, 0x80, 0xc3, 0xa9, 0xff]);
  });

  it("write is a no-op when readyState is CLOSING", () => {
    const fake = createFakeWebSocket();
    const sink = new WebSocketSink(fake.ws);
    fake.setReadyState(WEBSOCKET_CLOSING);
    sink.write({ paneId: 1, data: new Uint8Array([0xaa]) });
    expect(fake.sends).toHaveLength(0);
  });

  it("write is a no-op when readyState is CLOSED", () => {
    const fake = createFakeWebSocket();
    const sink = new WebSocketSink(fake.ws);
    fake.setReadyState(WEBSOCKET_CLOSED);
    sink.write({ paneId: 1, data: new Uint8Array([0xbb]) });
    expect(fake.sends).toHaveLength(0);
  });

  it("write swallows ws.send() throws (TOCTOU race on socket teardown)", () => {
    const fake = createFakeWebSocket();
    const sink = new WebSocketSink(fake.ws);
    fake.throwOnNextSend();
    expect(() => sink.write({ paneId: 1, data: new Uint8Array([0xcc]) })).not.toThrow();
    expect(fake.sends).toHaveLength(0);
  });

  it("end() is a no-op (no wire-level pane-end frame in WS protocol)", () => {
    const fake = createFakeWebSocket();
    const sink = new WebSocketSink(fake.ws);
    sink.end();
    expect(fake.sends).toHaveLength(0);
  });

  it("two independent WebSocketSink instances on the same ws coexist", () => {
    const fake = createFakeWebSocket();
    const sink1 = new WebSocketSink(fake.ws);
    const sink2 = new WebSocketSink(fake.ws);
    sink1.write({ paneId: 1, data: new Uint8Array([0x11]) });
    sink2.write({ paneId: 2, data: new Uint8Array([0x22]) });
    expect(fake.sends).toHaveLength(2);
    expect(decodePaneOutput(fake.sends[0]).paneId).toBe(1);
    expect(decodePaneOutput(fake.sends[1]).paneId).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// attachWebSocketSink — convenience function behavior
// ---------------------------------------------------------------------------

describe("attachWebSocketSink", () => {
  it("forwards every pane chunk as one binary frame whose decoded bytes match the source", () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    const fake = createFakeWebSocket();
    attachWebSocketSink(client, fake.ws);

    const payload = [0x00, 0x7f, 0x80, 0xc3, 0xa9, 0xff];
    t.feed(`%output %42 ${octEscape(payload)}\n`);

    expect(fake.sends).toHaveLength(1);
    const decoded = decodePaneOutput(fake.sends[0]);
    expect(decoded.paneId).toBe(42);
    expect(Array.from(decoded.data)).toEqual(payload);
  });

  it("default scope is serverScope — receives chunks from any pane", () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    const fake = createFakeWebSocket();
    attachWebSocketSink(client, fake.ws);

    t.feed(`%output %10 ${octEscape([0xaa])}\n`);
    t.feed(`%output %20 ${octEscape([0xbb])}\n`);
    t.feed(`%output %30 ${octEscape([0xcc])}\n`);

    expect(fake.sends).toHaveLength(3);
    expect(decodePaneOutput(fake.sends[0]).paneId).toBe(10);
    expect(decodePaneOutput(fake.sends[1]).paneId).toBe(20);
    expect(decodePaneOutput(fake.sends[2]).paneId).toBe(30);
  });

  it("paneScope filters to only the addressed pane", () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    const fake = createFakeWebSocket();
    attachWebSocketSink(client, fake.ws, { scope: paneScope(5) });

    t.feed(`%output %5 ${octEscape([0x55])}\n`);
    t.feed(`%output %6 ${octEscape([0x66])}\n`);

    expect(fake.sends).toHaveLength(1);
    expect(decodePaneOutput(fake.sends[0]).paneId).toBe(5);
  });

  it("preserves byte identity across multiple chunks", () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    const fake = createFakeWebSocket();
    attachWebSocketSink(client, fake.ws);

    t.feed(`%output %7 ${octEscape([0xc3])}\n`);
    t.feed(`%output %7 ${octEscape([0xa9, 0xe2, 0x98, 0x83])}\n`);

    expect(fake.sends).toHaveLength(2);
    expect(Array.from(decodePaneOutput(fake.sends[0]).data)).toEqual([0xc3]);
    expect(Array.from(decodePaneOutput(fake.sends[1]).data)).toEqual([
      0xa9, 0xe2, 0x98, 0x83,
    ]);
  });

  it("disposer stops forwarding", () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    const fake = createFakeWebSocket();
    const dispose = attachWebSocketSink(client, fake.ws);

    dispose();
    t.feed(`%output %5 ${octEscape([0x99])}\n`);

    expect(fake.sends).toHaveLength(0);
  });

  it("disposer is idempotent", () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    const fake = createFakeWebSocket();
    const dispose = attachWebSocketSink(client, fake.ws);

    dispose();
    dispose();
    dispose();

    expect(fake.sends).toHaveLength(0);
  });

  it("two attachments with different scopes on the same ws coexist", () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    const fake = createFakeWebSocket();
    attachWebSocketSink(client, fake.ws, { scope: paneScope(1) });
    attachWebSocketSink(client, fake.ws, { scope: paneScope(2) });

    t.feed(`%output %1 ${octEscape([0x11])}\n`);
    t.feed(`%output %2 ${octEscape([0x22, 0x22])}\n`);

    expect(fake.sends).toHaveLength(2);
    const pane1 = decodePaneOutput(fake.sends[0]);
    expect(pane1.paneId).toBe(1);
    expect(Array.from(pane1.data)).toEqual([0x11]);
    const pane2 = decodePaneOutput(fake.sends[1]);
    expect(pane2.paneId).toBe(2);
    expect(Array.from(pane2.data)).toEqual([0x22, 0x22]);
  });

  it("two serverScope attachments on the same ws both receive chunks (no exclusivity)", () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    const fake = createFakeWebSocket();
    attachWebSocketSink(client, fake.ws);
    attachWebSocketSink(client, fake.ws);

    t.feed(`%output %42 ${octEscape([0xab])}\n`);

    // Both attachments fire: two sends for the one chunk.
    expect(fake.sends).toHaveLength(2);
  });
});
