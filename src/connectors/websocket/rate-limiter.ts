// src/connectors/websocket/rate-limiter.ts
// [LAW:decomposition] Sliding-window call-rate enforcer extracted from
// Connection. Owns `rateWindow`; Connection holds no rate state.
import type { RateLimitConfig } from "./types.js";

export class RateLimiter {
  private readonly window: number[] = [];

  constructor(private readonly cfg: RateLimitConfig | undefined) {}

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
