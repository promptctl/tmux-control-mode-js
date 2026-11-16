// tests/unit/web-contents-sink.test.ts
// Behavior-level tests for `WebContentsSink` and `attachWebContentsSink`
// (main.ts).
//
// What the contract promises:
//
// WebContentsSink / attachWebContentsSink:
//   - `WebContentsSink.write(msg)` sends an `OutputMessage` on `IPC.event`,
//     byte-for-byte preserved.
//   - `write` is a no-op when `wc.isDestroyed()`.
//   - `end()` is a no-op (no wire-level pane-end frame on IPC.event).
//   - `attachWebContentsSink(client, wc, options?)` is equivalent to
//     `client.attachBytesSink(new WebContentsSink(wc), options)`.
//   - Default scope is serverScope (all panes on the server).
//   - Narrowed scope (paneScope, sessionScope) filters correctly.
//   - The returned disposer stops forwarding and is idempotent.
//   - Multiple attachments on the same wc with different scopes coexist —
//     there is NO exclusivity registry.
//
// [LAW:behavior-not-structure] Tests assert the wire contract (channel names,
//   envelope shape, byte preservation, scope filtering, lifecycle), not the
//   closure-internal structure of the sink.

import { describe, expect, it } from "vitest";

import { TmuxClient } from "../../src/client.js";
import {
  WebContentsSink,
  attachWebContentsSink,
} from "../../src/connectors/electron/main.js";
import {
  IPC,
  type IpcEventMessage,
  type IpcRendererLike,
  type IpcRendererOnListener,
  type WebContentsLike,
} from "../../src/connectors/electron/types.js";
import { paneScope } from "../../src/pane-output.js";
import type { TmuxTransport } from "../../src/transport/types.js";
import { isPaneOutput, type OutputMessage } from "../../src/protocol/types.js";

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
    send() {
      return { ok: true } as const;
    },
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

interface FakeWebContents {
  readonly wc: Pick<WebContentsLike, "send" | "isDestroyed">;
  readonly sends: IpcEventMessage[];
  destroy(): void;
}

/** The `i`th send, which a sink only ever makes as pane output. */
function sentOutput(fake: FakeWebContents, i: number): OutputMessage {
  const msg = fake.sends[i];
  if (!isPaneOutput(msg)) throw new Error(`send ${i} is ${msg.type}`);
  return msg;
}

function createFakeWebContents(): FakeWebContents {
  let destroyed = false;
  const sends: IpcEventMessage[] = [];
  const wc: Pick<WebContentsLike, "send" | "isDestroyed"> = {
    send(_channel, msg) {
      sends.push(msg);
    },
    isDestroyed() {
      return destroyed;
    },
  };
  return {
    wc,
    sends,
    destroy() {
      destroyed = true;
    },
  };
}

function octEscape(bytes: readonly number[]): string {
  return bytes.map((b) => "\\" + b.toString(8).padStart(3, "0")).join("");
}

// ---------------------------------------------------------------------------
// WebContentsSink — class-level contract
// ---------------------------------------------------------------------------

describe("WebContentsSink", () => {
  it("write sends an OutputMessage on IPC.event, byte-for-byte", () => {
    const fake = createFakeWebContents();
    const sink = new WebContentsSink(fake.wc);
    const data = new Uint8Array([0x00, 0x7f, 0x80, 0xc3, 0xa9, 0xff]);
    sink.write({ paneId: 42, data });

    expect(fake.sends).toHaveLength(1);
    const msg = sentOutput(fake, 0);
    expect(msg.type).toBe("output");
    expect(msg.paneId).toBe(42);
    expect(Array.from(msg.data)).toEqual([0x00, 0x7f, 0x80, 0xc3, 0xa9, 0xff]);
  });

  it("write is a no-op when wc.isDestroyed()", () => {
    const fake = createFakeWebContents();
    const sink = new WebContentsSink(fake.wc);
    fake.destroy();
    sink.write({ paneId: 1, data: new Uint8Array([0xaa]) });
    expect(fake.sends).toHaveLength(0);
  });

  it("end() is a no-op (no wire-level pane-end frame on IPC.event)", () => {
    const fake = createFakeWebContents();
    const sink = new WebContentsSink(fake.wc);
    sink.end();
    expect(fake.sends).toHaveLength(0);
  });

  it("two independent WebContentsSink instances on the same wc coexist", () => {
    const fake = createFakeWebContents();
    const sink1 = new WebContentsSink(fake.wc);
    const sink2 = new WebContentsSink(fake.wc);
    sink1.write({ paneId: 1, data: new Uint8Array([0x11]) });
    sink2.write({ paneId: 2, data: new Uint8Array([0x22]) });
    expect(fake.sends).toHaveLength(2);
    expect(sentOutput(fake, 0).paneId).toBe(1);
    expect(sentOutput(fake, 1).paneId).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// attachWebContentsSink — convenience function behavior
// ---------------------------------------------------------------------------

describe("attachWebContentsSink", () => {
  it("forwards every pane chunk as an OutputMessage on IPC.event, byte-for-byte", () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    const fake = createFakeWebContents();
    attachWebContentsSink(client, fake.wc);

    const payload = [0x00, 0x7f, 0x80, 0xc3, 0xa9, 0xff];
    t.feed(`%output %42 ${octEscape(payload)}\n`);

    expect(fake.sends).toHaveLength(1);
    const msg = sentOutput(fake, 0);
    expect(msg.type).toBe("output");
    expect(msg.paneId).toBe(42);
    expect(Array.from(msg.data)).toEqual(payload);
  });

  it("default scope is serverScope — receives chunks from any pane", () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    const fake = createFakeWebContents();
    attachWebContentsSink(client, fake.wc);

    t.feed(`%output %10 ${octEscape([0xaa])}\n`);
    t.feed(`%output %20 ${octEscape([0xbb])}\n`);

    expect(fake.sends).toHaveLength(2);
    expect(sentOutput(fake, 0).paneId).toBe(10);
    expect(sentOutput(fake, 1).paneId).toBe(20);
  });

  it("paneScope filters to only the addressed pane", () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    const fake = createFakeWebContents();
    attachWebContentsSink(client, fake.wc, { scope: paneScope(5) });

    t.feed(`%output %5 ${octEscape([0x55])}\n`);
    t.feed(`%output %6 ${octEscape([0x66])}\n`);

    expect(fake.sends).toHaveLength(1);
    expect(sentOutput(fake, 0).paneId).toBe(5);
  });

  it("no-ops on wc.isDestroyed() during write", () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    const fake = createFakeWebContents();
    attachWebContentsSink(client, fake.wc);
    fake.destroy();

    t.feed(`%output %1 ${octEscape([0xaa, 0xbb])}\n`);

    expect(fake.sends).toEqual([]);
  });

  it("disposer stops forwarding", () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    const fake = createFakeWebContents();
    const dispose = attachWebContentsSink(client, fake.wc);

    dispose();
    t.feed(`%output %3 ${octEscape([0x99])}\n`);

    expect(fake.sends).toHaveLength(0);
  });

  it("disposer is idempotent — no wire-level pane-end frame", () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    const fake = createFakeWebContents();
    const dispose = attachWebContentsSink(client, fake.wc);

    dispose();
    dispose();
    dispose();

    // No sends: end() is a no-op; pane lifecycle surfaces via tmux
    // notifications on IPC.event, not a dedicated terminator frame.
    expect(fake.sends).toHaveLength(0);
  });

  it("two attachments with different scopes on the same wc coexist", () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    const fake = createFakeWebContents();
    attachWebContentsSink(client, fake.wc, { scope: paneScope(1) });
    attachWebContentsSink(client, fake.wc, { scope: paneScope(2) });

    t.feed(`%output %1 ${octEscape([0x11])}\n`);
    t.feed(`%output %2 ${octEscape([0x22])}\n`);

    expect(fake.sends).toHaveLength(2);
    expect(sentOutput(fake, 0).paneId).toBe(1);
    expect(sentOutput(fake, 1).paneId).toBe(2);
  });

  it("two serverScope attachments on the same wc both receive chunks (no exclusivity)", () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    const fake = createFakeWebContents();
    attachWebContentsSink(client, fake.wc);
    attachWebContentsSink(client, fake.wc);

    t.feed(`%output %42 ${octEscape([0xab])}\n`);

    // Both attachments fire: two sends for the one chunk.
    expect(fake.sends).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// IPC payloads — each channel's arguments, checked where they are sent
// ---------------------------------------------------------------------------

describe("IPC payloads", () => {
  it("main sends a renderer only an IpcEventMessage, and a renderer listener receives one", () => {
    const fake = createFakeWebContents();
    const output: OutputMessage = {
      type: "output",
      paneId: 1,
      data: new Uint8Array(),
    };
    // @ts-expect-error a payload outside IpcEventMessage does not compile
    const wrongPayload = () => fake.wc.send(IPC.event, { type: "bogus" });
    // @ts-expect-error main sends a renderer nothing on another channel
    const wrongChannel = () => fake.wc.send(IPC.ack, output);
    // An unannotated listener's `msg` is the union itself.
    const listener: IpcRendererOnListener = (_e, msg) => {
      const type: IpcEventMessage["type"] = msg.type;
      return type;
    };
    expect([wrongPayload, wrongChannel, listener]).toHaveLength(3);
  });

  it("a renderer sends main each channel's own arguments", () => {
    const sends = (ipc: IpcRendererLike) => [
      () => ipc.send(IPC.register),
      () => ipc.send(IPC.ack, { paneId: 1, bytes: 1 }),
      // @ts-expect-error an ack carries its AckMessage
      () => ipc.send(IPC.ack),
      // @ts-expect-error register carries nothing
      () => ipc.send(IPC.register, { paneId: 1, bytes: 1 }),
      // @ts-expect-error a renderer sends main nothing on IPC.event
      () => ipc.send(IPC.event),
      // @ts-expect-error invoke is the one channel a renderer invokes on
      () => ipc.invoke(IPC.ack, { paneId: 1, bytes: 1 }),
    ];
    expect(sends).toBeTypeOf("function");
  });
});
