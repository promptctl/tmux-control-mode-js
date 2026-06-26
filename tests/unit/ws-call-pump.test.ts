// tests/unit/ws-call-pump.test.ts
// Unit tests for the CallPump collaborator extracted from Connection.
import { describe, it, expect, vi, afterEach } from "vitest";
import { CallPump } from "../../src/connectors/websocket/call-pump.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("CallPump — capacity", () => {
  it("isFull() returns false when below maxInflight", () => {
    const pump = new CallPump(3, 30_000, { onTimeout: vi.fn() });
    expect(pump.isFull()).toBe(false);
    pump.track("a");
    pump.track("b");
    expect(pump.isFull()).toBe(false);
  });

  it("isFull() returns true when at maxInflight", () => {
    const pump = new CallPump(2, 30_000, { onTimeout: vi.fn() });
    pump.track("a");
    pump.track("b");
    expect(pump.isFull()).toBe(true);
  });
});

describe("CallPump — complete()", () => {
  it("returns timing info when the call is still in-flight", () => {
    vi.useFakeTimers();
    const pump = new CallPump(10, 30_000, { onTimeout: vi.fn() });
    pump.track("x");
    const timing = pump.complete("x");
    expect(timing).not.toBeUndefined();
    expect(typeof timing!.startedAt).toBe("number");
  });

  it("removes the call so complete() again returns undefined", () => {
    vi.useFakeTimers();
    const pump = new CallPump(10, 30_000, { onTimeout: vi.fn() });
    pump.track("x");
    pump.complete("x");
    expect(pump.complete("x")).toBeUndefined();
  });

  it("returns undefined for an id that was never tracked", () => {
    const pump = new CallPump(10, 30_000, { onTimeout: vi.fn() });
    expect(pump.complete("nonexistent")).toBeUndefined();
  });
});

describe("CallPump — timeout race", () => {
  it("fires onTimeout with id and startedAt when timeout expires", () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const pump = new CallPump(10, 100, { onTimeout });
    pump.track("req1");
    vi.advanceTimersByTime(100);
    expect(onTimeout).toHaveBeenCalledOnce();
    expect(onTimeout.mock.calls[0]![0]).toBe("req1");
    expect(typeof onTimeout.mock.calls[0]![1]).toBe("number");
  });

  it("complete() before timeout prevents onTimeout from firing", () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const pump = new CallPump(10, 100, { onTimeout });
    pump.track("req1");
    pump.complete("req1");
    vi.advanceTimersByTime(100);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("complete() after timeout returns undefined (timeout already replied)", () => {
    vi.useFakeTimers();
    const pump = new CallPump(10, 100, { onTimeout: vi.fn() });
    pump.track("req1");
    vi.advanceTimersByTime(100);
    expect(pump.complete("req1")).toBeUndefined();
  });

  it("isFull() returns false after timeout clears the call", () => {
    vi.useFakeTimers();
    const pump = new CallPump(1, 100, { onTimeout: vi.fn() });
    pump.track("x");
    expect(pump.isFull()).toBe(true);
    vi.advanceTimersByTime(100);
    expect(pump.isFull()).toBe(false);
  });
});

describe("CallPump — drain()", () => {
  it("calls onReject for every in-flight id and clears the map", () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const pump = new CallPump(10, 30_000, { onTimeout });
    pump.track("a");
    pump.track("b");
    pump.track("c");

    const rejected: string[] = [];
    pump.drain((id) => rejected.push(id));
    expect(rejected.sort()).toEqual(["a", "b", "c"]);
    expect(pump.isFull()).toBe(false);
  });

  it("prevents timeout callbacks from firing after drain()", () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const pump = new CallPump(10, 100, { onTimeout });
    pump.track("a");
    pump.drain(vi.fn());
    vi.advanceTimersByTime(100);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("drain() on empty pump is a no-op", () => {
    const pump = new CallPump(10, 100, { onTimeout: vi.fn() });
    const onReject = vi.fn();
    expect(() => pump.drain(onReject)).not.toThrow();
    expect(onReject).not.toHaveBeenCalled();
  });
});
