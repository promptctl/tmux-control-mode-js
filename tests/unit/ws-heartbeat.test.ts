// tests/unit/ws-heartbeat.test.ts
// Unit tests for the Heartbeat collaborator extracted from Connection.
import { describe, it, expect, vi, afterEach } from "vitest";
import { Heartbeat } from "../../src/connectors/websocket/heartbeat.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("Heartbeat — disabled", () => {
  it("does not start a timer when intervalMs <= 0", () => {
    vi.useFakeTimers();
    const ping = vi.fn();
    const onTimeout = vi.fn();
    const hb = new Heartbeat(0, 5000, { ping, onTimeout });
    hb.start();
    vi.advanceTimersByTime(60_000);
    expect(ping).not.toHaveBeenCalled();
    expect(onTimeout).not.toHaveBeenCalled();
  });
});

describe("Heartbeat — normal operation", () => {
  it("calls onTick on every tick (before the ping-or-skip decision)", () => {
    vi.useFakeTimers();
    const ticks: number[] = [];
    const ping = vi.fn();
    const onTimeout = vi.fn();
    const hb = new Heartbeat(100, 50, {
      onTick: () => ticks.push(Date.now()),
      ping,
      onTimeout,
    });
    hb.start();
    vi.advanceTimersByTime(350);
    // 3 full intervals (100ms, 200ms, 300ms)
    expect(ticks.length).toBe(3);
  });

  it("sends a ping on first tick and arms a pong deadline", () => {
    vi.useFakeTimers();
    const ping = vi.fn();
    const onTimeout = vi.fn();
    const hb = new Heartbeat(100, 50, { ping, onTimeout });
    hb.start();
    vi.advanceTimersByTime(100);
    expect(ping).toHaveBeenCalledTimes(1);
    // Pong deadline armed — fire it
    vi.advanceTimersByTime(50);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("clears pong deadline when onPong() is called", () => {
    vi.useFakeTimers();
    const ping = vi.fn();
    const onTimeout = vi.fn();
    const hb = new Heartbeat(100, 50, { ping, onTimeout });
    hb.start();
    vi.advanceTimersByTime(100); // ping sent, pong deadline armed
    hb.onPong();                  // peer replied in time
    vi.advanceTimersByTime(50);  // pong deadline would have fired here
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("skips ping on subsequent ticks while pong is still outstanding", () => {
    vi.useFakeTimers();
    const ping = vi.fn();
    const onTimeout = vi.fn();
    const hb = new Heartbeat(100, 200, { ping, onTimeout }); // timeout > 2 intervals
    hb.start();
    vi.advanceTimersByTime(100); // tick 1 — ping sent
    vi.advanceTimersByTime(100); // tick 2 — pong not received, skip ping
    expect(ping).toHaveBeenCalledTimes(1);
  });

  it("sends another ping after pong clears the deadline", () => {
    vi.useFakeTimers();
    const ping = vi.fn();
    const onTimeout = vi.fn();
    const hb = new Heartbeat(100, 200, { ping, onTimeout });
    hb.start();
    vi.advanceTimersByTime(100); // tick 1 — ping #1
    hb.onPong();
    vi.advanceTimersByTime(100); // tick 2 — ping #2 allowed
    expect(ping).toHaveBeenCalledTimes(2);
  });

  it("resumes pinging after a pong timeout (self-heals; does not wedge)", () => {
    vi.useFakeTimers();
    const ping = vi.fn();
    const onTimeout = vi.fn();
    const hb = new Heartbeat(100, 50, { ping, onTimeout });
    hb.start();
    vi.advanceTimersByTime(100); // tick 1 — ping #1
    vi.advanceTimersByTime(50); // deadline expires → onTimeout fires
    expect(onTimeout).toHaveBeenCalledTimes(1);
    // The deadline must have been cleared: the next interval tick sends a
    // fresh ping rather than skipping forever on a stale (expired) deadline.
    vi.advanceTimersByTime(100); // tick 2
    expect(ping).toHaveBeenCalledTimes(2);
  });
});

describe("Heartbeat — correlation token", () => {
  it("clears the deadline only for a pong that matches the outstanding ping", () => {
    vi.useFakeTimers();
    let next = 0;
    const onTimeout = vi.fn();
    const hb = new Heartbeat<string>(100, 50, {
      ping: () => `p${(next += 1)}`,
      onTimeout,
    });
    hb.start();
    vi.advanceTimersByTime(100); // ping "p1" sent, deadline armed
    hb.onPong("stale"); // a mismatched pong must not clear the deadline
    vi.advanceTimersByTime(50);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("clears the deadline when the matching pong arrives", () => {
    vi.useFakeTimers();
    let next = 0;
    const onTimeout = vi.fn();
    const hb = new Heartbeat<string>(100, 50, {
      ping: () => `p${(next += 1)}`,
      onTimeout,
    });
    hb.start();
    vi.advanceTimersByTime(100); // ping "p1"
    hb.onPong("p1");
    vi.advanceTimersByTime(50);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("correlates against the newest ping after a pong cycle", () => {
    vi.useFakeTimers();
    let next = 0;
    const onTimeout = vi.fn();
    const hb = new Heartbeat<string>(100, 50, {
      ping: () => `p${(next += 1)}`,
      onTimeout,
    });
    hb.start();
    vi.advanceTimersByTime(100); // ping "p1"
    hb.onPong("p1"); // cleared
    vi.advanceTimersByTime(100); // ping "p2"
    hb.onPong("p1"); // the *old* id must not clear the new deadline
    vi.advanceTimersByTime(50);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });
});

describe("Heartbeat — stop()", () => {
  it("stop() prevents further ticks", () => {
    vi.useFakeTimers();
    const ping = vi.fn();
    const hb = new Heartbeat(100, 50, { ping, onTimeout: vi.fn() });
    hb.start();
    vi.advanceTimersByTime(100);
    hb.stop();
    vi.advanceTimersByTime(500);
    expect(ping).toHaveBeenCalledTimes(1); // only the tick before stop
  });

  it("stop() clears a pending pong deadline", () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const hb = new Heartbeat(100, 50, { ping: vi.fn(), onTimeout });
    hb.start();
    vi.advanceTimersByTime(100); // ping sent, pong deadline armed
    hb.stop();
    vi.advanceTimersByTime(50); // pong deadline would have fired
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("onPong() after stop() is a no-op (does not throw)", () => {
    vi.useFakeTimers();
    const hb = new Heartbeat(100, 50, { ping: vi.fn(), onTimeout: vi.fn() });
    hb.start();
    hb.stop();
    expect(() => hb.onPong()).not.toThrow();
  });
});
