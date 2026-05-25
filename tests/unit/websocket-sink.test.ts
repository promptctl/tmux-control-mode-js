// tests/unit/websocket-sink.test.ts
// Behavior-level tests for `attachWebSocketSink`.
//
// What the contract promises:
//   - `attachWebSocketSink(client, ws, paneId)` attaches an internal sink to
//     `client.attachPaneSink(paneId, ...)` and returns a disposer. The sink
//     reference never escapes — by construction the same wire stream cannot
//     be double-attached.
//   - Each pane chunk delivered through the client becomes one
//     `ws.send(encodePaneOutput({ type: 'output', paneId, data }))` binary
//     frame, byte-for-byte preserved. The bytes a complementary
//     `decodePaneOutput(frame)` recovers on the wire receiver side equal
//     the bytes the parser produced upstream.
//   - The disposer is idempotent and does NOT emit any wire-level
//     terminator frame (the WS protocol has no `paneEnd` analog; pane
//     teardown rides the JSON event channel).
//   - `ws.readyState !== OPEN` makes `write` a silent no-op (trust-boundary
//     guard on the WebSocket lifecycle).
//   - `ws.send` throwing under a torn-down socket (the TOCTOU race the
//     readyState guard cannot close) does NOT propagate out of the sink
//     — `PaneByteSink.write` must not throw per the foundation contract.
//   - A second concurrent `attachWebSocketSink(client, ws, paneId)`
//     throws `BridgeError("BRIDGE_PANE_SINK_ALREADY_ATTACHED")`. The
//     slot frees on disposer so rotation works.
//   - Concurrent attachments on the same `ws` for different paneIds
//     coexist without interference.
//
// [LAW:behavior-not-structure] These tests assert the wire contract
// (frame format byte-identity, lifecycle no-op, exclusivity, disposer
// idempotence), not the closure-internal structure of the registry or
// the sink. A re-implementation that satisfies the contract passes
// these tests unchanged.

import { describe, expect, it } from "vitest";

import { TmuxClient } from "../../src/client.js";
import {
  BridgeError,
  decodePaneOutput,
  type WebSocketSinkTarget,
} from "../../src/connectors/websocket/index.js";
import { attachWebSocketSink } from "../../src/connectors/websocket/sink.js";
import {
  WEBSOCKET_CLOSED,
  WEBSOCKET_CLOSING,
  WEBSOCKET_OPEN,
} from "../../src/connectors/websocket/types.js";
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
      // Copy the bytes — the sink may reuse the buffer, and our recording
      // must reflect what crossed the wire boundary at this instant.
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

/**
 * Octal-escape a byte array into the tmux control-mode `%output` wire form:
 * each byte becomes `\NNN` (3 octal digits). Drives the full parser path so
 * tests assert the round-trip from raw tmux bytes through the parser, the
 * pane-sink fan-out, and into the WebSocket send.
 */
function octEscape(bytes: readonly number[]): string {
  return bytes.map((b) => "\\" + b.toString(8).padStart(3, "0")).join("");
}

// ---------------------------------------------------------------------------
// attachWebSocketSink — main behavior in isolation.
// ---------------------------------------------------------------------------

describe("attachWebSocketSink", () => {
  it("forwards every pane chunk as one binary frame whose decoded bytes match the source", () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    const fake = createFakeWebSocket();
    attachWebSocketSink(client, fake.ws, 42);

    const payload = [0x00, 0x7f, 0x80, 0xc3, 0xa9, 0xff];
    t.feed(`%output %42 ${octEscape(payload)}\n`);

    expect(fake.sends).toHaveLength(1);
    const decoded = decodePaneOutput(fake.sends[0]);
    expect(decoded.type).toBe("output");
    expect(decoded.paneId).toBe(42);
    expect(Array.from(decoded.data)).toEqual(payload);
  });

  it("preserves byte identity across multiple chunks (split multi-byte UTF-8 sequences land untouched)", () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    const fake = createFakeWebSocket();
    attachWebSocketSink(client, fake.ws, 7);

    // Split 'é' (0xc3 0xa9) across two frames — the sink is byte-passthrough,
    // streaming decode is the receiver's job (TextStreamSink owns that path).
    t.feed(`%output %7 ${octEscape([0xc3])}\n`);
    t.feed(`%output %7 ${octEscape([0xa9, 0xe2, 0x98, 0x83])}\n`); // ', '☃'

    expect(fake.sends).toHaveLength(2);
    expect(Array.from(decodePaneOutput(fake.sends[0]).data)).toEqual([0xc3]);
    expect(Array.from(decodePaneOutput(fake.sends[1]).data)).toEqual([
      0xa9, 0xe2, 0x98, 0x83,
    ]);
  });

  it("emits no wire frame on disposer (WS protocol has no paneEnd analog)", () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    const fake = createFakeWebSocket();
    const dispose = attachWebSocketSink(client, fake.ws, 3);

    dispose();

    expect(fake.sends).toEqual([]);
  });

  it("stops forwarding after the disposer runs", () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    const fake = createFakeWebSocket();
    const dispose = attachWebSocketSink(client, fake.ws, 5);

    dispose();
    t.feed(`%output %5 ${octEscape([0x99])}\n`);

    expect(fake.sends).toEqual([]);
  });

  it("returned disposer is idempotent — repeated calls are no-ops", () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    const fake = createFakeWebSocket();
    const dispose = attachWebSocketSink(client, fake.ws, 9);

    dispose();
    dispose();
    dispose();

    expect(fake.sends).toEqual([]);
  });

  it("no-ops on pane bytes when readyState is CLOSING or CLOSED", () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    const fake = createFakeWebSocket();
    attachWebSocketSink(client, fake.ws, 11);

    fake.setReadyState(WEBSOCKET_CLOSING);
    t.feed(`%output %11 ${octEscape([0xaa])}\n`);
    fake.setReadyState(WEBSOCKET_CLOSED);
    t.feed(`%output %11 ${octEscape([0xbb])}\n`);

    expect(fake.sends).toEqual([]);
  });

  it("does not propagate ws.send throws (TOCTOU torn-down socket)", () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    const fake = createFakeWebSocket();
    attachWebSocketSink(client, fake.ws, 13);

    fake.throwOnNextSend();
    // PaneByteSink.write must not throw — a throw here would propagate up
    // through the parser's per-chunk dispatch loop into the transport's
    // data handler and tear down a working connection on a transient race.
    expect(() => t.feed(`%output %13 ${octEscape([0xcc])}\n`)).not.toThrow();
    expect(fake.sends).toEqual([]);

    // The sink remains attached after the swallowed throw — subsequent
    // chunks land normally once the socket recovers.
    t.feed(`%output %13 ${octEscape([0xdd])}\n`);
    expect(fake.sends).toHaveLength(1);
    expect(Array.from(decodePaneOutput(fake.sends[0]).data)).toEqual([0xdd]);
  });

  it("refuses a second concurrent attachment for the same (ws, paneId)", () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    const fake = createFakeWebSocket();
    attachWebSocketSink(client, fake.ws, 21);

    expect(() => attachWebSocketSink(client, fake.ws, 21)).toThrow(BridgeError);
    expect(() => attachWebSocketSink(client, fake.ws, 21)).toThrow(
      /BRIDGE_PANE_SINK_ALREADY_ATTACHED/,
    );
  });

  it("frees the (ws, paneId) slot on disposer so a rotated attachment can attach", () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    const fake = createFakeWebSocket();
    const dispose = attachWebSocketSink(client, fake.ws, 22);

    dispose();

    expect(() => attachWebSocketSink(client, fake.ws, 22)).not.toThrow();
  });

  it("allows concurrent attachments for the same ws on different paneIds", () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    const fake = createFakeWebSocket();

    expect(() => attachWebSocketSink(client, fake.ws, 31)).not.toThrow();
    expect(() => attachWebSocketSink(client, fake.ws, 32)).not.toThrow();
    expect(() => attachWebSocketSink(client, fake.ws, 33)).not.toThrow();
  });

  it("routes only the bytes addressed to this paneId when many attachments coexist on one ws", () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    const fake = createFakeWebSocket();
    attachWebSocketSink(client, fake.ws, 1);
    attachWebSocketSink(client, fake.ws, 2);

    t.feed(`%output %1 ${octEscape([0x11])}\n`);
    t.feed(`%output %2 ${octEscape([0x22, 0x22])}\n`);
    t.feed(`%output %1 ${octEscape([0x13, 0x14, 0x15])}\n`);

    const byPane = new Map<number, number[][]>();
    for (const frame of fake.sends) {
      const decoded = decodePaneOutput(frame);
      const arr = byPane.get(decoded.paneId) ?? [];
      arr.push(Array.from(decoded.data));
      byPane.set(decoded.paneId, arr);
    }
    expect(byPane.get(1)).toEqual([[0x11], [0x13, 0x14, 0x15]]);
    expect(byPane.get(2)).toEqual([[0x22, 0x22]]);
  });

  it("never exposes a reusable PaneByteSink: only the disposer escapes", () => {
    // Compile-time check: the return type is `() => void`, not
    // `PaneByteSink`. This test makes the API guarantee visible at the
    // value level too.
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    const fake = createFakeWebSocket();
    const result: unknown = attachWebSocketSink(client, fake.ws, 40);
    expect(typeof result).toBe("function");
  });
});
