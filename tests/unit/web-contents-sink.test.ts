// tests/unit/web-contents-sink.test.ts
// Behavior-level tests for `attachWebContentsSink` (main.ts) and its
// renderer-side counterpart `createPaneBytesReceiver` (renderer.ts).
//
// What the contract promises:
//   - `attachWebContentsSink(client, wc, paneId)` attaches an internal
//     sink to `client.attachPaneSink(paneId, ...)` and returns a disposer.
//     The sink reference never escapes — by construction the same wire
//     stream cannot be double-attached.
//   - Each pane chunk delivered through the client becomes one
//     `wc.send(IPC.paneBytes, { paneId, data })` frame, byte-for-byte
//     preserved.
//   - Disposing the attachment calls the internal sink's `end()` exactly
//     once, sending one `wc.send(IPC.paneEnd, { paneId })` frame.
//   - `wc.isDestroyed()` makes both the bytes and end frames no-op
//     (trust-boundary guard on Electron's WebContents lifecycle).
//   - A second concurrent `attachWebContentsSink(client, wc, paneId)`
//     throws `BridgeError("BRIDGE_PANE_SINK_ALREADY_ATTACHED")`. The
//     slot frees on disposer so rotation works.
//   - The disposer is idempotent.
//   - On the renderer side, `createPaneBytesReceiver` filters every
//     inbound envelope by `paneId`, forwards matching frames into the
//     supplied `PaneByteSink`, auto-detaches on `paneEnd`, and returns
//     an idempotent disposer. The same exclusivity rules apply.
//   - Round-tripped via the shared in-memory IPC hub (which mirrors
//     real Electron's `structuredClone` on every IPC arg), the bytes
//     a main-side attachment writes match the bytes a renderer-side sink
//     receives — proving the seam preserves byte identity across the
//     trust boundary.
//
// [LAW:behavior-not-structure] These tests assert the wire contract
// (channel names, envelope shape, byte preservation, filter semantics,
// detach lifecycle, exclusivity), not the closure-internal structure of
// the registry or the receiver. A re-implementation that satisfies the
// contract passes these tests unchanged.

import { describe, expect, it } from "vitest";

import { TmuxClient } from "../../src/client.js";
import {
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
import type { TmuxTransport } from "../../src/transport/types.js";

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
    once() {
      // unused
    },
    removeListener() {
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
  readonly sink: BytesSink;
  readonly writes: Uint8Array[];
  endCalls: number;
}

function createRecordingSink(): RecordingSink {
  const writes: Uint8Array[] = [];
  const state = { endCalls: 0 };
  const sink: BytesSink = {
    write(msg) {
      // Copy: the BytesSink contract is "msg.data is read-only and not
      // retained past write." A recording sink that retains its inputs
      // must copy.
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

/**
 * Octal-escape a byte array into the tmux control-mode `%output` wire form:
 * each byte becomes `\NNN` (3 octal digits). This is the format the parser
 * decodes back into bytes; using it here keeps the test honest about the
 * full path (parser → attach loop → sink → wc.send).
 */
function octEscape(bytes: readonly number[]): string {
  return bytes.map((b) => "\\" + b.toString(8).padStart(3, "0")).join("");
}

// ---------------------------------------------------------------------------
// attachWebContentsSink — main-side behavior in isolation.
// ---------------------------------------------------------------------------

describe("attachWebContentsSink", () => {
  it("forwards every pane chunk as one IPC.paneBytes frame, byte-for-byte", () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    const fake = createFakeWebContents();
    attachWebContentsSink(client, fake.wc, 42);

    const payload = [0x00, 0x7f, 0x80, 0xc3, 0xa9, 0xff];
    t.feed(`%output %42 ${octEscape(payload)}\n`);

    expect(fake.sends).toHaveLength(1);
    expect(fake.sends[0].channel).toBe(IPC.paneBytes);
    const envelope = fake.sends[0].args[0] as PaneBytesEnvelope;
    expect(envelope.paneId).toBe(42);
    expect(Array.from(envelope.data)).toEqual(payload);
  });

  it("emits one IPC.paneEnd frame when the disposer is invoked", () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    const fake = createFakeWebContents();
    const dispose = attachWebContentsSink(client, fake.wc, 7);

    dispose();

    expect(fake.sends).toHaveLength(1);
    expect(fake.sends[0].channel).toBe(IPC.paneEnd);
    expect(fake.sends[0].args[0]).toEqual({
      paneId: 7,
    } satisfies PaneEndEnvelope);
  });

  it("no-ops on pane bytes and on disposer-fired end when the WebContents is destroyed", () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    const fake = createFakeWebContents();
    const dispose = attachWebContentsSink(client, fake.wc, 1);
    fake.destroy();

    t.feed(`%output %1 ${octEscape([0xaa, 0xbb])}\n`);
    dispose();

    expect(fake.sends).toEqual([]);
  });

  it("stops forwarding after the disposer runs", () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    const fake = createFakeWebContents();
    const dispose = attachWebContentsSink(client, fake.wc, 3);

    dispose();
    fake.sends.length = 0; // discard the paneEnd frame
    t.feed(`%output %3 ${octEscape([0x99])}\n`);

    expect(fake.sends).toEqual([]);
  });

  it("returned disposer is idempotent — second call does not re-emit paneEnd", () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    const fake = createFakeWebContents();
    const dispose = attachWebContentsSink(client, fake.wc, 4);

    dispose();
    dispose();
    dispose();

    const endFrames = fake.sends.filter((s) => s.channel === IPC.paneEnd);
    expect(endFrames).toHaveLength(1);
  });

  it("refuses a second concurrent attachment for the same (wc, paneId)", () => {
    // The wire envelope is paneId-scoped: a second attachment for the
    // same pair would race the first `paneEnd` to land and orphan the
    // other's byte flow. The factory throws loudly instead of silently
    // corrupting the stream.
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    const fake = createFakeWebContents();
    attachWebContentsSink(client, fake.wc, 11);

    expect(() => attachWebContentsSink(client, fake.wc, 11)).toThrow(
      BridgeError,
    );
    expect(() => attachWebContentsSink(client, fake.wc, 11)).toThrow(
      /BRIDGE_PANE_SINK_ALREADY_ATTACHED/,
    );
  });

  it("frees the (wc, paneId) slot on disposer so a rotated attachment can attach", () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    const fake = createFakeWebContents();
    const dispose = attachWebContentsSink(client, fake.wc, 12);

    dispose();

    expect(() => attachWebContentsSink(client, fake.wc, 12)).not.toThrow();
  });

  it("allows concurrent attachments for the same wc on different paneIds", () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    const fake = createFakeWebContents();

    expect(() => attachWebContentsSink(client, fake.wc, 21)).not.toThrow();
    expect(() => attachWebContentsSink(client, fake.wc, 22)).not.toThrow();
    expect(() => attachWebContentsSink(client, fake.wc, 23)).not.toThrow();
  });

  it("never exposes a reusable PaneByteSink: only the disposer escapes", () => {
    // Compile-time check: the return type is `() => void`, not
    // `PaneByteSink`. This test makes the API guarantee visible at the
    // value level too — calling the disposer and trying to invoke
    // anything `PaneByteSink`-ish on the returned value would not
    // typecheck. Here we just confirm the runtime shape is a callable.
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    const fake = createFakeWebContents();
    const result: unknown = attachWebContentsSink(client, fake.wc, 30);
    expect(typeof result).toBe("function");
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
    dispose(); // idempotent — must not throw, must not double-detach

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

    // The receiver is still attached; a subsequent matching frame must land.
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
// End-to-end round-trip — main-side attachment → IPC hub → renderer-side
// receiver. Asserts byte identity across the structured-clone hop, which
// is the load-bearing claim the seam exists to make.
// ---------------------------------------------------------------------------

describe("attachWebContentsSink ↔ PaneBytesReceiver round-trip", () => {
  it("delivers bytes across structured-clone IPC without mojibake", () => {
    const hub = createIpcHub();
    const renderer = hub.createRenderer();
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);

    attachWebContentsSink(client, renderer.sender, 21);
    const recv = createRecordingSink();
    createPaneBytesReceiver(renderer.ipcRenderer, 21, recv.sink);

    // Split a multi-byte UTF-8 sequence across two pane chunks — the seam
    // must preserve every byte; downstream sinks (TextStreamSink) own the
    // streaming decode. Here we only assert byte identity.
    t.feed(`%output %21 ${octEscape([0xc3])}\n`); // leading byte of 'é'
    t.feed(`%output %21 ${octEscape([0xa9, 0xe2, 0x98, 0x83])}\n`); // ', '☃'

    expect(recv.writes).toHaveLength(2);
    expect(Array.from(recv.writes[0])).toEqual([0xc3]);
    expect(Array.from(recv.writes[1])).toEqual([0xa9, 0xe2, 0x98, 0x83]);
  });

  it("delivers only the bytes addressed to this paneId when many attachments coexist", () => {
    const hub = createIpcHub();
    const renderer = hub.createRenderer();
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);

    attachWebContentsSink(client, renderer.sender, 1);
    attachWebContentsSink(client, renderer.sender, 2);
    const recv1 = createRecordingSink();
    const recv2 = createRecordingSink();
    createPaneBytesReceiver(renderer.ipcRenderer, 1, recv1.sink);
    createPaneBytesReceiver(renderer.ipcRenderer, 2, recv2.sink);

    t.feed(`%output %1 ${octEscape([0x11])}\n`);
    t.feed(`%output %2 ${octEscape([0x22, 0x22])}\n`);
    t.feed(`%output %1 ${octEscape([0x13, 0x14, 0x15])}\n`);

    expect(recv1.writes.map((b) => Array.from(b))).toEqual([
      [0x11],
      [0x13, 0x14, 0x15],
    ]);
    expect(recv2.writes.map((b) => Array.from(b))).toEqual([[0x22, 0x22]]);
  });

  it("disposer fires paneEnd which auto-detaches the renderer-side receiver", () => {
    const hub = createIpcHub();
    const renderer = hub.createRenderer();
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);

    const dispose = attachWebContentsSink(client, renderer.sender, 50);
    const recv = createRecordingSink();
    createPaneBytesReceiver(renderer.ipcRenderer, 50, recv.sink);

    t.feed(`%output %50 ${octEscape([0xab])}\n`);
    dispose();

    expect(recv.writes.map((b) => Array.from(b))).toEqual([[0xab]]);
    expect(recv.endCalls).toBe(1);

    // After dispose, the receiver has auto-detached. Even if the renderer
    // re-attaches a fresh receiver, no further frames will arrive because
    // the main-side attachment is gone — drive a stray pane chunk to
    // confirm the absence.
    const recv2 = createRecordingSink();
    createPaneBytesReceiver(renderer.ipcRenderer, 50, recv2.sink);
    t.feed(`%output %50 ${octEscape([0xcd])}\n`);
    expect(recv2.writes).toEqual([]);
  });
});
