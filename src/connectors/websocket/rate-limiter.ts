// src/connectors/websocket/rate-limiter.ts
// [LAW:decomposition] Sliding-window call-rate enforcer extracted from
// Connection. Owns `rateWindow`; Connection holds no rate state.
import type { DurationMs, PositiveInt } from "./limits.js";

/** A consumer's `RateLimitConfig` as `resolveDefaults` parsed it.
 *  [LAW:types-are-the-program] The stamps are why `check()` checks nothing: a
 *  negative or NaN window, or a cap of 0, cannot reach it. */
export interface RateLimit {
  readonly maxCalls: PositiveInt;
  readonly windowMs: DurationMs;
}

export class RateLimiter {
  private readonly window: number[] = [];

  /** `undefined` is unlimited. */
  constructor(private readonly cfg: RateLimit | undefined) {}

  // Returns true and records the call if within limits; false if exceeded.
  check(): boolean {
    if (this.cfg === undefined) return true;
    const now = Date.now();
    const cutoff = now - this.cfg.windowMs;
    while (this.window.length > 0 && (this.window[0] as number) < cutoff) {
      this.window.shift();
    }
    if (this.window.length >= this.cfg.maxCalls) return false;
    this.window.push(now);
    return true;
  }

  // Produces the detail suffix for rate-limit error messages.
  describe(): string {
    if (this.cfg === undefined) return "";
    return ` (${this.cfg.maxCalls}/${this.cfg.windowMs}ms)`;
  }
}
