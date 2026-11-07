// tests/unit/ws-reconnect-controller.test.ts
// Unit tests for the ReconnectController collaborator extracted from
// WebSocketTmuxClient. Pins the retry-budget accounting, the discriminated
// schedule() decision, and the guarantee that a cancelled retry never fires.
import { describe, it, expect, vi, afterEach } from "vitest";
import { BridgeError } from "../../src/connectors/errors.js";
import { DURATION_MAX_MS } from "../../src/connectors/websocket/limits.js";
import { ReconnectController } from "../../src/connectors/websocket/reconnect-controller.js";
import type { ReconnectPolicy } from "../../src/connectors/websocket/types.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const POLICY: ReconnectPolicy = {
  maxAttempts: 2,
  initialDelayMs: 100,
  maxDelayMs: 1000,
  factor: 2,
  jitterMs: 0,
};

describe("ReconnectController — disabled", () => {
  it("returns 'disabled' when no policy is configured", () => {
    const ctl = new ReconnectController(undefined, { onRetry: vi.fn() });
    expect(ctl.schedule()).toEqual({ kind: "disabled" });
    expect(ctl.isPending()).toBe(false);
  });

  it("returns 'disabled' when maxAttempts <= 0", () => {
    const ctl = new ReconnectController(
      { ...POLICY, maxAttempts: 0 },
      { onRetry: vi.fn() },
    );
    expect(ctl.schedule()).toEqual({ kind: "disabled" });
  });
});

describe("ReconnectController — schedule + budget", () => {
  it("schedules within budget, then reports exhausted", () => {
    vi.useFakeTimers();
    const onRetry = vi.fn();
    const ctl = new ReconnectController(POLICY, { onRetry });

    expect(ctl.schedule()).toEqual({ kind: "scheduled", attempt: 1 });
    expect(ctl.currentAttempt).toBe(1);
    expect(ctl.isPending()).toBe(true);
    vi.advanceTimersByTime(100);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(ctl.isPending()).toBe(false); // timer fired, cleared

    expect(ctl.schedule()).toEqual({ kind: "scheduled", attempt: 2 });
    vi.advanceTimersByTime(1000);
    expect(onRetry).toHaveBeenCalledTimes(2);

    // Budget of 2 is spent.
    expect(ctl.schedule()).toEqual({ kind: "exhausted", maxAttempts: 2 });
  });

  it("uses exponential backoff bounded by maxDelayMs", () => {
    vi.useFakeTimers();
    const onRetry = vi.fn();
    const ctl = new ReconnectController(
      {
        maxAttempts: 5,
        initialDelayMs: 100,
        maxDelayMs: 300,
        factor: 2,
        jitterMs: 0,
      },
      { onRetry },
    );
    ctl.schedule(); // attempt 1 → 100ms
    vi.advanceTimersByTime(99);
    expect(onRetry).toHaveBeenCalledTimes(0);
    vi.advanceTimersByTime(1);
    expect(onRetry).toHaveBeenCalledTimes(1);

    ctl.schedule(); // attempt 2 → 200ms
    vi.advanceTimersByTime(200);
    expect(onRetry).toHaveBeenCalledTimes(2);

    ctl.schedule(); // attempt 3 → 400ms clamped to 300ms
    vi.advanceTimersByTime(300);
    expect(onRetry).toHaveBeenCalledTimes(3);
  });

  it("adds jitter of random * jitterMs on top of the base delay", () => {
    vi.useFakeTimers();
    // Fixed random → a deterministic jitter contribution we can pin exactly.
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const onRetry = vi.fn();
    const ctl = new ReconnectController(
      // base = initial * factor^(attempt-1) = 100 * 1^0 = 100; jitter = 400
      {
        maxAttempts: 5,
        initialDelayMs: 100,
        maxDelayMs: 10_000,
        factor: 1,
        jitterMs: 400,
      },
      { onRetry },
    );
    ctl.schedule(); // delay = 100 + 0.5 * 400 = 300ms
    vi.advanceTimersByTime(299);
    expect(onRetry).toHaveBeenCalledTimes(0);
    vi.advanceTimersByTime(1);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("never exhausts when maxAttempts is Infinity", () => {
    vi.useFakeTimers();
    const ctl = new ReconnectController(
      {
        maxAttempts: Infinity,
        initialDelayMs: 1,
        maxDelayMs: 1,
        factor: 1,
        jitterMs: 0,
      },
      { onRetry: vi.fn() },
    );
    for (let i = 1; i <= 1000; i += 1) {
      const decision = ctl.schedule();
      expect(decision).toEqual({ kind: "scheduled", attempt: i });
      // Fire the retry timer, mirroring the real loop where each retry fires
      // (openSocket → … → finalize) before the next schedule() is called.
      vi.advanceTimersByTime(2);
    }
    ctl.cancel();
  });

  it("is idempotent while a retry is pending: a second schedule() does not burn budget", () => {
    vi.useFakeTimers();
    const ctl = new ReconnectController(POLICY, { onRetry: vi.fn() });
    expect(ctl.schedule()).toEqual({ kind: "scheduled", attempt: 1 });
    // No intervening timer fire — the retry is still pending. A second call
    // must return the same decision and neither advance the budget nor re-arm.
    expect(ctl.schedule()).toEqual({ kind: "scheduled", attempt: 1 });
    expect(ctl.currentAttempt).toBe(1);
    ctl.cancel();
  });
});

// The policy is parsed once, at construction (6sp.1lh): a delay no timer honors
// is an immediate retry storm, a factor below one decays the delay to zero, and
// a NaN budget is unlimited by accident. Each fails here, naming the field.
describe("ReconnectController — the policy is parsed at construction", () => {
  function build(policy: ReconnectPolicy): () => unknown {
    return () => new ReconnectController(policy, { onRetry: vi.fn() });
  }

  it.each([
    [
      "initialDelayMs: 0",
      { ...POLICY, initialDelayMs: 0 },
      "reconnect.initialDelayMs (0) must be an integer number of ms",
    ],
    [
      "initialDelayMs: NaN",
      { ...POLICY, initialDelayMs: Number.NaN },
      "reconnect.initialDelayMs (NaN) must be",
    ],
    [
      "maxDelayMs: -1",
      { ...POLICY, maxDelayMs: -1 },
      "reconnect.maxDelayMs (-1) must be",
    ],
    [
      "jitterMs: -1",
      { ...POLICY, jitterMs: -1 },
      "reconnect.jitterMs (-1) must be 0 (no jitter) or",
    ],
    [
      "factor: 0.5",
      { ...POLICY, factor: 0.5 },
      "reconnect.factor (0.5) must be a finite number >= 1",
    ],
    [
      "factor: Infinity",
      { ...POLICY, factor: Number.POSITIVE_INFINITY },
      "reconnect.factor (Infinity) must be",
    ],
    [
      "maxAttempts: NaN",
      { ...POLICY, maxAttempts: Number.NaN },
      "reconnect.maxAttempts (NaN) must be 0 (no reconnect), a positive integer, or Infinity",
    ],
    [
      "maxAttempts: -1",
      { ...POLICY, maxAttempts: -1 },
      "reconnect.maxAttempts (-1) must be",
    ],
    [
      "maxAttempts: 1.5",
      { ...POLICY, maxAttempts: 1.5 },
      "reconnect.maxAttempts (1.5) must be",
    ],
    [
      "maxDelayMs + jitterMs past the timer clamp",
      { ...POLICY, maxDelayMs: DURATION_MAX_MS, jitterMs: 1 },
      `reconnect.maxDelayMs + reconnect.jitterMs (${DURATION_MAX_MS} + 1) must be at most ${DURATION_MAX_MS}`,
    ],
  ] as const)(
    "%s throws BRIDGE_INVALID_ARG naming the field and value",
    (_, policy, message) => {
      const fn = build(policy);
      expect(fn).toThrow(BridgeError);
      expect(fn).toThrow(/BRIDGE_INVALID_ARG/);
      expect(fn).toThrow(message);
    },
  );

  it("jitterMs: 0 and maxAttempts: Infinity are the documented switches, and construct", () => {
    expect(
      build({ ...POLICY, jitterMs: 0, maxAttempts: Number.POSITIVE_INFINITY }),
    ).not.toThrow();
  });

  it("a policy of only maxAttempts takes the documented defaults", () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const onRetry = vi.fn();
    const ctl = new ReconnectController({ maxAttempts: 1 }, { onRetry });
    ctl.schedule();
    vi.advanceTimersByTime(249);
    expect(onRetry).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onRetry).toHaveBeenCalledOnce();
  });
});

describe("ReconnectController — cancel + reset", () => {
  it("cancel() stops an armed retry from firing", () => {
    vi.useFakeTimers();
    const onRetry = vi.fn();
    const ctl = new ReconnectController(POLICY, { onRetry });
    ctl.schedule();
    expect(ctl.isPending()).toBe(true);
    ctl.cancel();
    expect(ctl.isPending()).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("reset() zeroes the budget and cancels any armed retry", () => {
    vi.useFakeTimers();
    const onRetry = vi.fn();
    const ctl = new ReconnectController(POLICY, { onRetry });
    ctl.schedule(); // attempt 1 (arms a timer)
    ctl.schedule(); // idempotent while pending — still attempt 1
    ctl.reset();
    expect(ctl.currentAttempt).toBe(0);
    expect(ctl.isPending()).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(onRetry).not.toHaveBeenCalled(); // the pre-reset timer was cancelled
    // Fresh budget: schedule starts at attempt 1 again.
    expect(ctl.schedule()).toEqual({ kind: "scheduled", attempt: 1 });
  });
});
