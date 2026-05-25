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

  it("attaching from inside a deprecated 'output' event handler does not back-fill the current chunk", () => {
    // The deprecated `client.on('output', …)` surface and the sink path
    // coexist for one minor. An event handler that decides to attach a
    // sink in response to a chunk must NOT receive that same chunk — the
    // per-chunk dispatch snapshot is taken BEFORE emit, so handler-side
    // attach calls only affect subsequent chunks.
    const t = createFakeTransport();
    const client = new TmuxClient(t);
    const lateSink = createRecordingSink();

    client.on("output", (msg) => {
      if (msg.paneId === 1 && lateSink.chunks.length === 0) {
        client.attachPaneSink(1, lateSink);
      }
    });

    t.feed("%output %1 first\n");
    t.feed("%output %1 second\n");

    // The handler attached lateSink during the FIRST chunk's emit. lateSink
    // must not see "first" (snapshot was taken pre-emit) but must see
    // "second".
    expect(lateSink.chunks).toHaveLength(1);
    expect(Array.from(lateSink.chunks[0])).toEqual([
      ..."second".split("").map((c) => c.charCodeAt(0)),
    ]);
  });

  it("sink dispatch is resilient to a throwing deprecated 'output' event handler", () => {
    // The canonical sink surface fires BEFORE the deprecated event-emitter
    // path. A misbehaving `client.on('output', …)` listener that throws
    // must not be able to poison the sink path — by the time the throw
    // happens, sinks have already received this chunk.
    const t = createFakeTransport();
    const client = new TmuxClient(t);
    const sink = createRecordingSink();
    client.attachPaneSink(1, sink);
    client.on("output", () => {
      throw new Error("buggy handler");
    });

    expect(() => t.feed("%output %1 hello\n")).toThrow("buggy handler");
    // The throw propagates from the deprecated path, but the sink got
    // its chunk first.
    expect(sink.chunks).toHaveLength(1);
    expect(Array.from(sink.chunks[0])).toEqual([
      ..."hello".split("").map((c) => c.charCodeAt(0)),
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
