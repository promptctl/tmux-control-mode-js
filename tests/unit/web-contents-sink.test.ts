// tests/unit/web-contents-sink.test.ts
// Behavior-level tests for `WebContentsSink`, `attachWebContentsSink` (main.ts)
// and the renderer-side `createPaneBytesReceiver` (renderer.ts).
//
// What the contract promises:
//
// WebContentsSink / attachWebContentsSink:
//   - `WebContentsSink.write(msg)` sends a `PaneOutputMessage` on `IPC.event`,
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
// createPaneBytesReceiver (unchanged; uses IPC.paneBytes separately):
//   - Filters inbound IPC.paneBytes frames by paneId.
//   - Forwards matching frames into the supplied BytesSink.
//   - Calls sink.end() and auto-detaches on IPC.paneEnd for matching paneId.
//   - Returned disposer is idempotent.
//   - Exclusivity: one receiver per (ipcRenderer, paneId).
//
// [LAW:behavior-not-structure] Tests assert the wire contract (channel names,
//   envelope shape, byte preservation, scope filtering, lifecycle), not the
//   closure-internal structure of the sink or receiver.

import { describe, expect, it } from "vitest";

import { TmuxClient } from "../../src/client.js";
import {
  WebContentsSink,
  attachWebContentsSink,
  type PaneBytesEnvelope,
  type PaneEndEnvelope,
} from "../../src/connectors/electron/main.js";
import { createPaneBytesReceiver } from "../../src/connectors/electron/renderer.js";
import {
  BridgeError,
  IPC,
  type WebContentsLike,
} from "../../src/connectors/electron/types.js";
import type { BytesSink } from "../../src/pane-output.js";
import { paneScope } from "../../src/pane-output.js";
import type { TmuxTransport } from "../../src/transport/types.js";
import type { PaneOutputMessage } from "../../src/protocol/types.js";

import { createIpcHub } from "./_helpers/ipc-hub.js";

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

interface RecordedSend {
  readonly channel: string;
  readonly args: readonly unknown[];
}

interface FakeWebContents {
  readonly wc: WebContentsLike;
  readonly sends: RecordedSend[];
  destroy(): void;
}

function createFakeWebContents(): FakeWebContents {
  let destroyed = false;
  const sends: RecordedSend[] = [];
  const wc: WebContentsLike = {
    send(channel, ...args) {
      sends.push({ channel, args });
    },
    once() {},
    removeListener() {},
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

interface RecordingSink {
  readonly sink: BytesSink;
  readonly writes: Uint8Array[];
  endCalls: number;
}

function createRecordingSink(): RecordingSink {
  const writes: Uint8Array[] = [];
  const state = { endCalls: 0 };
  const sink: BytesSink = {
    write(msg) {
      writes.push(msg.data.slice());
    },
    end() {
      state.endCalls++;
    },
  };
  return {
    sink,
    writes,
    get endCalls() {
      return state.endCalls;
    },
    set endCalls(v) {
      state.endCalls = v;
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
  it("write sends a PaneOutputMessage on IPC.event, byte-for-byte", () => {
    const fake = createFakeWebContents();
    const sink = new WebContentsSink(fake.wc);
    const data = new Uint8Array([0x00, 0x7f, 0x80, 0xc3, 0xa9, 0xff]);
    sink.write({ paneId: 42, data });

    expect(fake.sends).toHaveLength(1);
    expect(fake.sends[0].channel).toBe(IPC.event);
    const msg = fake.sends[0].args[0] as PaneOutputMessage;
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
    expect((fake.sends[0].args[0] as PaneOutputMessage).paneId).toBe(1);
    expect((fake.sends[1].args[0] as PaneOutputMessage).paneId).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// attachWebContentsSink — convenience function behavior
// ---------------------------------------------------------------------------

describe("attachWebContentsSink", () => {
  it("forwards every pane chunk as a PaneOutputMessage on IPC.event, byte-for-byte", () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    const fake = createFakeWebContents();
    attachWebContentsSink(client, fake.wc);

    const payload = [0x00, 0x7f, 0x80, 0xc3, 0xa9, 0xff];
    t.feed(`%output %42 ${octEscape(payload)}\n`);

    expect(fake.sends).toHaveLength(1);
    expect(fake.sends[0].channel).toBe(IPC.event);
    const msg = fake.sends[0].args[0] as PaneOutputMessage;
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
    expect((fake.sends[0].args[0] as PaneOutputMessage).paneId).toBe(10);
    expect((fake.sends[1].args[0] as PaneOutputMessage).paneId).toBe(20);
  });

  it("paneScope filters to only the addressed pane", () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    const fake = createFakeWebContents();
    attachWebContentsSink(client, fake.wc, { scope: paneScope(5) });

    t.feed(`%output %5 ${octEscape([0x55])}\n`);
    t.feed(`%output %6 ${octEscape([0x66])}\n`);

    expect(fake.sends).toHaveLength(1);
    expect((fake.sends[0].args[0] as PaneOutputMessage).paneId).toBe(5);
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

  it("disposer is idempotent — no paneEnd frame (IPC.event has no pane-end)", () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    const fake = createFakeWebContents();
    const dispose = attachWebContentsSink(client, fake.wc);

    dispose();
    dispose();
    dispose();

    // No sends: end() is a no-op, no IPC.paneEnd frame.
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
    expect((fake.sends[0].args[0] as PaneOutputMessage).paneId).toBe(1);
    expect((fake.sends[1].args[0] as PaneOutputMessage).paneId).toBe(2);
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
// createPaneBytesReceiver — renderer-side behavior in isolation.
//
// Driven by the shared IPC hub so structured-clone semantics match real
// Electron (`Uint8Array` is preserved; mutating the source post-send does
// NOT affect the receiver's view).
// ---------------------------------------------------------------------------

describe("createPaneBytesReceiver", () => {
  it("forwards matching paneBytes frames into the sink", () => {
    const hub = createIpcHub();
    const renderer = hub.createRenderer();
    const sink = createRecordingSink();
    createPaneBytesReceiver(renderer.ipcRenderer, 3, sink.sink);

    const payload = new Uint8Array([0xc3, 0xa9, 0xe2, 0x98, 0x83]);
    renderer.sender.send(IPC.paneBytes, {
      type: "output" as const,
      paneId: 3,
      data: payload,
    } satisfies PaneBytesEnvelope);

    expect(sink.writes).toHaveLength(1);
    expect(Array.from(sink.writes[0])).toEqual(Array.from(payload));
  });

  it("ignores paneBytes frames whose paneId does not match", () => {
    const hub = createIpcHub();
    const renderer = hub.createRenderer();
    const sink = createRecordingSink();
    createPaneBytesReceiver(renderer.ipcRenderer, 3, sink.sink);

    renderer.sender.send(IPC.paneBytes, {
      type: "output" as const,
      paneId: 4,
      data: new Uint8Array([0x01]),
    } satisfies PaneBytesEnvelope);
    renderer.sender.send(IPC.paneBytes, {
      type: "output" as const,
      paneId: 2,
      data: new Uint8Array([0x02]),
    } satisfies PaneBytesEnvelope);

    expect(sink.writes).toEqual([]);
  });

  it("forwards paneEnd for matching paneId, calling sink.end exactly once", () => {
    const hub = createIpcHub();
    const renderer = hub.createRenderer();
    const sink = createRecordingSink();
    createPaneBytesReceiver(renderer.ipcRenderer, 5, sink.sink);

    renderer.sender.send(IPC.paneEnd, { paneId: 5 } satisfies PaneEndEnvelope);

    expect(sink.endCalls).toBe(1);
  });

  it("auto-detaches after paneEnd so subsequent frames do not reach the sink", () => {
    const hub = createIpcHub();
    const renderer = hub.createRenderer();
    const sink = createRecordingSink();
    createPaneBytesReceiver(renderer.ipcRenderer, 5, sink.sink);

    renderer.sender.send(IPC.paneEnd, { paneId: 5 } satisfies PaneEndEnvelope);
    renderer.sender.send(IPC.paneBytes, {
      type: "output" as const,
      paneId: 5,
      data: new Uint8Array([0x01, 0x02]),
    } satisfies PaneBytesEnvelope);
    renderer.sender.send(IPC.paneEnd, { paneId: 5 } satisfies PaneEndEnvelope);

    expect(sink.writes).toEqual([]);
    expect(sink.endCalls).toBe(1);
  });

  it("returns an idempotent disposer that detaches both listeners", () => {
    const hub = createIpcHub();
    const renderer = hub.createRenderer();
    const sink = createRecordingSink();
    const dispose = createPaneBytesReceiver(
      renderer.ipcRenderer,
      6,
      sink.sink,
    );

    dispose();
    dispose();

    renderer.sender.send(IPC.paneBytes, {
      type: "output" as const,
      paneId: 6,
      data: new Uint8Array([0xff]),
    } satisfies PaneBytesEnvelope);
    renderer.sender.send(IPC.paneEnd, { paneId: 6 } satisfies PaneEndEnvelope);

    expect(sink.writes).toEqual([]);
    expect(sink.endCalls).toBe(0);
  });

  it("ignores paneEnd whose paneId does not match (no detach, no sink.end)", () => {
    const hub = createIpcHub();
    const renderer = hub.createRenderer();
    const sink = createRecordingSink();
    createPaneBytesReceiver(renderer.ipcRenderer, 9, sink.sink);

    renderer.sender.send(IPC.paneEnd, { paneId: 8 } satisfies PaneEndEnvelope);

    renderer.sender.send(IPC.paneBytes, {
      type: "output" as const,
      paneId: 9,
      data: new Uint8Array([0x42]),
    } satisfies PaneBytesEnvelope);

    expect(sink.endCalls).toBe(0);
    expect(sink.writes).toHaveLength(1);
    expect(Array.from(sink.writes[0])).toEqual([0x42]);
  });

  it("refuses a second concurrent receiver for the same (ipcRenderer, paneId)", () => {
    const hub = createIpcHub();
    const renderer = hub.createRenderer();
    const sink = createRecordingSink();
    createPaneBytesReceiver(renderer.ipcRenderer, 30, sink.sink);

    expect(() =>
      createPaneBytesReceiver(renderer.ipcRenderer, 30, sink.sink),
    ).toThrow(BridgeError);
    expect(() =>
      createPaneBytesReceiver(renderer.ipcRenderer, 30, sink.sink),
    ).toThrow(/BRIDGE_PANE_SINK_ALREADY_ATTACHED/);
  });

  it("frees the (ipcRenderer, paneId) slot on disposer so a rotated receiver can attach", () => {
    const hub = createIpcHub();
    const renderer = hub.createRenderer();
    const sink = createRecordingSink();
    const dispose = createPaneBytesReceiver(
      renderer.ipcRenderer,
      31,
      sink.sink,
    );

    dispose();

    expect(() =>
      createPaneBytesReceiver(renderer.ipcRenderer, 31, sink.sink),
    ).not.toThrow();
  });

  it("frees the (ipcRenderer, paneId) slot on auto-detach (paneEnd)", () => {
    const hub = createIpcHub();
    const renderer = hub.createRenderer();
    const sink = createRecordingSink();
    createPaneBytesReceiver(renderer.ipcRenderer, 32, sink.sink);

    renderer.sender.send(IPC.paneEnd, { paneId: 32 } satisfies PaneEndEnvelope);

    expect(() =>
      createPaneBytesReceiver(renderer.ipcRenderer, 32, sink.sink),
    ).not.toThrow();
  });
});
