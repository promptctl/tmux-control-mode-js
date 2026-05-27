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
// Per the WHATWG Encoding Standard, 'latin1'/'iso-8859-1' maps to windows-1252
// in all conforming runtimes (Node, browsers, Deno) — 0x80-0x9F are remapped.
// String.fromCharCode (bytesToLatin1) is the portable, browser-safe path.
// (Node stream setEncoding('latin1') is also byte-faithful but Node-only.)
//
// [LAW:behavior-not-structure] Asserts the per-byte contract, not how the
//   decode is implemented.

import { websocketTransport } from "../../src/connectors/websocket/transport.js";
import { assertByteFaithful, FakeWebSocket } from "./_helpers/websocket-fake.js";
import { PROBE_BYTES } from "./_helpers/probe-bytes.js";

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
