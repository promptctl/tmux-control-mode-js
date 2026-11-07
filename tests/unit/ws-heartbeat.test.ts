// tests/unit/ws-heartbeat.test.ts
// Unit tests for the Heartbeat collaborator extracted from Connection.
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  Heartbeat,
  type HeartbeatCadence,
} from "../../src/connectors/websocket/heartbeat.js";
import {
  parseDurationMs,
  parseHeartbeatInterval,
} from "../../src/connectors/websocket/limits.js";

// The probe only accepts a stamped cadence; tests go through the same parser
// the bridge and client do.
function cadence(intervalMs: number, timeoutMs: number): HeartbeatCadence {
  return {
    intervalMs: parseHeartbeatInterval("intervalMs", intervalMs),
    timeoutMs: parseDurationMs("timeoutMs", timeoutMs),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Heartbeat — off", () => {
  it("does not start a timer when the interval is 0, the off switch", () => {
    vi.useFakeTimers();
    const ping = vi.fn();
    const onTimeout = vi.fn();
    const hb = new Heartbeat(cadence(0, 5000), { ping, onTimeout });
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
    const hb = new Heartbeat(cadence(100, 50), {
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
    const hb = new Heartbeat(cadence(100, 50), { ping, onTimeout });
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
    const hb = new Heartbeat(cadence(100, 50), { ping, onTimeout });
    hb.start();
    vi.advanceTimersByTime(100); // ping sent, pong deadline armed
    hb.onPong(); // peer replied in time
    vi.advanceTimersByTime(50); // pong deadline would have fired here
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("skips ping on subsequent ticks while pong is still outstanding", () => {
    vi.useFakeTimers();
    const ping = vi.fn();
    const onTimeout = vi.fn();
    const hb = new Heartbeat(cadence(100, 200), { ping, onTimeout }); // timeout > 2 intervals
    hb.start();
    vi.advanceTimersByTime(100); // tick 1 — ping sent
    vi.advanceTimersByTime(100); // tick 2 — pong not received, skip ping
    expect(ping).toHaveBeenCalledTimes(1);
  });

  it("sends another ping after pong clears the deadline", () => {
    vi.useFakeTimers();
    const ping = vi.fn();
    const onTimeout = vi.fn();
    const hb = new Heartbeat(cadence(100, 200), { ping, onTimeout });
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
    const hb = new Heartbeat(cadence(100, 50), { ping, onTimeout });
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
    const hb = new Heartbeat<string>(cadence(100, 50), {
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
    const hb = new Heartbeat<string>(cadence(100, 50), {
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
    const hb = new Heartbeat<string>(cadence(100, 50), {
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

describe("Heartbeat — start() is idempotent", () => {
  it("a second start() without stop() does not arm a second interval", () => {
    vi.useFakeTimers();
    const ping = vi.fn();
    const hb = new Heartbeat(cadence(100, 50), { ping, onTimeout: vi.fn() });
    hb.start();
    hb.start(); // must be a no-op — not a second racing interval
    vi.advanceTimersByTime(100);
    expect(ping).toHaveBeenCalledTimes(1); // one interval, one ping
  });
});

describe("Heartbeat — ping() throws", () => {
  it("a refused ping is a ping no pong will answer: the deadline arms and onTimeout fires", () => {
    vi.useFakeTimers();
    const ping = vi.fn().mockImplementationOnce(() => {
      throw new Error("send failed");
    });
    const onTimeout = vi.fn();
    const hb = new Heartbeat(cadence(100, 50), { ping, onTimeout });
    hb.start();
    vi.advanceTimersByTime(100); // tick 1 — ping throws; the deadline arms anyway
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(50); // the deadline expires: the same bound a dropped ping gets
    expect(onTimeout).toHaveBeenCalledTimes(1);
    // The probe self-heals as after any timeout: the next tick pings again,
    // and that ping's pong clears its fresh deadline — the refusal left no
    // state behind that a later healthy cycle could trip on.
    vi.advanceTimersByTime(50); // completes tick 2's interval (200ms total)
    expect(ping).toHaveBeenCalledTimes(2);
    hb.onPong();
    vi.advanceTimersByTime(50);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("a pong carrying an id cannot clear the deadline of a ping that was never sent", () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const hb = new Heartbeat<string>(cadence(100, 50), {
      ping: () => {
        throw new Error("send failed");
      },
      onTimeout,
    });
    hb.start();
    vi.advanceTimersByTime(100);
    hb.onPong("stale-id");
    vi.advanceTimersByTime(50);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("a pong carrying no token cannot clear the deadline of a ping that was never sent", () => {
    // The server's probe: pongs carry no id, so "refused" must not look like
    // "sent with a void token" or any pong (an unsolicited one, or a late
    // answer to an earlier ping) would clear a deadline nothing can answer.
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const hb = new Heartbeat(cadence(100, 50), {
      ping: (): void => {
        throw new Error("send failed");
      },
      onTimeout,
    });
    hb.start();
    vi.advanceTimersByTime(100);
    hb.onPong();
    vi.advanceTimersByTime(50);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });
});

describe("Heartbeat — stop() then start()", () => {
  it("re-arms from a clean slate; a stale token cannot clear the new deadline", () => {
    vi.useFakeTimers();
    let next = 0;
    const onTimeout = vi.fn();
    const hb = new Heartbeat<string>(cadence(100, 50), {
      ping: () => `p${(next += 1)}`,
      onTimeout,
    });
    hb.start();
    vi.advanceTimersByTime(100); // ping "p1", deadline armed
    hb.stop(); // clears timer, deadline, and outstanding
    hb.start();
    vi.advanceTimersByTime(100); // ping "p2", deadline armed anew
    // A pong for the pre-restart ping must not clear the new deadline —
    // `outstanding` was reset by stop(), so "p1" no longer matches.
    hb.onPong("p1");
    vi.advanceTimersByTime(50);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });
});

describe("Heartbeat — stop()", () => {
  it("stop() prevents further ticks", () => {
    vi.useFakeTimers();
    const ping = vi.fn();
    const hb = new Heartbeat(cadence(100, 50), { ping, onTimeout: vi.fn() });
    hb.start();
    vi.advanceTimersByTime(100);
    hb.stop();
    vi.advanceTimersByTime(500);
    expect(ping).toHaveBeenCalledTimes(1); // only the tick before stop
  });

  it("stop() clears a pending pong deadline", () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const hb = new Heartbeat(cadence(100, 50), { ping: vi.fn(), onTimeout });
    hb.start();
    vi.advanceTimersByTime(100); // ping sent, pong deadline armed
    hb.stop();
    vi.advanceTimersByTime(50); // pong deadline would have fired
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("onPong() after stop() is a no-op (does not throw)", () => {
    vi.useFakeTimers();
    const hb = new Heartbeat(cadence(100, 50), {
      ping: vi.fn(),
      onTimeout: vi.fn(),
    });
    hb.start();
    hb.stop();
    expect(() => hb.onPong()).not.toThrow();
  });
});
