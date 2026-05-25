// tests/unit/web-contents-sink.test.ts
// Behavior-level tests for `createWebContentsSink` (main.ts) and its
// renderer-side counterpart `createPaneBytesReceiver` (renderer.ts).
//
// What the contract promises:
//   - `write(bytes)` sends one `IPC.paneBytes` frame carrying
//     `{ paneId, data }`, byte-for-byte preserved.
//   - `end()` sends one `IPC.paneEnd` frame carrying `{ paneId }`.
//   - `wc.isDestroyed()` makes both calls no-ops (trust-boundary guard
//     on Electron's WebContents lifecycle).
//   - On the renderer side, `createPaneBytesReceiver` filters every
//     inbound envelope by `paneId`, forwards matching frames into the
//     supplied `PaneByteSink`, auto-detaches on `paneEnd`, and returns
//     an idempotent disposer.
//   - Round-tripped via the shared in-memory IPC hub (which mirrors
//     real Electron's `structuredClone` on every IPC arg), the bytes
//     a main-side sink writes match the bytes a renderer-side sink
//     receives — proving the seam preserves byte identity across the
//     trust boundary.
//
// [LAW:behavior-not-structure] These tests assert the wire contract
// (channel names, envelope shape, byte preservation, filter semantics,
// detach lifecycle), not the closure-internal structure of the
// receiver. A re-implementation that satisfies the contract — for
// example, one that multiplexes a single listener across many
// receivers — passes these tests unchanged.

import { describe, expect, it } from "vitest";

import {
  createWebContentsSink,
  type PaneBytesEnvelope,
  type PaneEndEnvelope,
} from "../../src/connectors/electron/main.js";
import { createPaneBytesReceiver } from "../../src/connectors/electron/renderer.js";
import {
  BridgeError,
  IPC,
  type WebContentsLike,
} from "../../src/connectors/electron/types.js";
import type { PaneByteSink } from "../../src/pane-sink.js";

import { createIpcHub } from "./_helpers/ipc-hub.js";

// ---------------------------------------------------------------------------
// Recording fakes — minimum surface to drive the sink/receiver in isolation.
// ---------------------------------------------------------------------------

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
    once(_event, _listener) {
      // unused in these tests; the destroyed signal is driven directly
    },
    removeListener(_event, _listener) {
      // unused
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

interface RecordingSink {
  readonly sink: PaneByteSink;
  readonly writes: Uint8Array[];
  endCalls: number;
}

function createRecordingSink(): RecordingSink {
  const writes: Uint8Array[] = [];
  let endCalls = 0;
  const sink: PaneByteSink = {
    write(bytes) {
      writes.push(bytes);
    },
    end() {
      endCalls++;
    },
  };
  return {
    sink,
    writes,
    get endCalls() {
      return endCalls;
    },
    set endCalls(v) {
      endCalls = v;
    },
  };
}

// ---------------------------------------------------------------------------
// createWebContentsSink — main-side behavior in isolation.
// ---------------------------------------------------------------------------

describe("createWebContentsSink", () => {
  it("sends one IPC.paneBytes frame per write, byte-for-byte preserved", () => {
    const fake = createFakeWebContents();
    const sink = createWebContentsSink(fake.wc, 42);
    const payload = new Uint8Array([0x00, 0x7f, 0x80, 0xc3, 0xa9, 0xff]);

    sink.write(payload);

    expect(fake.sends).toHaveLength(1);
    expect(fake.sends[0].channel).toBe(IPC.paneBytes);
    const envelope = fake.sends[0].args[0] as PaneBytesEnvelope;
    expect(envelope.paneId).toBe(42);
    expect(envelope.data).toBe(payload); // no copy at the sink seam
    expect(Array.from(envelope.data)).toEqual(Array.from(payload));
  });

  it("sends one IPC.paneEnd frame on end()", () => {
    const fake = createFakeWebContents();
    const sink = createWebContentsSink(fake.wc, 7);

    sink.end?.();

    expect(fake.sends).toHaveLength(1);
    expect(fake.sends[0].channel).toBe(IPC.paneEnd);
    expect(fake.sends[0].args[0]).toEqual({ paneId: 7 } satisfies PaneEndEnvelope);
  });

  it("no-ops on write() and end() when the WebContents is destroyed", () => {
    const fake = createFakeWebContents();
    const sink = createWebContentsSink(fake.wc, 1);
    fake.destroy();

    sink.write(new Uint8Array([0xaa, 0xbb]));
    sink.end?.();

    expect(fake.sends).toHaveLength(0);
  });

  it("emits the paneId from construction on every frame, irrespective of payload size", () => {
    const fake = createFakeWebContents();
    const sink = createWebContentsSink(fake.wc, 99);

    sink.write(new Uint8Array(0));
    sink.write(new Uint8Array([0x01]));
    sink.write(new Uint8Array([0x02, 0x03, 0x04]));

    expect(fake.sends).toHaveLength(3);
    for (const send of fake.sends) {
      const env = send.args[0] as PaneBytesEnvelope;
      expect(env.paneId).toBe(99);
    }
  });

  it("refuses a second concurrent sink for the same (wc, paneId)", () => {
    // The wire envelope is paneId-scoped: a second sink for the same pair
    // would let the first `paneEnd` to land tear down the other's
    // receiver (orphaning byte flow). The constructor throws loudly
    // instead of silently corrupting the stream.
    const fake = createFakeWebContents();
    createWebContentsSink(fake.wc, 11);

    expect(() => createWebContentsSink(fake.wc, 11)).toThrow(BridgeError);
    expect(() => createWebContentsSink(fake.wc, 11)).toThrow(
      /BRIDGE_PANE_SINK_ALREADY_ATTACHED/,
    );
  });

  it("frees the (wc, paneId) slot on end() so a rotated sink can attach", () => {
    const fake = createFakeWebContents();
    const first = createWebContentsSink(fake.wc, 12);

    first.end?.();

    // Slot is free — a second sink for the same pair must construct cleanly.
    expect(() => createWebContentsSink(fake.wc, 12)).not.toThrow();
  });

  it("allows concurrent sinks for the same wc on different paneIds", () => {
    const fake = createFakeWebContents();

    expect(() => createWebContentsSink(fake.wc, 21)).not.toThrow();
    expect(() => createWebContentsSink(fake.wc, 22)).not.toThrow();
    expect(() => createWebContentsSink(fake.wc, 23)).not.toThrow();
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

    const payload = new Uint8Array([0xc3, 0xa9, 0xe2, 0x98, 0x83]); // 'é☃'
    renderer.sender.send(IPC.paneBytes, {
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
      paneId: 4,
      data: new Uint8Array([0x01]),
    } satisfies PaneBytesEnvelope);
    renderer.sender.send(IPC.paneBytes, {
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
    dispose(); // idempotent — must not throw, must not double-detach

    renderer.sender.send(IPC.paneBytes, {
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

    // The receiver is still attached; a subsequent matching frame must land.
    renderer.sender.send(IPC.paneBytes, {
      paneId: 9,
      data: new Uint8Array([0x42]),
    } satisfies PaneBytesEnvelope);

    expect(sink.endCalls).toBe(0);
    expect(sink.writes).toHaveLength(1);
    expect(Array.from(sink.writes[0])).toEqual([0x42]);
  });

  it("refuses a second concurrent receiver for the same (ipcRenderer, paneId)", () => {
    // Symmetric to the main-side check: the wire's `paneEnd` is
    // paneId-scoped, so two receivers for one pair would race the
    // auto-detach. The second constructor throws.
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

// ---------------------------------------------------------------------------
// End-to-end round-trip — main-side sink → IPC hub → renderer-side
// receiver. Asserts byte identity across the structured-clone hop, which
// is the load-bearing claim the seam exists to make.
// ---------------------------------------------------------------------------

describe("WebContentsSink ↔ PaneBytesReceiver round-trip", () => {
  it("delivers bytes across structured-clone IPC without mojibake", () => {
    const hub = createIpcHub();
    const renderer = hub.createRenderer();

    // The hub clones outbound args from the sender's perspective; main-side
    // sends go through `sender.send`, which is what `createWebContentsSink`
    // calls. The renderer-side receiver listens on the same channels.
    const sink = createWebContentsSink(renderer.sender, 21);
    const recv = createRecordingSink();
    createPaneBytesReceiver(renderer.ipcRenderer, 21, recv.sink);

    // Split a multi-byte UTF-8 sequence across two writes — the seam must
    // preserve every byte; downstream sinks (TextStreamSink) own the
    // streaming decode. Here we only assert byte identity.
    const a = new Uint8Array([0xc3]); // leading byte of 'é'
    const b = new Uint8Array([0xa9, 0xe2, 0x98, 0x83]); // ', '☃'
    sink.write(a);
    sink.write(b);
    sink.end?.();

    expect(recv.writes).toHaveLength(2);
    expect(Array.from(recv.writes[0])).toEqual([0xc3]);
    expect(Array.from(recv.writes[1])).toEqual([0xa9, 0xe2, 0x98, 0x83]);
    expect(recv.endCalls).toBe(1);
  });

  it("delivers only the bytes addressed to this paneId when many receivers coexist", () => {
    const hub = createIpcHub();
    const renderer = hub.createRenderer();

    const sinkP1 = createWebContentsSink(renderer.sender, 1);
    const sinkP2 = createWebContentsSink(renderer.sender, 2);
    const recv1 = createRecordingSink();
    const recv2 = createRecordingSink();
    createPaneBytesReceiver(renderer.ipcRenderer, 1, recv1.sink);
    createPaneBytesReceiver(renderer.ipcRenderer, 2, recv2.sink);

    sinkP1.write(new Uint8Array([0x11]));
    sinkP2.write(new Uint8Array([0x22, 0x22]));
    sinkP1.write(new Uint8Array([0x13, 0x14, 0x15]));

    expect(recv1.writes.map((b) => Array.from(b))).toEqual([
      [0x11],
      [0x13, 0x14, 0x15],
    ]);
    expect(recv2.writes.map((b) => Array.from(b))).toEqual([[0x22, 0x22]]);
  });
});
