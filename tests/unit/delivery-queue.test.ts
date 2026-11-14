// tests/unit/delivery-queue.test.ts
// DeliveryQueue's contract: consumer code runs once the outermost step has
// committed, in commit order; a missing step is loud; a throwing delivery is
// reported and costs nothing else.

import { describe, expect, it, vi } from "vitest";

import { DeliveryQueue } from "../../src/delivery-queue.js";

function collecting() {
  const reported: unknown[] = [];
  return { q: new DeliveryQueue((e) => reported.push(e)), reported };
}

describe("DeliveryQueue", () => {
  it("delivers a step's posts once the step has committed, before it returns", () => {
    const { q } = collecting();
    const log: string[] = [];
    q.step(() => {
      q.post((s: string) => log.push(s), "heard");
      log.push("committed");
    });
    log.push("returned");
    expect(log).toEqual(["committed", "heard", "returned"]);
  });

  it("holds a nested step's posts until the outermost step ends", () => {
    const { q } = collecting();
    const log: string[] = [];
    q.step(() => {
      q.step(() => q.post((s: string) => log.push(s), "inner"));
      log.push("outer committed");
    });
    expect(log).toEqual(["outer committed", "inner"]);
  });

  it("queues a step entered from a delivery behind the posts still waiting", () => {
    const { q } = collecting();
    const log: string[] = [];
    q.step(() => {
      q.post(() => {
        log.push("first");
        q.step(() => {
          q.post((s: string) => log.push(s), "reentered");
          log.push("reentry committed");
        });
      }, undefined);
      q.post((s: string) => log.push(s), "second");
    });
    expect(log).toEqual(["first", "reentry committed", "second", "reentered"]);
  });

  it("refuses a post outside any step", () => {
    const { q } = collecting();
    expect(() => q.post(() => {}, undefined)).toThrow(/outside a step/);
  });

  it("reports a post from a delivery that entered no step", () => {
    const { q, reported } = collecting();
    q.step(() => q.post(() => q.post(() => {}, undefined), undefined));
    expect(reported).toHaveLength(1);
    expect(String(reported[0])).toMatch(/outside a step/);
  });

  it("reports a throwing delivery, delivers the rest, and returns the step's value", () => {
    const { q, reported } = collecting();
    const log: string[] = [];
    const boom = new Error("boom");
    const value = q.step(() => {
      q.post(() => {
        throw boom;
      }, undefined);
      q.post((s: string) => log.push(s), "still heard");
      return 42;
    });
    expect(value).toBe(42);
    expect(log).toEqual(["still heard"]);
    expect(reported).toEqual([boom]);
  });

  it("a reporter that throws ends that drain; the next step delivers what was waiting", () => {
    const rethrow = new DeliveryQueue((e) => {
      throw e;
    });
    const log: string[] = [];
    const boom = new Error("boom");
    expect(() =>
      rethrow.step(() => {
        rethrow.post(() => {
          throw boom;
        }, undefined);
        rethrow.post((s: string) => log.push(s), "waiting");
      }),
    ).toThrow(boom);
    expect(log).toEqual([]);
    rethrow.step(() => rethrow.post((s: string) => log.push(s), "next"));
    expect(log).toEqual(["waiting", "next"]);
  });

  it("delivers what a throwing transition committed, then propagates its error", () => {
    const { q, reported } = collecting();
    const log: string[] = [];
    const broke = new Error("transition broke");
    expect(() =>
      q.step(() => {
        q.post((s: string) => log.push(s), "committed part");
        throw broke;
      }),
    ).toThrow(broke);
    expect(log).toEqual(["committed part"]);
    expect(reported).toEqual([]);
  });

  it("settles a start that throws synchronously as a failed outcome, in a step", async () => {
    const { q } = collecting();
    const down = new Error("down");
    const log: string[] = [];
    const outcome = await q.settle(
      () => {
        throw down;
      },
      (o) => {
        q.post((s: string) => log.push(s), "heard");
        return o;
      },
    );
    expect(outcome).toEqual({ ok: false, error: down });
    expect(log).toEqual(["heard"]);
  });

  it("reports to the host on a microtask by default", () => {
    const queued: (() => void)[] = [];
    vi.stubGlobal("queueMicrotask", (fn: () => void) => queued.push(fn));
    try {
      const q = new DeliveryQueue();
      const boom = new Error("boom");
      q.step(() =>
        q.post(() => {
          throw boom;
        }, undefined),
      );
      expect(queued).toHaveLength(1);
      expect(() => queued[0]?.()).toThrow(boom);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
