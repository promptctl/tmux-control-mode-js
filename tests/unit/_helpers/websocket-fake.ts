// tests/unit/_helpers/websocket-fake.ts
// Shared test infrastructure for websocket byte-faithfulness contract tests.
//
// [LAW:single-enforcer] assertByteFaithful and FakeWebSocket are defined once
//   here and imported by both the Node and browser companion contract tests.
//   Both test environments (Node, happy-dom) run the same helper code.

import type { BrowserWebSocketLike } from "../../../src/connectors/websocket/types.js";

export function assertByteFaithful(
  received: string,
  expected: Uint8Array,
): void {
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

export class FakeWebSocket implements BrowserWebSocketLike {
  readyState = 1;
  binaryType: "blob" | "arraybuffer" = "blob";
  private readonly listeners: { [K in keyof FakeEvents]: FakeEvents[K][] } = {
    open: [],
    error: [],
    message: [],
    close: [],
  };

  send(_data: string | ArrayBufferLike | ArrayBufferView | Blob): void {}
  close(_code?: number, _reason?: string): void {}

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
  addEventListener<K extends keyof FakeEvents>(
    type: K,
    listener: FakeEvents[K],
  ): void {
    this.listeners[type].push(listener);
  }

  emitMessage(data: unknown): void {
    this.listeners.message.forEach((l) => l({ data }));
  }
}
