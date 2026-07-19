// packages/pane-terminal/tests/unit/first-resize-gate.test.ts
//
// Isolation tests for FirstResizeGate — the pure seed/live-byte ordering state
// machine extracted from XtermSink (GM5 / tmux-complexity-lkg.7). The gate has
// NO DOM, xterm, or rAF dependency, so these tests construct it standalone and
// assert only its observable contract: what it buffers, when it releases, and
// the seed-before-live order it guarantees.
//
// [LAW:behavior-not-structure] Assertions target the public contract
//   (`buffering`, the DrainBatch shapes) — never private fields.

import { describe, it, expect } from "vitest";
import {
  FirstResizeGate,
  DEFAULT_PENDING_WRITES_CAP_BYTES,
} from "../../src/xterm-sink/first-resize-gate.js";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("FirstResizeGate: phase", () => {
  it("starts buffering", () => {
    expect(new FirstResizeGate().buffering).toBe(true);
  });

  it("release() transitions to open", () => {
    const gate = new FirstResizeGate();
    gate.release();
    expect(gate.buffering).toBe(false);
  });

  it("dispose() opens the gate and drops buffered content", () => {
    const gate = new FirstResizeGate();
    gate.bufferSeed({ captured: enc("x"), cursor: null });
    gate.bufferWrite(enc("y"));
    gate.dispose();
    expect(gate.buffering).toBe(false);
    // Nothing left to release.
    expect(gate.release()).toEqual({ seed: null, writes: [] });
  });
});

describe("FirstResizeGate: release ordering", () => {
  it("releases the seed then the buffered writes, in order", () => {
    const gate = new FirstResizeGate();
    const a = enc("a");
    const b = enc("b");
    gate.bufferSeed({ captured: enc("SEED"), cursor: { col: 2, row: 1 } });
    gate.bufferWrite(a);
    gate.bufferWrite(b);
    const batch = gate.release();
    expect(batch.seed).toEqual({
      captured: enc("SEED"),
      cursor: { col: 2, row: 1 },
    });
    // The contract is correct bytes in correct order; whether the gate
    // forwards the buffers by reference or copies them is an implementation
    // choice, so this asserts content+order, not reference identity.
    expect(batch.writes).toEqual([a, b]);
  });

  it("releases a null seed when none was buffered", () => {
    const gate = new FirstResizeGate();
    gate.bufferWrite(enc("only-live"));
    const batch = gate.release();
    expect(batch.seed).toBeNull();
    expect(batch.writes).toEqual([enc("only-live")]);
  });

  it("latest seed wins — a second bufferSeed overwrites the first", () => {
    const gate = new FirstResizeGate();
    gate.bufferSeed({ captured: enc("first"), cursor: null });
    gate.bufferSeed({ captured: enc("second"), cursor: null });
    expect(gate.release().seed).toEqual({
      captured: enc("second"),
      cursor: null,
    });
  });

  it("release() is idempotent — a second call after open returns an empty batch", () => {
    const gate = new FirstResizeGate();
    gate.bufferSeed({ captured: enc("s"), cursor: null });
    gate.bufferWrite(enc("w"));
    gate.release();
    expect(gate.release()).toEqual({ seed: null, writes: [] });
  });
});

describe("FirstResizeGate: byte cap (no-resize safety valve)", () => {
  it("bufferWrite returns null while under the cap and stays buffering", () => {
    const gate = new FirstResizeGate(16);
    expect(gate.bufferWrite(new Uint8Array(8))).toBeNull();
    expect(gate.buffering).toBe(true);
  });

  it("bufferWrite drains and opens once the accumulated bytes cross the cap", () => {
    const gate = new FirstResizeGate(16);
    const seed = { captured: enc("SEED"), cursor: null };
    gate.bufferSeed(seed);
    const c1 = new Uint8Array(8);
    const c2 = new Uint8Array(9); // total 17 > 16 → overflow
    expect(gate.bufferWrite(c1)).toBeNull();
    const overflow = gate.bufferWrite(c2);
    expect(overflow).not.toBeNull();
    // The drain carries the pending seed first, then both chunks in order.
    expect(overflow?.seed).toEqual(seed);
    expect(overflow?.writes).toEqual([c1, c2]);
    // Gate is now open; the buffer is not re-accumulating.
    expect(gate.buffering).toBe(false);
  });

  it("defaults to a multi-MiB cap so the transient attach window never trips it", () => {
    const gate = new FirstResizeGate();
    // One ~1 MiB chunk is far under the default cap.
    expect(gate.bufferWrite(new Uint8Array(1024 * 1024))).toBeNull();
    expect(DEFAULT_PENDING_WRITES_CAP_BYTES).toBeGreaterThan(1024 * 1024);
  });
});

describe("FirstResizeGate: precondition is enforced loudly", () => {
  // Buffering after the gate opened would strand content in a field no later
  // call drains — a silent data loss. The gate throws instead of accepting it.
  it("bufferWrite after release() throws rather than losing the write", () => {
    const gate = new FirstResizeGate();
    gate.release();
    expect(() => gate.bufferWrite(enc("late"))).toThrow(
      /after the gate opened/,
    );
  });

  it("bufferSeed after release() throws rather than losing the seed", () => {
    const gate = new FirstResizeGate();
    gate.release();
    expect(() =>
      gate.bufferSeed({ captured: enc("late"), cursor: null }),
    ).toThrow(/after the gate opened/);
  });

  it("bufferWrite after a cap-forced drain throws", () => {
    const gate = new FirstResizeGate(4);
    gate.bufferWrite(new Uint8Array(8)); // overflow → gate opens
    expect(() => gate.bufferWrite(enc("late"))).toThrow(
      /after the gate opened/,
    );
  });
});
