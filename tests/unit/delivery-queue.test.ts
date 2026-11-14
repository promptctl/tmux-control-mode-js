// tests/unit/delivery-queue.test.ts
// DeliveryQueue's contract: consumer code runs once the outermost step has
// committed, in commit order, and a missing step or a throwing delivery is
// loud.

import { describe, expect, it } from "vitest";

import { DeliveryQueue } from "../../src/delivery-queue.js";

describe("DeliveryQueue", () => {
  it("delivers a step's posts once the step has committed, before it returns", () => {
    const q = new DeliveryQueue();
    const log: string[] = [];
    q.step(() => {
      q.post((s: string) => log.push(s), "heard");
      log.push("committed");
    });
    log.push("returned");
    expect(log).toEqual(["committed", "heard", "returned"]);
  });

  it("holds a nested step's posts until the outermost step ends", () => {
    const q = new DeliveryQueue();
    const log: string[] = [];
    q.step(() => {
      q.step(() => q.post((s: string) => log.push(s), "inner"));
      log.push("outer committed");
    });
    expect(log).toEqual(["outer committed", "inner"]);
  });

  it("queues a step entered from a delivery behind the posts still waiting", () => {
    const q = new DeliveryQueue();
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
    const q = new DeliveryQueue();
    expect(() => q.post(() => {}, undefined)).toThrow(/outside a step/);
  });

  it("refuses a post from a delivery that entered no step", () => {
    const q = new DeliveryQueue();
    expect(() =>
      q.step(() => q.post(() => q.post(() => {}, undefined), undefined)),
    ).toThrow(/outside a step/);
  });

  it("delivers the rest of the queue past a throwing delivery, then rethrows it", () => {
    const q = new DeliveryQueue();
    const log: string[] = [];
    const boom = new Error("boom");
    expect(() =>
      q.step(() => {
        q.post(() => {
          throw boom;
        }, undefined);
        q.post((s: string) => log.push(s), "still heard");
      }),
    ).toThrow(boom);
    expect(log).toEqual(["still heard"]);
  });

  it("rethrows every error of one step together", () => {
    const q = new DeliveryQueue();
    const a = new Error("a");
    const b = new Error("b");
    let caught: unknown;
    try {
      q.step(() => {
        q.post(() => {
          throw a;
        }, undefined);
        q.post(() => {
          throw b;
        }, undefined);
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors).toEqual([a, b]);
  });

  it("still announces what a throwing transition committed, and rethrows the transition's error first", () => {
    const q = new DeliveryQueue();
    const log: string[] = [];
    const broke = new Error("transition broke");
    expect(() =>
      q.step(() => {
        q.post((s: string) => log.push(s), "committed part");
        throw broke;
      }),
    ).toThrow(broke);
    expect(log).toEqual(["committed part"]);
  });

  it("returns the transition's value", () => {
    const q = new DeliveryQueue();
    expect(q.step(() => 42)).toBe(42);
  });
});
