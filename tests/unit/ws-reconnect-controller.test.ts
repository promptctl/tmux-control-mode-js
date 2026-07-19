// tests/unit/ws-reconnect-controller.test.ts
// Unit tests for the ReconnectController collaborator extracted from
// WebSocketTmuxClient. Pins the retry-budget accounting, the discriminated
// schedule() decision, and the guarantee that a cancelled retry never fires.
import { describe, it, expect, vi, afterEach } from "vitest";
import { ReconnectController } from "../../src/connectors/websocket/reconnect-controller.js";
import type { ReconnectPolicy } from "../../src/connectors/websocket/types.js";

afterEach(() => {
  vi.useRealTimers();
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
      { maxAttempts: 5, initialDelayMs: 100, maxDelayMs: 300, factor: 2, jitterMs: 0 },
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
    ctl.schedule(); // attempt 1 (arms timer A)
    ctl.schedule(); // attempt 2 (cancels A, arms timer B)
    ctl.reset();
    expect(ctl.currentAttempt).toBe(0);
    expect(ctl.isPending()).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(onRetry).not.toHaveBeenCalled(); // the pre-reset timer was cancelled
    // Fresh budget: schedule starts at attempt 1 again.
    expect(ctl.schedule()).toEqual({ kind: "scheduled", attempt: 1 });
  });
});
