// tests/unit/line-sink.test.ts
// Unit tests for attachLineSink. Drive a fake client implementing the
// `attachBytesSink` slice and feed constructed PaneOutputMessage instances
// directly — this isolates cross-chunk decode/split semantics from tmux
// chunking behavior. Integration with a real server is exercised in
// tests/integration/line-sink.test.ts.

import { describe, it, expect, vi } from "vitest";
import { attachLineSink } from "../../src/line-sink.js";
import type {
  BytesSink,
  AttachOptions,
  PaneScope,
} from "../../src/pane-output.js";
import { paneScope } from "../../src/pane-output.js";
import type { PaneOutputMessage } from "../../src/protocol/types.js";

// ---------------------------------------------------------------------------
// FakeClient — implements the attachBytesSink slice and routes synchronous
// "writes" to attached sinks whose scope admits the chunk. Scope handling is
// minimal — only `pane` and `server` (default) are honored, which covers the
// cross-chunk / shared-decoder concerns this file exercises.
// ---------------------------------------------------------------------------

interface Attached {
  readonly sink: BytesSink;
  readonly scope: PaneScope;
}

class FakeClient {
  private readonly attached = new Set<Attached>();

  attachBytesSink(sink: BytesSink, options?: AttachOptions): () => void {
    const entry: Attached = {
      sink,
      scope: options?.scope ?? ({ kind: "server" } as const),
    };
    this.attached.add(entry);
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      this.attached.delete(entry);
      entry.sink.end?.();
    };
  }

  /** Dispatch a chunk to every admitting sink. Mirrors SinkRegistry order. */
  deliver(msg: PaneOutputMessage): void {
    const snap = Array.from(this.attached);
    for (const a of snap) {
      if (admits(a.scope, msg.paneId)) a.sink.write(msg);
    }
  }
}

function admits(scope: PaneScope, paneId: number): boolean {
  switch (scope.kind) {
    case "server":
      return true;
    case "pane":
      return scope.paneId === paneId;
    // The unit tests don't drive session/window scopes — full routing is
    // covered by the integration suite against real tmux.
    case "session":
    case "window":
      return false;
  }
}

function out(paneId: number, bytes: number[] | Uint8Array): PaneOutputMessage {
  return {
    type: "output",
    paneId,
    data: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
  };
}

// ---------------------------------------------------------------------------
// LINE-10: single-pane lines
// ---------------------------------------------------------------------------

describe("attachLineSink (unit)", () => {
  it("LINE-10: emits one event per LF-terminated line, no trailing newline", () => {
    const client = new FakeClient();
    const events: { line: string; paneId: number }[] = [];
    attachLineSink(client, (e) => events.push({ ...e }), {
      scope: paneScope(1),
    });

    client.deliver(out(1, Buffer.from("line one\nline two\n")));

    expect(events).toEqual([
      { line: "line one", paneId: 1 },
      { line: "line two", paneId: 1 },
    ]);
  });

  // LINE-11: cross-chunk line (split mid-line across two %output chunks)
  it("LINE-11: joins a line split across two chunks", () => {
    const client = new FakeClient();
    const events: { line: string; paneId: number }[] = [];
    attachLineSink(client, (e) => events.push({ ...e }), {
      scope: paneScope(1),
    });

    client.deliver(out(1, Buffer.from("hello, ")));
    expect(events).toEqual([]); // no newline yet
    client.deliver(out(1, Buffer.from("world\n")));

    expect(events).toEqual([{ line: "hello, world", paneId: 1 }]);
  });

  // LINE-12: cross-chunk UTF-8 (4-byte emoji split across two chunks)
  it("LINE-12: streaming decoder joins a multi-byte UTF-8 sequence across chunks", () => {
    const client = new FakeClient();
    const events: { line: string; paneId: number }[] = [];
    attachLineSink(client, (e) => events.push({ ...e }), {
      scope: paneScope(1),
    });

    // U+1F4A9 PILE OF POO encodes as F0 9F 92 A9. Split the 4 bytes between
    // two chunks; a non-streaming decoder would emit U+FFFD on each side.
    const emoji = new TextEncoder().encode("\u{1F4A9}");
    expect(emoji.length).toBe(4);
    client.deliver(out(1, emoji.slice(0, 2)));
    client.deliver(out(1, emoji.slice(2)));
    client.deliver(out(1, Buffer.from("\n")));

    expect(events).toEqual([{ line: "\u{1F4A9}", paneId: 1 }]);
  });

  // LINE-13: multiple line consumers, one pane — shared decoder
  it("LINE-13: N consumers on the same pane decode exactly once per chunk", () => {
    const client = new FakeClient();
    const a: string[] = [];
    const b: string[] = [];
    const c: string[] = [];
    attachLineSink(client, (e) => a.push(e.line), { scope: paneScope(1) });
    attachLineSink(client, (e) => b.push(e.line), { scope: paneScope(1) });
    attachLineSink(client, (e) => c.push(e.line), { scope: paneScope(1) });

    // Spy on the prototype to count decode invocations across all instances.
    const spy = vi.spyOn(TextDecoder.prototype, "decode");
    client.deliver(out(1, Buffer.from("only-once\n")));

    expect(a).toEqual(["only-once"]);
    expect(b).toEqual(["only-once"]);
    expect(c).toEqual(["only-once"]);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  // LINE-15: cross-pane scope — paneId carried through dispatch
  it("LINE-15: serverScope receives lines tagged with their paneId", () => {
    const client = new FakeClient();
    const events: { line: string; paneId: number }[] = [];
    attachLineSink(client, (e) => events.push({ ...e }));

    client.deliver(out(1, Buffer.from("from-one\n")));
    client.deliver(out(2, Buffer.from("from-two\n")));

    expect(events).toEqual([
      { line: "from-one", paneId: 1 },
      { line: "from-two", paneId: 2 },
    ]);
  });

  // LINE-15b: separate decoders per pane (no cross-contamination)
  it("LINE-15b: per-pane decoders don't bleed UTF-8 state across panes", () => {
    const client = new FakeClient();
    const events: { line: string; paneId: number }[] = [];
    attachLineSink(client, (e) => events.push({ ...e }));

    // Pane 1 receives the first half of an emoji and never the rest. Pane 2
    // is unaffected — its own decoder is independent.
    const emoji = new TextEncoder().encode("\u{1F4A9}");
    client.deliver(out(1, emoji.slice(0, 2))); // pending in pane 1's decoder
    client.deliver(out(2, Buffer.from("clean\n"))); // pane 2's own decoder

    expect(events).toEqual([{ line: "clean", paneId: 2 }]);
  });

  // LINE-16: buffered tail flush on detach
  it("LINE-16: flushes a partial trailing line through the detaching consumer", () => {
    const client = new FakeClient();
    const events: string[] = [];
    const dispose = attachLineSink(
      client,
      (e) => events.push(e.line),
      { scope: paneScope(1) },
    );

    client.deliver(out(1, Buffer.from("partial")));
    expect(events).toEqual([]);
    dispose();

    expect(events).toEqual(["partial"]);
  });

  // LINE-17: no flush when buffer is empty
  it("LINE-17: no extra event when the buffer is empty on detach", () => {
    const client = new FakeClient();
    const events: string[] = [];
    const dispose = attachLineSink(
      client,
      (e) => events.push(e.line),
      { scope: paneScope(1) },
    );

    client.deliver(out(1, Buffer.from("complete\n")));
    expect(events).toEqual(["complete"]);
    dispose();

    expect(events).toEqual(["complete"]); // no second call
  });

  // LINE-18: detach during dispatch — snapshot protects co-consumers
  it("LINE-18: a consumer disposing inside its handler doesn't starve siblings", () => {
    const client = new FakeClient();
    const aLines: string[] = [];
    const bLines: string[] = [];

    let disposeA: () => void = () => undefined;
    disposeA = attachLineSink(
      client,
      (e) => {
        aLines.push(e.line);
        disposeA();
      },
      { scope: paneScope(1) },
    );
    attachLineSink(client, (e) => bLines.push(e.line), {
      scope: paneScope(1),
    });

    client.deliver(out(1, Buffer.from("shared\n")));

    expect(aLines).toEqual(["shared"]);
    expect(bLines).toEqual(["shared"]);
  });

  // CRLF stripping — TTY output is \r\n
  it("strips a trailing CR so CRLF-terminated lines arrive bare", () => {
    const client = new FakeClient();
    const events: string[] = [];
    attachLineSink(client, (e) => events.push(e.line), {
      scope: paneScope(1),
    });

    client.deliver(out(1, Buffer.from("crlf\r\n")));
    expect(events).toEqual(["crlf"]);
  });

  // Shared buffer across consumers: a partial chunk decoded under N consumers
  // must not be flushed when only one of them detaches.
  it("partial buffer survives when other consumers still admit the pane", () => {
    const client = new FakeClient();
    const a: string[] = [];
    const b: string[] = [];
    const disposeA = attachLineSink(client, (e) => a.push(e.line), {
      scope: paneScope(1),
    });
    attachLineSink(client, (e) => b.push(e.line), { scope: paneScope(1) });

    client.deliver(out(1, Buffer.from("part")));
    disposeA(); // A detaches; B still admits pane 1 → no flush.

    expect(a).toEqual([]);
    expect(b).toEqual([]);

    client.deliver(out(1, Buffer.from("ial\n")));
    expect(b).toEqual(["partial"]);
  });
});
