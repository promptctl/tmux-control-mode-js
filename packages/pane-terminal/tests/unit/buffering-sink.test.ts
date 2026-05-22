// packages/pane-terminal/tests/unit/buffering-sink.test.ts
//
// Unit coverage for `BufferingSink`. Pins the recorder behaviour every
// other gate/test depends on:
//
// - seed/write/resize calls land in their respective arrays in order.
// - write() preserves byte identity (no copy).
// - clear() empties the recorders in place (callers' references stay valid).
// - dispose() turns the sink into a no-op.
// - isVisible() reads the constructor flag and the setVisible() override.
// - concatBytes() yields the byte-stream view tests use for snapshots.

import { describe, it, expect } from "vitest";
import { BufferingSink } from "../../src/sink/index.js";

// seed() carries raw bytes (same kind as write()); these fixtures are ASCII.
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("BufferingSink — recorder behaviour", () => {
  it("records seed/write/resize calls in order", () => {
    const sink = new BufferingSink();
    sink.seed(enc("hello"), { col: 2, row: 3 });
    sink.write(new Uint8Array([1, 2]));
    sink.resize(80, 24);
    sink.write(new Uint8Array([3]));

    expect(sink.seedCalls).toEqual([
      { captured: enc("hello"), cursor: { col: 2, row: 3 } },
    ]);
    expect(sink.writes.map((w) => Array.from(w))).toEqual([[1, 2], [3]]);
    expect(sink.resizeCalls).toEqual([{ cols: 80, rows: 24 }]);
  });

  it("write() preserves byte identity (no copy)", () => {
    const sink = new BufferingSink();
    const buf = new Uint8Array([0xff, 0x80, 0x00]);
    sink.write(buf);
    expect(sink.writes[0]).toBe(buf);
  });

  it("seed() accepts null cursor", () => {
    const sink = new BufferingSink();
    sink.seed(enc("x"), null);
    expect(sink.seedCalls[0].cursor).toBeNull();
  });

  it("clear() empties recorders in place", () => {
    const sink = new BufferingSink();
    const seedRef = sink.seedCalls;
    const writesRef = sink.writes;
    const resizeRef = sink.resizeCalls;

    sink.seed(enc("x"), null);
    sink.write(new Uint8Array([1]));
    sink.resize(10, 10);

    sink.clear();

    expect(sink.seedCalls).toBe(seedRef); // same identity
    expect(sink.writes).toBe(writesRef);
    expect(sink.resizeCalls).toBe(resizeRef);
    expect(seedRef).toEqual([]);
    expect(writesRef).toEqual([]);
    expect(resizeRef).toEqual([]);
    expect(sink.clearCalls).toBe(1);
  });

  it("dispose() makes subsequent calls no-ops", () => {
    const sink = new BufferingSink();
    sink.seed(enc("x"), null);
    sink.dispose();
    expect(sink.disposed).toBe(true);

    sink.seed(enc("y"), null); // no-op
    sink.write(new Uint8Array([1])); // no-op
    sink.resize(80, 24); // no-op
    sink.clear(); // no-op
    expect(sink.seedCalls).toEqual([]);
    expect(sink.writes).toEqual([]);
    expect(sink.resizeCalls).toEqual([]);
    expect(sink.clearCalls).toBe(0); // clear was a no-op too
  });

  it("dispose() is idempotent", () => {
    const sink = new BufferingSink();
    sink.dispose();
    sink.dispose();
    expect(sink.disposeCalls).toBe(1);
  });
});

describe("BufferingSink — visibility", () => {
  it("defaults to visible", () => {
    const sink = new BufferingSink();
    expect(sink.isVisible()).toBe(true);
  });

  it("respects constructor option", () => {
    const sink = new BufferingSink({ visible: false });
    expect(sink.isVisible()).toBe(false);
  });

  it("setVisible() mutates the flag", () => {
    const sink = new BufferingSink({ visible: false });
    sink.setVisible(true);
    expect(sink.isVisible()).toBe(true);
    sink.setVisible(false);
    expect(sink.isVisible()).toBe(false);
  });

  it("disposed sink reports not visible (so the scheduler skips it)", () => {
    const sink = new BufferingSink({ visible: true });
    sink.dispose();
    expect(sink.isVisible()).toBe(false);
  });

  it("setVisible() is a no-op after dispose() (matches the post-dispose contract)", () => {
    const sink = new BufferingSink({ visible: false });
    sink.dispose();
    sink.setVisible(true);
    // dispose locks the sink into "not visible" — setVisible cannot
    // resurrect a disposed sink back into the scheduler's visible lane.
    expect(sink.isVisible()).toBe(false);
  });
});

describe("BufferingSink — concatBytes", () => {
  it("returns an empty array when no writes have happened", () => {
    const sink = new BufferingSink();
    expect(sink.concatBytes()).toEqual(new Uint8Array());
  });

  it("concatenates multiple write() chunks in order", () => {
    const sink = new BufferingSink();
    sink.write(new Uint8Array([1, 2]));
    sink.write(new Uint8Array([3]));
    sink.write(new Uint8Array([4, 5, 6]));
    expect(Array.from(sink.concatBytes())).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("does not see writes that happened before clear()", () => {
    const sink = new BufferingSink();
    sink.write(new Uint8Array([9]));
    sink.clear();
    sink.write(new Uint8Array([1, 2]));
    expect(Array.from(sink.concatBytes())).toEqual([1, 2]);
  });
});
