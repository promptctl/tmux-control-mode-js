// examples/web-multiplexer/web/conformance-store.test.ts
//
// The dashboard store runs the genuine conformance catalogue in-process; this
// asserts it reaches all-green and exposes a correctly-grouped, fully-populated
// view — the same green the unit gate sees, surfaced through the store the React
// view renders. DOM-free, so it runs in the repo's node vitest suite.

import { describe, it, expect } from "vitest";
import { ConformanceStore } from "./conformance-store.ts";

describe("ConformanceStore", () => {
  it("starts idle — construction kicks off no run (learner owns the clock)", () => {
    const store = new ConformanceStore();
    expect(store.running).toBe(false);
    expect(store.summary.total).toBeGreaterThan(0);
    expect(store.summary.pending).toBe(store.summary.total);
    expect(store.allGreen).toBe(false);
    store.dispose();
  });

  it("runs the whole catalogue to all-green", async () => {
    const store = new ConformanceStore();
    await store.runAll();

    expect(store.running).toBe(false);
    expect(store.summary.failed).toBe(0);
    expect(store.summary.passed).toBe(store.summary.total);
    expect(store.allGreen).toBe(true);
    // Every row carries a human-readable verdict detail, pass or fail.
    expect(store.rows.every((r) => r.detail.length > 0)).toBe(true);
    store.dispose();
  });

  it("groups rows across all three observation channels", async () => {
    const store = new ConformanceStore();
    await store.runAll();

    const channels = store.groups.map((g) => g.channel);
    expect(channels).toEqual(["notification", "pane-output", "command"]);
    const total = store.groups.reduce((n, g) => n + g.rows.length, 0);
    expect(total).toBe(store.rows.length);
    store.dispose();
  });

  it("re-entrant runAll is a no-op while a run is in flight", async () => {
    const store = new ConformanceStore();
    const first = store.runAll();
    // Second call before the first settles must not start a competing run.
    await store.runAll();
    await first;
    expect(store.allGreen).toBe(true);
    store.dispose();
  });
});
