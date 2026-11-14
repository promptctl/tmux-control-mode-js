// tests/unit/ws-rate-limiter.test.ts
// Unit tests for the RateLimiter collaborator extracted from Connection.
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  RateLimiter,
  type RateLimit,
} from "../../src/connectors/websocket/rate-limiter.js";
import {
  parseDurationMs,
  parsePositiveInt,
} from "../../src/connectors/websocket/limits.js";

function limit(maxCalls: number, windowMs: number): RateLimit {
  return {
    maxCalls: parsePositiveInt("maxCalls", maxCalls),
    windowMs: parseDurationMs("windowMs", windowMs),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("RateLimiter — no config", () => {
  it("always allows calls when no config is provided", () => {
    const rl = new RateLimiter(undefined);
    for (let i = 0; i < 1000; i++) {
      expect(rl.check()).toBe(true);
    }
  });

  it("describe() returns empty string", () => {
    expect(new RateLimiter(undefined).describe()).toBe("");
  });
});

describe("RateLimiter — with config", () => {
  it("allows up to maxCalls within the window", () => {
    vi.useFakeTimers();
    const rl = new RateLimiter(limit(3, 1000));
    expect(rl.check()).toBe(true);
    expect(rl.check()).toBe(true);
    expect(rl.check()).toBe(true);
  });

  it("rejects the call that exceeds maxCalls", () => {
    vi.useFakeTimers();
    const rl = new RateLimiter(limit(3, 1000));
    rl.check();
    rl.check();
    rl.check();
    expect(rl.check()).toBe(false);
  });

  it("allows new calls after old ones slide out of the window", () => {
    vi.useFakeTimers();
    const rl = new RateLimiter(limit(2, 500));
    rl.check(); // t=0
    rl.check(); // t=0 — window full
    expect(rl.check()).toBe(false);

    vi.advanceTimersByTime(501); // the two calls at t=0 slide out
    expect(rl.check()).toBe(true);
  });

  it("describe() returns the formatted limit string", () => {
    const rl = new RateLimiter(limit(10, 2000));
    expect(rl.describe()).toBe(" (10/2000ms)");
  });
});
