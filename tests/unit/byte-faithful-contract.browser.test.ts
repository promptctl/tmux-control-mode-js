// tests/unit/byte-faithful-contract.browser.test.ts
// Cross-transport byte-faithfulness contract — browser (happy-dom) environment.
//
// @vitest-environment happy-dom
//
// This file re-asserts the same behavioral contract as byte-faithful-contract.test.ts
// but inside a browser-like runtime. The only transport tested here is
// websocketTransport — the spawn transport is Node-only (child_process/stream).
//
// Purpose: guard against future "simplification" to TextDecoder('latin1').
// Per the WHATWG Encoding Standard, 'latin1'/'iso-8859-1' is windows-1252 in
// all conforming runtimes (Node, browsers, Deno) — 0x80-0x9F are remapped.
// The only byte-faithful decode is String.fromCharCode (bytesToLatin1).
//
// [LAW:behavior-not-structure] Asserts the per-byte contract, not how the
//   decode is implemented.

import { websocketTransport } from "../../src/connectors/websocket/transport.js";
import type { BrowserWebSocketLike } from "../../src/connectors/websocket/types.js";
import { PROBE_BYTES } from "./_helpers/probe-bytes.js";

function assertByteFaithful(received: string, expected: Uint8Array): void {
  expect(received.length).toBe(expected.length);
  for (let i = 0; i < expected.length; i++) {
    expect(received.charCodeAt(i)).toBe(expected[i]);
  }
}

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

  send(_data: string | ArrayBufferLike | ArrayBufferView | Blob): void {}
  close(_code?: number, _reason?: string): void {}

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

describe("byte-faithfulness contract: websocketTransport (browser / happy-dom)", () => {
  it("ArrayBuffer frame: every byte maps 1:1 to its code unit (browser env)", () => {
    const ws = new FakeWebSocket();
    const t = websocketTransport(ws);
    const chunks: string[] = [];
    t.onData((c) => chunks.push(c));

    ws.emitMessage(PROBE_BYTES.buffer);

    expect(chunks.length).toBe(1);
    assertByteFaithful(chunks[0], PROBE_BYTES);
  });

  it("Uint8Array frame: every byte maps 1:1 to its code unit (browser env)", () => {
    const ws = new FakeWebSocket();
    const t = websocketTransport(ws);
    const chunks: string[] = [];
    t.onData((c) => chunks.push(c));

    ws.emitMessage(PROBE_BYTES);

    expect(chunks.length).toBe(1);
    assertByteFaithful(chunks[0], PROBE_BYTES);
  });

  it("windows-1252 landmine bytes (0x80-0x9F) are not remapped in browser env", () => {
    // If bytesToLatin1 were ever changed to TextDecoder('latin1'), these bytes
    // would be remapped to U+20AC, U+0081, U+008D … in browsers (windows-1252),
    // producing charCodeAt values != the original bytes. This test would catch it.
    const landmine = new Uint8Array([0x80, 0x81, 0x8d, 0x8f, 0x9d, 0x9f]);
    const ws = new FakeWebSocket();
    const t = websocketTransport(ws);
    const chunks: string[] = [];
    t.onData((c) => chunks.push(c));

    ws.emitMessage(landmine.buffer);

    expect(chunks.length).toBe(1);
    assertByteFaithful(chunks[0], landmine);
  });
});
