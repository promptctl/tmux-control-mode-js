// tests/unit/wrapper-tracker.test.ts
//
// Unit-level verification of the bridge listener-bookkeeping helper. Every
// Electron preload that re-exposes `on`/`removeListener` across the
// contextBridge boundary tracks each registration so `removeListener` can
// recover the stable wrapper closure installed on `ipcRenderer.on`. The
// pre-fix WeakMap implementation overwrote on double-subscribe — the
// shipped tracker records every add and pops one per remove.
//
// The helper is the entire behavioral surface for the H5 fix; testing it
// directly keeps these assertions in the fast suite rather than gating
// them on an Electron Playwright boot.

import { describe, expect, it } from "vitest";

import { createWrapperTracker } from "../../src/connectors/electron/wrapper-tracker.js";

describe("WrapperTracker — H5 listener bookkeeping", () => {
  it("starts empty", () => {
    const t = createWrapperTracker<object, string>();
    const fn = {};
    expect(t.size("ch", fn)).toBe(0);
    expect(t.remove("ch", fn)).toBeNull();
  });

  it("add records one wrapper per call (no overwrite on duplicate listener)", () => {
    // PRE-FIX BUG: WeakMap<listener, wrapper> meant two adds collapsed to
    // one slot. Post-fix: each add appends, so size grows.
    const t = createWrapperTracker<object, string>();
    const fn = {};
    t.add("ch", fn, "wrapper-1");
    t.add("ch", fn, "wrapper-2");
    t.add("ch", fn, "wrapper-3");
    expect(t.size("ch", fn)).toBe(3);
  });

  it("remove pops LIFO — mirrors Node EventEmitter remove semantics", () => {
    // EventEmitter's removeListener pulls one binding per call. Tracker
    // uses LIFO so the most recently added wrapper is the first removed,
    // which matches the typical mental model of "undo the last on()".
    const t = createWrapperTracker<object, string>();
    const fn = {};
    t.add("ch", fn, "first");
    t.add("ch", fn, "second");
    t.add("ch", fn, "third");

    expect(t.remove("ch", fn)).toBe("third");
    expect(t.remove("ch", fn)).toBe("second");
    expect(t.remove("ch", fn)).toBe("first");
    expect(t.remove("ch", fn)).toBeNull();
    expect(t.size("ch", fn)).toBe(0);
  });

  it("isolates wrappers per channel", () => {
    const t = createWrapperTracker<object, string>();
    const fn = {};
    t.add("a", fn, "in-a");
    t.add("b", fn, "in-b");
    expect(t.remove("a", fn)).toBe("in-a");
    expect(t.size("a", fn)).toBe(0);
    expect(t.size("b", fn)).toBe(1);
    expect(t.remove("b", fn)).toBe("in-b");
  });

  it("isolates wrappers per listener within a channel", () => {
    const t = createWrapperTracker<object, string>();
    const fnA = {};
    const fnB = {};
    t.add("ch", fnA, "for-A-1");
    t.add("ch", fnA, "for-A-2");
    t.add("ch", fnB, "for-B-1");

    expect(t.remove("ch", fnA)).toBe("for-A-2");
    expect(t.size("ch", fnA)).toBe(1);
    expect(t.size("ch", fnB)).toBe(1);
    expect(t.remove("ch", fnB)).toBe("for-B-1");
    expect(t.size("ch", fnB)).toBe(0);
    expect(t.remove("ch", fnA)).toBe("for-A-1");
  });

  it("remove of an unknown (channel, listener) returns null without throwing", () => {
    const t = createWrapperTracker<object, string>();
    const fn = {};
    expect(t.remove("never-added", fn)).toBeNull();
    t.add("ch", fn, "w");
    expect(t.remove("ch", {})).toBeNull(); // different listener identity
    expect(t.size("ch", fn)).toBe(1); // bookkeeping wasn't disturbed
  });

  it("regression — pre-fix WeakMap behavior would lose all but the last wrapper", () => {
    // This test encodes the bug we fixed: pre-fix, the THIRD add would
    // overwrite the previous wrapper, leaving only one slot. The fact that
    // we can pop three distinct wrappers proves the fix.
    const t = createWrapperTracker<object, string>();
    const fn = {};
    const wrappers = ["alpha", "beta", "gamma"];
    for (const w of wrappers) t.add("ch", fn, w);

    const popped: string[] = [];
    let next: string | null;
    while ((next = t.remove("ch", fn)) !== null) popped.push(next);

    // Order is LIFO; the SET of recovered wrappers must match all three.
    expect(popped.toReversed()).toEqual(wrappers);
  });
});
