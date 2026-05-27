// tests/unit/byte-faithful-contract.test.ts
// Cross-transport byte-faithfulness contract test — Node environment.
//
// Contract: ∀ byte b in PROBE_BYTES, every transport's onData delivers a
// string where charCodeAt(i) === b. This makes future byte-decode drift
// impossible at the transport→parser boundary.
//
// [LAW:behavior-not-structure] Tests assert the per-byte contract, not
//   implementation details (setEncoding, String.fromCharCode, etc.).
// [LAW:single-enforcer] PROBE_BYTES is the canonical probe payload; both this
//   file and the browser companion import it from _helpers/probe-bytes.ts.

import { PassThrough } from "node:stream";
import { websocketTransport } from "../../src/connectors/websocket/transport.js";
import type { BrowserWebSocketLike } from "../../src/connectors/websocket/types.js";
import { PROBE_BYTES } from "./_helpers/probe-bytes.js";

function assertByteFaithful(received: string, expected: Uint8Array): void {
  expect(received.length).toBe(expected.length);
  for (let i = 0; i < expected.length; i++) {
    expect(received.charCodeAt(i)).toBe(expected[i]);
  }
}

// ---------------------------------------------------------------------------
// Minimal FakeWebSocket — drives message events into the transport under test.
// The generic addEventListener implementation mirrors the pattern from
// websocket-transport.test.ts, which avoids the strict-contravariance issue
// that arises when typing a union of listener shapes.
// ---------------------------------------------------------------------------

interface FakeEvents {
  open: (event: unknown) => void;
  error: (event: unknown) => void;
  message: (event: { data: unknown }) => void;
  close: (event: { code?: number; reason?: string }) => void;
}

class FakeWebSocket implements BrowserWebSocketLike {
  readyState = 1;
  binaryType: "blob" | "arraybuffer" = "blob";
  private readonly listeners: { [K in keyof FakeEvents]: FakeEvents[K][] } = {
    open: [], error: [], message: [], close: [],
  };

  send(): void {}
  close(): void {}

  addEventListener(type: "open" | "error", listener: (event: unknown) => void, options?: { signal?: AbortSignal }): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void, options?: { signal?: AbortSignal }): void;
  addEventListener(type: "close", listener: (event: { code?: number; reason?: string }) => void, options?: { signal?: AbortSignal }): void;
  addEventListener<K extends keyof FakeEvents>(type: K, listener: FakeEvents[K]): void {
    this.listeners[type].push(listener);
  }

  emitMessage(data: unknown): void {
    this.listeners.message.forEach((l) => l({ data }));
  }
}

// ---------------------------------------------------------------------------
// websocketTransport — ArrayBuffer frame (the primary binary path)
// ---------------------------------------------------------------------------

describe("byte-faithfulness contract: websocketTransport (Node)", () => {
  it("ArrayBuffer frame: every byte maps 1:1 to its code unit", () => {
    const ws = new FakeWebSocket();
    const t = websocketTransport(ws);
    const chunks: string[] = [];
    t.onData((c) => chunks.push(c));

    ws.emitMessage(PROBE_BYTES.buffer);

    expect(chunks.length).toBe(1);
    assertByteFaithful(chunks[0], PROBE_BYTES);
  });

  it("Uint8Array frame (ArrayBufferView): every byte maps 1:1 to its code unit", () => {
    const ws = new FakeWebSocket();
    const t = websocketTransport(ws);
    const chunks: string[] = [];
    t.onData((c) => chunks.push(c));

    ws.emitMessage(PROBE_BYTES); // Uint8Array is an ArrayBufferView

    expect(chunks.length).toBe(1);
    assertByteFaithful(chunks[0], PROBE_BYTES);
  });

  it("sub-array view (non-zero byteOffset) is byte-faithful", () => {
    // Ensures the ArrayBufferView path respects byteOffset/byteLength.
    const ws = new FakeWebSocket();
    const t = websocketTransport(ws);
    const chunks: string[] = [];
    t.onData((c) => chunks.push(c));

    // Prefix with 3 zeros, then the probe — take a view of just the probe.
    const padded = new Uint8Array(3 + PROBE_BYTES.length);
    padded.set(PROBE_BYTES, 3);
    const view = padded.subarray(3); // byteOffset = 3, byteLength = PROBE_BYTES.length

    ws.emitMessage(view);

    expect(chunks.length).toBe(1);
    assertByteFaithful(chunks[0], PROBE_BYTES);
  });
});

// ---------------------------------------------------------------------------
// Spawn transport decode mechanism — Node-only (setEncoding('latin1'))
//
// spawnTmux sets child.stdout.setEncoding('latin1') so that Node.js's
// Readable stream API performs the Buffer→string conversion via latin1,
// which is 1:1 byte↔code-unit in Node.js (unlike TextDecoder('latin1')
// which is windows-1252 in browsers). This test exercises that mechanism
// directly via a PassThrough stream without needing actual tmux.
// ---------------------------------------------------------------------------

describe("byte-faithfulness contract: spawn transport decode mechanism (Node)", () => {
  it("setEncoding('latin1') on a stream delivers 1:1 byte↔code-unit strings", () =>
    new Promise<void>((resolve, reject) => {
      const stream = new PassThrough();
      // [LAW:single-enforcer] exception: this tests the spawn transport's
      // setEncoding path (documented in spawn.ts). All other transports use bytesToLatin1.
      stream.setEncoding("latin1");

      const chunks: string[] = [];
      stream.on("data", (chunk: string) => chunks.push(chunk));
      stream.on("end", () => {
        try {
          const received = chunks.join("");
          assertByteFaithful(received, PROBE_BYTES);
          resolve();
        } catch (e) {
          reject(e);
        }
      });
      stream.on("error", reject);

      stream.write(Buffer.from(PROBE_BYTES));
      stream.end();
    }));

  it("setEncoding('latin1') preserves windows-1252 landmine bytes without remapping", () =>
    new Promise<void>((resolve, reject) => {
      const landmine = new Uint8Array([0x80, 0x81, 0x8d, 0x8f, 0x9d, 0x9f]);
      const stream = new PassThrough();
      stream.setEncoding("latin1");

      let received = "";
      stream.on("data", (chunk: string) => {
        received += chunk;
      });
      stream.on("end", () => {
        try {
          assertByteFaithful(received, landmine);
          resolve();
        } catch (e) {
          reject(e);
        }
      });
      stream.on("error", reject);

      stream.write(Buffer.from(landmine));
      stream.end();
    }));
});
