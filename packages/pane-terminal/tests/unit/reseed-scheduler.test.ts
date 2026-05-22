// packages/pane-terminal/tests/unit/reseed-scheduler.test.ts
//
// Unit coverage for `ReseedScheduler`. Asserts the [LAW:single-enforcer]
// + [LAW:dataflow-not-control-flow] contracts: one scheduler per client,
// one reconnect handler, sequential dispatch in priority order. Bench gate
// 7 measures the same code from a timing angle; this file pins the order.

import { describe, it, expect } from "vitest";
import { FakeTmuxClient } from "../../src/bench/index.js";
import {
  ReseedScheduler,
  getScheduler,
  type ReseedTarget,
  type ReseedPriority,
  type TmuxClientLike,
} from "../../src/stream/index.js";

class FakeTarget implements ReseedTarget {
  constructor(
    readonly name: string,
    private readonly p: ReseedPriority,
    readonly log: string[],
    readonly delayMs = 0,
  ) {}
  priority(): ReseedPriority {
    return this.p;
  }
  async reseed(): Promise<void> {
    this.log.push(`start:${this.name}`);
    if (this.delayMs > 0) {
      await new Promise((r) => setTimeout(r, this.delayMs));
    } else {
      // Yield once to expose any accidental concurrency.
      await Promise.resolve();
    }
    this.log.push(`end:${this.name}`);
  }
}

describe("ReseedScheduler — module-scope per-client registry", () => {
  it("returns the same scheduler for the same client", () => {
    const client = new FakeTmuxClient();
    const a = getScheduler(client);
    const b = getScheduler(client);
    expect(a).toBe(b);
  });

  it("returns distinct schedulers for distinct clients", () => {
    const c1 = new FakeTmuxClient();
    const c2 = new FakeTmuxClient();
    const a = getScheduler(c1);
    const b = getScheduler(c2);
    expect(a).not.toBe(b);
  });
});

describe("ReseedScheduler — dispatch order", () => {
  it("dispatches in priority order: visible (0) → other-attached (1)", async () => {
    const log: string[] = [];
    const sched = new ReseedScheduler(
      { on: () => undefined, off: () => undefined } as unknown as TmuxClientLike,
    );
    sched.register(new FakeTarget("h1", 1, log));
    sched.register(new FakeTarget("v", 0, log));
    sched.register(new FakeTarget("h2", 1, log));

    await sched.runReseed();

    // Visible MUST be first; the two hidden may be in registration order
    // (sort is stable in V8 for equal-priority items).
    expect(log[0]).toBe("start:v");
    expect(log[1]).toBe("end:v");
    expect(log.slice(2)).toEqual(["start:h1", "end:h1", "start:h2", "end:h2"]);
  });

  it("skips detached (priority 2) targets entirely", async () => {
    const log: string[] = [];
    const sched = new ReseedScheduler(
      { on: () => undefined, off: () => undefined } as unknown as TmuxClientLike,
    );
    sched.register(new FakeTarget("v", 0, log));
    sched.register(new FakeTarget("d", 2, log));

    await sched.runReseed();

    expect(log).toEqual(["start:v", "end:v"]);
  });

  it("dispatches sequentially: never overlaps in-flight reseeds", async () => {
    const log: string[] = [];
    const sched = new ReseedScheduler(
      { on: () => undefined, off: () => undefined } as unknown as TmuxClientLike,
    );
    sched.register(new FakeTarget("a", 0, log, 10));
    sched.register(new FakeTarget("b", 0, log, 5));

    await sched.runReseed();

    // No interleaving: end:a must precede start:b (or vice versa). For
    // equal priorities, registration order wins.
    const aStart = log.indexOf("start:a");
    const aEnd = log.indexOf("end:a");
    const bStart = log.indexOf("start:b");
    expect(aStart).toBeLessThan(aEnd);
    expect(aEnd).toBeLessThan(bStart);
  });

  it("coalesces overlapping reseed requests onto the in-flight run", async () => {
    const log: string[] = [];
    const sched = new ReseedScheduler(
      { on: () => undefined, off: () => undefined } as unknown as TmuxClientLike,
    );
    sched.register(new FakeTarget("a", 0, log, 10));
    sched.register(new FakeTarget("b", 0, log, 0));

    const first = sched.runReseed();
    const second = sched.runReseed();
    expect(second).toBe(first);
    await first;

    // Each target was dispatched exactly once across both runReseed calls.
    expect(log.filter((e) => e === "start:a")).toHaveLength(1);
    expect(log.filter((e) => e === "start:b")).toHaveLength(1);
  });

  it("skips a target that unregisters mid-sweep", async () => {
    const log: string[] = [];
    const sched = new ReseedScheduler(
      { on: () => undefined, off: () => undefined } as unknown as TmuxClientLike,
    );
    const t1 = new FakeTarget("first", 0, log, 5);
    const t2 = new FakeTarget("second", 0, log);
    sched.register(t1);
    sched.register(t2);

    const run = sched.runReseed();
    // Unregister t2 BEFORE its turn.
    sched.unregister(t2);
    await run;

    expect(log).toEqual(["start:first", "end:first"]);
  });
});

describe("ReseedScheduler — reconnect wiring", () => {
  it("subscribes to 'reconnected' exactly once per client", () => {
    const handlers: Array<(...args: unknown[]) => void> = [];
    const fakeClient = {
      on(_event: string, handler: (...args: unknown[]) => void) {
        handlers.push(handler);
      },
      off(_event: string, _handler: unknown) { /* no-op */ },
    } as unknown as TmuxClientLike;
    new ReseedScheduler(fakeClient);
    new ReseedScheduler(fakeClient); // separate scheduler, separate handler
    // Each scheduler installs ONE handler; sharing should be by getScheduler,
    // not by re-construction. This test pins that constructor adds one.
    expect(handlers).toHaveLength(2);
  });

  it("getScheduler() across many calls only adds one reconnect handler", () => {
    const handlers: Array<(...args: unknown[]) => void> = [];
    const fakeClient = {
      on(_e: string, h: (...args: unknown[]) => void) {
        handlers.push(h);
      },
      off(_e: string, _h: unknown) {
        /* no-op */
      },
    } as unknown as TmuxClientLike;
    getScheduler(fakeClient);
    getScheduler(fakeClient);
    getScheduler(fakeClient);
    expect(handlers).toHaveLength(1);
  });
});
