// tests/unit/_helpers/websocket-fake.ts
// A fake WebSocket for websocketTransport, and the byte-faithfulness check
// its contract tests share.
//
// [LAW:single-enforcer] assertByteFaithful and FakeWebSocket are defined once
//   here and imported by the Node and browser byte-faithfulness contract
//   tests and by websocket-transport.test.ts. Both test environments (Node,
//   happy-dom) run the same helper code.

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

  readonly sent: string[] = [];
  closed = false;

  send(data: string | ArrayBufferLike | ArrayBufferView | Blob): void {
    // The transport only ever sends strings; tests assert that.
    this.sent.push(data as string);
  }
  close(_code?: number, _reason?: string): void {
    this.closed = true;
  }

  addEventListener(
    type: "open" | "error",
    listener: (event: unknown) => void,
  ): void;
  addEventListener(
    type: "message",
    listener: (event: { data: unknown }) => void,
  ): void;
  addEventListener(
    type: "close",
    listener: (event: { code?: number; reason?: string }) => void,
  ): void;
  addEventListener<K extends keyof FakeEvents>(
    type: K,
    listener: FakeEvents[K],
  ): void {
    this.listeners[type].push(listener);
  }

  removeEventListener(
    type: "open" | "error",
    listener: (event: unknown) => void,
  ): void;
  removeEventListener(
    type: "message",
    listener: (event: { data: unknown }) => void,
  ): void;
  removeEventListener(
    type: "close",
    listener: (event: { code?: number; reason?: string }) => void,
  ): void;
  removeEventListener<K extends keyof FakeEvents>(
    type: K,
    listener: FakeEvents[K],
  ): void {
    const list: FakeEvents[K][] = this.listeners[type];
    const i = list.indexOf(listener);
    if (i !== -1) list.splice(i, 1);
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
