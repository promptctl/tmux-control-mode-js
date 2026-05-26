// tests/unit/pane-sink.test.ts
// Behavior-level tests for TmuxClient.attachPaneSink — the canonical
// pane-byte subscription surface. Tests assert the contract published in
// src/pane-sink.ts and the dispatch shape in src/client.ts.
//
// [LAW:behavior-not-structure] These tests assert WHAT the contract
// promises (sinks see bytes in attachment order; disposers are per-sink
// and idempotent), not HOW the registry is implemented.

import { describe, expect, it } from "vitest";

import { TmuxClient } from "../../src/client.js";
import type {
  PaneByteMultiplexer,
  PaneByteSink,
} from "../../src/pane-sink.js";
import type { PaneOutputMessage } from "../../src/protocol/types.js";
import type { TmuxTransport } from "../../src/transport/types.js";

// ---------------------------------------------------------------------------
// Test rigging
// ---------------------------------------------------------------------------

interface FakeTransport extends TmuxTransport {
  feed(chunk: string): void;
  triggerClose(reason?: string): void;
  sentCommands: readonly string[];
}

// Faithful TmuxTransport double: stores the close-callback registrations so
// `triggerClose` can fire them, records every `send`, and replays `feed`
// chunks to every registered onData handler. Mirrors the reference fake in
// tests/unit/connection-state.test.ts — keeps these unit tests honest about
// the transport contract even when the suite doesn't exercise close/send
// today.
function createFakeTransport(): FakeTransport {
  const dataCallbacks: ((chunk: string) => void)[] = [];
  const closeCallbacks: ((reason?: string) => void)[] = [];
  const sent: string[] = [];
  return {
    send(command: string): void {
      sent.push(command);
    },
    onData(cb): void {
      dataCallbacks.push(cb);
    },
    onClose(cb): void {
      closeCallbacks.push(cb);
    },
    close(): void {},
    feed(chunk): void {
      dataCallbacks.forEach((cb) => cb(chunk));
    },
    triggerClose(reason): void {
      closeCallbacks.forEach((cb) => cb(reason));
    },
    get sentCommands(): readonly string[] {
      return sent;
    },
  };
}

interface RecordingSink extends PaneByteSink {
  readonly chunks: Uint8Array[];
  readonly endCount: { value: number };
}

function createRecordingSink(): RecordingSink {
  const chunks: Uint8Array[] = [];
  const endCount = { value: 0 };
  return {
    chunks,
    endCount,
    write(bytes): void {
      // Follow the PaneByteSink contract: `bytes` is read-only and not
      // retained past the synchronous call. The recording sink retains
      // its observations, so it copies first. Without this copy the test
      // would rely on an implementation detail (the library not reusing
      // the buffer across chunks), turning a contract assertion into a
      // structural one.
      chunks.push(bytes.slice());
    },
    end(): void {
      endCount.value += 1;
    },
  };
}

// ---------------------------------------------------------------------------
// attachPaneSink — fan-out, disposer semantics, multi-pane independence
// ---------------------------------------------------------------------------

describe("TmuxClient.attachPaneSink", () => {
  it("delivers every chunk to every attached sink in attachment order", () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t);
    const a = createRecordingSink();
    const b = createRecordingSink();
    const order: string[] = [];

    // Wrap write() to observe the dispatch order across sinks per chunk.
    const aTagged: PaneByteSink = {
      write(bytes): void {
        order.push("a");
        a.write(bytes);
      },
    };
    const bTagged: PaneByteSink = {
      write(bytes): void {
        order.push("b");
        b.write(bytes);
      },
    };
    client.attachPaneSink(1, aTagged);
    client.attachPaneSink(1, bTagged);

    t.feed("%output %1 hello\n");
    t.feed("%output %1 world\n");

    expect(a.chunks).toHaveLength(2);
    expect(b.chunks).toHaveLength(2);
    expect(Array.from(a.chunks[0])).toEqual([
      ..."hello".split("").map((c) => c.charCodeAt(0)),
    ]);
    expect(Array.from(b.chunks[0])).toEqual([
      ..."hello".split("").map((c) => c.charCodeAt(0)),
    ]);
    // Attachment order is dispatch order, per-chunk.
    expect(order).toEqual(["a", "b", "a", "b"]);
  });

  it("delivers extended-output bytes through the same sink path", () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t);
    const sink = createRecordingSink();
    client.attachPaneSink(1, sink);

    // %extended-output %paneId age : data
    t.feed("%extended-output %1 100 : hi\n");

    expect(sink.chunks).toHaveLength(1);
    expect(Array.from(sink.chunks[0])).toEqual([
      "h".charCodeAt(0),
      "i".charCodeAt(0),
    ]);
  });

  it("detaching one sink keeps deliveries flowing to the other", () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t);
    const a = createRecordingSink();
    const b = createRecordingSink();
    const disposeA = client.attachPaneSink(1, a);
    client.attachPaneSink(1, b);

    t.feed("%output %1 first\n");
    disposeA();
    t.feed("%output %1 second\n");

    expect(a.chunks).toHaveLength(1);
    expect(b.chunks).toHaveLength(2);
    expect(a.endCount.value).toBe(1);
  });

  it("disposer is idempotent — double-call invokes sink.end() only once", () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t);
    const sink = createRecordingSink();
    const dispose = client.attachPaneSink(1, sink);

    dispose();
    dispose();
    dispose();

    expect(sink.endCount.value).toBe(1);
  });

  it("tolerates sinks that omit the optional end() method", () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t);
    // PaneByteSink.end is optional — verify the library tolerates an
    // implementation that omits it (no throw on dispose).
    const sinkNoEnd: PaneByteSink = {
      write(): void {},
    };
    const dispose = client.attachPaneSink(1, sinkNoEnd);
    expect(() => dispose()).not.toThrow();
  });

  it("treats each attachPaneSink call as an independent attachment — same sink twice, same pane", () => {
    // The per-attachment-token registry guarantees that attaching the same
    // sink instance twice produces two independent attachments: each receives
    // every chunk (so write fires twice per chunk), and each disposer ends
    // only its own attachment (so end fires once per disposer call).
    const t = createFakeTransport();
    const client = new TmuxClient(t);
    const sink = createRecordingSink();

    const disposeA = client.attachPaneSink(1, sink);
    const disposeB = client.attachPaneSink(1, sink);

    t.feed("%output %1 once\n");
    // Two attachments — same sink — so two writes per chunk.
    expect(sink.chunks).toHaveLength(2);

    disposeA();
    expect(sink.endCount.value).toBe(1);

    t.feed("%output %1 twice\n");
    // disposeB still active; one write per chunk now.
    expect(sink.chunks).toHaveLength(3);

    disposeB();
    expect(sink.endCount.value).toBe(2);
  });

  it("isolates panes — bytes on pane B do not reach pane A's sinks", () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t);
    const aSink = createRecordingSink();
    const bSink = createRecordingSink();
    client.attachPaneSink(1, aSink);
    client.attachPaneSink(2, bSink);

    t.feed("%output %1 alpha\n");
    t.feed("%output %2 beta\n");

    expect(aSink.chunks).toHaveLength(1);
    expect(bSink.chunks).toHaveLength(1);
    expect(Array.from(aSink.chunks[0])).toEqual([
      ..."alpha".split("").map((c) => c.charCodeAt(0)),
    ]);
    expect(Array.from(bSink.chunks[0])).toEqual([
      ..."beta".split("").map((c) => c.charCodeAt(0)),
    ]);
  });

  it("attaching after a chunk arrived does not back-fill", () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t);
    const sink = createRecordingSink();

    t.feed("%output %1 missed\n");
    client.attachPaneSink(1, sink);
    t.feed("%output %1 seen\n");

    expect(sink.chunks).toHaveLength(1);
    expect(Array.from(sink.chunks[0])).toEqual([
      ..."seen".split("").map((c) => c.charCodeAt(0)),
    ]);
  });

  it("attaching from inside a sink's own write() does not back-fill the current chunk", () => {
    // Same guarantee, different mutation source: a sink's `write` body
    // calls `attachPaneSink` for a sibling sink. The pre-emit snapshot
    // means the new sink starts receiving from the next chunk, not this
    // one.
    const t = createFakeTransport();
    const client = new TmuxClient(t);
    const lateSink = createRecordingSink();
    const triggerSink: PaneByteSink = {
      write(): void {
        if (lateSink.chunks.length === 0) {
          client.attachPaneSink(1, lateSink);
        }
      },
    };
    client.attachPaneSink(1, triggerSink);

    t.feed("%output %1 first\n");
    t.feed("%output %1 second\n");

    expect(lateSink.chunks).toHaveLength(1);
    expect(Array.from(lateSink.chunks[0])).toEqual([
      ..."second".split("").map((c) => c.charCodeAt(0)),
    ]);
  });
});

// ---------------------------------------------------------------------------
// attachAllPanesSink — multiplexer surface for forwarders
// ---------------------------------------------------------------------------

interface RecordingMux extends PaneByteMultiplexer {
  readonly messages: PaneOutputMessage[];
  readonly endCount: { value: number };
}

function createRecordingMux(): RecordingMux {
  const messages: PaneOutputMessage[] = [];
  const endCount = { value: 0 };
  return {
    messages,
    endCount,
    write(msg): void {
      // Multiplexer contract mirrors the sink: `msg.data` is read-only and
      // not retained past the synchronous call. Copying preserves the
      // assertion when the test outlives the dispatch frame.
      messages.push({ ...msg, data: msg.data.slice() });
    },
    end(): void {
      endCount.value += 1;
    },
  };
}

describe("TmuxClient.attachAllPanesSink", () => {
  it("delivers every byte chunk on every pane to the multiplexer", () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t);
    const mux = createRecordingMux();

    client.attachAllPanesSink(mux);
    t.feed("%output %1 alpha\n");
    t.feed("%output %2 beta\n");
    t.feed("%output %1 gamma\n");

    expect(mux.messages).toHaveLength(3);
    expect(mux.messages.map((m) => m.paneId)).toEqual([1, 2, 1]);
    expect(mux.messages.map((m) => new TextDecoder().decode(m.data))).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
  });

  it("carries the discriminator and age fields for extended-output", () => {
    // The multiplexer surface exists because forwarders need the full
    // PaneOutputMessage (type discriminator + age) to faithfully reconstruct
    // the message downstream. Per-pane PaneByteSinks intentionally drop
    // these; the multiplexer must not.
    const t = createFakeTransport();
    const client = new TmuxClient(t);
    const mux = createRecordingMux();
    client.attachAllPanesSink(mux);

    t.feed("%output %3 plain\n");
    // %extended-output wire format: `%<paneId> <age> [reserved...] : <value>`
    t.feed("%extended-output %3 12345 : with-age\n");

    expect(mux.messages).toHaveLength(2);
    expect(mux.messages[0]?.type).toBe("output");
    expect(mux.messages[1]?.type).toBe("extended-output");
    if (mux.messages[1]?.type === "extended-output") {
      expect(mux.messages[1].age).toBe(12345);
    }
  });

  it("multiplexer and per-pane sinks both receive the same chunk", () => {
    // Both attachment kinds fire from the same dispatch frame. A consumer
    // mixing the two (e.g. xterm sink for visible rendering, multiplexer
    // for archive forwarding) must see every chunk on both surfaces.
    const t = createFakeTransport();
    const client = new TmuxClient(t);
    const mux = createRecordingMux();
    const sink = createRecordingSink();

    client.attachAllPanesSink(mux);
    client.attachPaneSink(7, sink);
    t.feed("%output %7 both\n");

    expect(mux.messages).toHaveLength(1);
    expect(sink.chunks).toHaveLength(1);
    expect(mux.messages[0]?.paneId).toBe(7);
    expect(Array.from(sink.chunks[0]!)).toEqual([
      ..."both".split("").map((c) => c.charCodeAt(0)),
    ]);
  });

  it("disposer detaches the multiplexer and fires end() once", () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t);
    const mux = createRecordingMux();
    const dispose = client.attachAllPanesSink(mux);

    t.feed("%output %1 before\n");
    expect(mux.messages).toHaveLength(1);
    expect(mux.endCount.value).toBe(0);

    dispose();
    expect(mux.endCount.value).toBe(1);

    t.feed("%output %1 after\n");
    // Detached: no further delivery, and end() does not fire again.
    expect(mux.messages).toHaveLength(1);
    expect(mux.endCount.value).toBe(1);

    // Idempotent: second dispose is a no-op.
    dispose();
    expect(mux.endCount.value).toBe(1);
  });

  it("attaching from inside another multiplexer's write does not back-fill", () => {
    // Same pre-dispatch snapshot guarantee as the per-pane path: the set
    // of multiplexers iterated for a chunk is fixed at chunk arrival.
    const t = createFakeTransport();
    const client = new TmuxClient(t);
    const late = createRecordingMux();
    const trigger: PaneByteMultiplexer = {
      write(): void {
        if (late.messages.length === 0) {
          client.attachAllPanesSink(late);
        }
      },
    };
    client.attachAllPanesSink(trigger);

    t.feed("%output %1 first\n");
    t.feed("%output %1 second\n");

    expect(late.messages).toHaveLength(1);
    expect(new TextDecoder().decode(late.messages[0]!.data)).toBe("second");
  });

  it("non-byte messages do not reach the multiplexer", () => {
    // The multiplexer is byte-only by contract — the registry's dispatch
    // is gated on `isPaneOutput(msg)`. Non-byte tmux events (window-add,
    // session-changed, etc.) flow through the emitter, not here.
    const t = createFakeTransport();
    const client = new TmuxClient(t);
    const mux = createRecordingMux();
    client.attachAllPanesSink(mux);

    t.feed("%window-add @5\n");
    t.feed("%session-changed $1 my-session\n");
    expect(mux.messages).toHaveLength(0);

    t.feed("%output %1 bytes\n");
    expect(mux.messages).toHaveLength(1);
  });

  it("supports multiple multiplexers in attachment order", () => {
    // Forwarders (a bridge) and observability (a byte counter) might both
    // want all-panes attachment. Each multiplexer is independent.
    const t = createFakeTransport();
    const client = new TmuxClient(t);
    const a = createRecordingMux();
    const b = createRecordingMux();
    const order: string[] = [];
    const aTagged: PaneByteMultiplexer = {
      write(msg): void {
        order.push("a");
        a.messages.push({ ...msg, data: msg.data.slice() });
      },
    };
    const bTagged: PaneByteMultiplexer = {
      write(msg): void {
        order.push("b");
        b.messages.push({ ...msg, data: msg.data.slice() });
      },
    };
    client.attachAllPanesSink(aTagged);
    client.attachAllPanesSink(bTagged);

    t.feed("%output %1 x\n");

    expect(order).toEqual(["a", "b"]);
    expect(a.messages).toHaveLength(1);
    expect(b.messages).toHaveLength(1);
  });
});
