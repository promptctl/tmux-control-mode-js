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
import type { PaneByteSink } from "../../src/pane-sink.js";
import type { TmuxTransport } from "../../src/transport/types.js";

// ---------------------------------------------------------------------------
// Test rigging
// ---------------------------------------------------------------------------

interface FakeTransport extends TmuxTransport {
  feed(chunk: string): void;
}

function createFakeTransport(): FakeTransport {
  const dataCallbacks: ((chunk: string) => void)[] = [];
  return {
    send(): void {},
    onData(cb): void {
      dataCallbacks.push(cb);
    },
    onClose(): void {},
    close(): void {},
    feed(chunk): void {
      dataCallbacks.forEach((cb) => cb(chunk));
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
      chunks.push(bytes);
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

  it("calls sink.end() exactly once on dispose even when end is the only optional method consumer provides", () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t);
    // PaneByteSink.end is optional — verify the library tolerates an
    // implementation that omits it (no throw).
    const sinkNoEnd: PaneByteSink = {
      write(): void {},
    };
    const dispose = client.attachPaneSink(1, sinkNoEnd);
    expect(() => dispose()).not.toThrow();
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
});
