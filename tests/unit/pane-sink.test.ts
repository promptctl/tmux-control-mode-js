// tests/unit/pane-sink.test.ts
// Behavior-level tests for TmuxClient.attachBytesSink — the scope-based
// pane-byte subscription surface. Tests assert the contract published in
// src/pane-output.ts and the dispatch shape in src/client.ts.
//
// [LAW:behavior-not-structure] These tests assert WHAT the contract promises
//   (sinks see bytes in attachment order; disposers are per-sink and
//   idempotent; server-scope sees all panes; pane-scope isolates), not HOW
//   the registry is implemented.

import { describe, expect, it } from "vitest";

import { TmuxClient } from "../../src/client.js";
import type { BytesSink, ChunkPayload } from "../../src/pane-output.js";
import { paneScope, serverScope } from "../../src/pane-output.js";
import type { TmuxTransport } from "../../src/transport/types.js";

// ---------------------------------------------------------------------------
// Test rigging
// ---------------------------------------------------------------------------

interface FakeTransport extends TmuxTransport {
  feed(chunk: string): void;
  triggerClose(reason?: string): void;
  sentCommands: readonly string[];
}

function createFakeTransport(): FakeTransport {
  const dataCallbacks: ((chunk: string) => void)[] = [];
  const closeCallbacks: ((reason?: string) => void)[] = [];
  const sent: string[] = [];
  return {
    send(command: string) {
      sent.push(command);
      return { ok: true } as const;
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

interface RecordingSink extends BytesSink {
  readonly messages: ChunkPayload[];
  readonly chunks: Uint8Array[];
  readonly endCount: { value: number };
}

function createRecordingSink(): RecordingSink {
  const messages: ChunkPayload[] = [];
  const chunks: Uint8Array[] = [];
  const endCount = { value: 0 };
  return {
    messages,
    chunks,
    endCount,
    write(msg): void {
      // BytesSink contract: msg.data is read-only and not retained past the
      // synchronous call. Copy before retention so assertions survive the frame.
      messages.push({ ...msg, data: msg.data.slice() });
      chunks.push(msg.data.slice());
    },
    end(): void {
      endCount.value += 1;
    },
  };
}

// ---------------------------------------------------------------------------
// attachBytesSink with pane scope — fan-out, disposer semantics, isolation
// ---------------------------------------------------------------------------

describe("TmuxClient.attachBytesSink (pane scope)", () => {
  it("delivers every chunk to every attached sink in attachment order", () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t);
    const a = createRecordingSink();
    const b = createRecordingSink();
    const order: string[] = [];

    const aTagged: BytesSink = {
      write(msg): void { order.push("a"); a.write(msg); },
      end(): void { a.end(); },
    };
    const bTagged: BytesSink = {
      write(msg): void { order.push("b"); b.write(msg); },
      end(): void { b.end(); },
    };
    client.attachBytesSink(aTagged, { scope: paneScope(1) });
    client.attachBytesSink(bTagged, { scope: paneScope(1) });

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
    client.attachBytesSink(sink, { scope: paneScope(1) });

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
    const disposeA = client.attachBytesSink(a, { scope: paneScope(1) });
    client.attachBytesSink(b, { scope: paneScope(1) });

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
    const dispose = client.attachBytesSink(sink, { scope: paneScope(1) });

    dispose();
    dispose();
    dispose();

    expect(sink.endCount.value).toBe(1);
  });

  it("end() is called exactly once on dispose, regardless of how many chunks were written", () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t);
    const sink = createRecordingSink();
    const dispose = client.attachBytesSink(sink, { scope: paneScope(1) });
    t.feed("%output %1 a\n");
    t.feed("%output %1 b\n");
    expect(sink.endCount.value).toBe(0);
    dispose();
    expect(sink.endCount.value).toBe(1);
  });

  it("treats each attachBytesSink call as an independent attachment — same sink twice, same pane", () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t);
    const sink = createRecordingSink();

    const disposeA = client.attachBytesSink(sink, { scope: paneScope(1) });
    const disposeB = client.attachBytesSink(sink, { scope: paneScope(1) });

    t.feed("%output %1 once\n");
    expect(sink.chunks).toHaveLength(2);

    disposeA();
    expect(sink.endCount.value).toBe(1);

    t.feed("%output %1 twice\n");
    expect(sink.chunks).toHaveLength(3);

    disposeB();
    expect(sink.endCount.value).toBe(2);
  });

  it("isolates panes — bytes on pane B do not reach pane A's sink", () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t);
    const aSink = createRecordingSink();
    const bSink = createRecordingSink();
    client.attachBytesSink(aSink, { scope: paneScope(1) });
    client.attachBytesSink(bSink, { scope: paneScope(2) });

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
    client.attachBytesSink(sink, { scope: paneScope(1) });
    t.feed("%output %1 seen\n");

    expect(sink.chunks).toHaveLength(1);
    expect(Array.from(sink.chunks[0])).toEqual([
      ..."seen".split("").map((c) => c.charCodeAt(0)),
    ]);
  });

  it("attaching from inside a sink's own write() does not back-fill the current chunk", () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t);
    const lateSink = createRecordingSink();
    const triggerSink: BytesSink = {
      write(): void {
        if (lateSink.chunks.length === 0) {
          client.attachBytesSink(lateSink, { scope: paneScope(1) });
        }
      },
      end(): void {},
    };
    client.attachBytesSink(triggerSink, { scope: paneScope(1) });

    t.feed("%output %1 first\n");
    t.feed("%output %1 second\n");

    expect(lateSink.chunks).toHaveLength(1);
    expect(Array.from(lateSink.chunks[0])).toEqual([
      ..."second".split("").map((c) => c.charCodeAt(0)),
    ]);
  });
});

// ---------------------------------------------------------------------------
// attachBytesSink with server scope (default) — all-panes multiplexer
// ---------------------------------------------------------------------------

describe("TmuxClient.attachBytesSink (server scope)", () => {
  it("delivers every byte chunk on every pane to the sink", () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t);
    const sink = createRecordingSink();

    client.attachBytesSink(sink);
    t.feed("%output %1 alpha\n");
    t.feed("%output %2 beta\n");
    t.feed("%output %1 gamma\n");

    expect(sink.messages).toHaveLength(3);
    expect(sink.messages.map((m) => m.paneId)).toEqual([1, 2, 1]);
    expect(sink.messages.map((m) => new TextDecoder().decode(m.data))).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
  });

  it("delivers both output and extended-output bytes as ChunkPayload — paneId and data only", () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t);
    const sink = createRecordingSink();
    client.attachBytesSink(sink);

    t.feed("%output %3 plain\n");
    t.feed("%extended-output %3 12345 : with-age\n");

    expect(sink.messages).toHaveLength(2);
    expect(sink.messages[0]?.paneId).toBe(3);
    expect(sink.messages[1]?.paneId).toBe(3);
    expect(new TextDecoder().decode(sink.messages[0]?.data)).toBe("plain");
    expect(new TextDecoder().decode(sink.messages[1]?.data)).toBe("with-age");
  });

  it("server-scope and pane-scope sinks both receive the same chunk", () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t);
    const serverSink = createRecordingSink();
    const paneSink = createRecordingSink();

    client.attachBytesSink(serverSink);
    client.attachBytesSink(paneSink, { scope: paneScope(7) });
    t.feed("%output %7 both\n");

    expect(serverSink.messages).toHaveLength(1);
    expect(paneSink.messages).toHaveLength(1);
    expect(serverSink.messages[0]?.paneId).toBe(7);
    expect(Array.from(paneSink.chunks[0]!)).toEqual([
      ..."both".split("").map((c) => c.charCodeAt(0)),
    ]);
  });

  it("disposer detaches the sink and fires end() once", () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t);
    const sink = createRecordingSink();
    const dispose = client.attachBytesSink(sink);

    t.feed("%output %1 before\n");
    expect(sink.messages).toHaveLength(1);
    expect(sink.endCount.value).toBe(0);

    dispose();
    expect(sink.endCount.value).toBe(1);

    t.feed("%output %1 after\n");
    expect(sink.messages).toHaveLength(1);
    expect(sink.endCount.value).toBe(1);

    // Idempotent: second dispose is a no-op.
    dispose();
    expect(sink.endCount.value).toBe(1);
  });

  it("attaching from inside another sink's write does not back-fill", () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t);
    const late = createRecordingSink();
    const trigger: BytesSink = {
      write(): void {
        if (late.messages.length === 0) {
          client.attachBytesSink(late);
        }
      },
      end(): void {},
    };
    client.attachBytesSink(trigger);

    t.feed("%output %1 first\n");
    t.feed("%output %1 second\n");

    expect(late.messages).toHaveLength(1);
    expect(new TextDecoder().decode(late.messages[0]!.data)).toBe("second");
  });

  it("non-byte messages do not reach the sink", () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t);
    const sink = createRecordingSink();
    client.attachBytesSink(sink);

    t.feed("%window-add @5\n");
    t.feed("%session-changed $1 my-session\n");
    expect(sink.messages).toHaveLength(0);

    t.feed("%output %1 bytes\n");
    expect(sink.messages).toHaveLength(1);
  });

  it("supports multiple server-scope sinks in attachment order", () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t);
    const a = createRecordingSink();
    const b = createRecordingSink();
    const order: string[] = [];
    const aTagged: BytesSink = {
      write(msg): void { order.push("a"); a.write(msg); },
      end(): void { a.end(); },
    };
    const bTagged: BytesSink = {
      write(msg): void { order.push("b"); b.write(msg); },
      end(): void { b.end(); },
    };
    client.attachBytesSink(aTagged);
    client.attachBytesSink(bTagged);

    t.feed("%output %1 x\n");

    expect(order).toEqual(["a", "b"]);
    expect(a.messages).toHaveLength(1);
    expect(b.messages).toHaveLength(1);
  });

  it("explicit serverScope option is equivalent to no option", () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t);
    const a = createRecordingSink();
    const b = createRecordingSink();
    client.attachBytesSink(a);
    client.attachBytesSink(b, { scope: serverScope });

    t.feed("%output %1 ping\n");

    expect(a.messages).toHaveLength(1);
    expect(b.messages).toHaveLength(1);
  });
});
