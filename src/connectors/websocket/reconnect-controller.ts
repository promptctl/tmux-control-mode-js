// src/connectors/websocket/reconnect-controller.ts
// [LAW:decomposition] Reconnect scheduling extracted from WebSocketTmuxClient:
// the retry-attempt budget, the backoff-delay computation, and the armed retry
// timer. The owner holds none of this; it asks for a decision and maps the
// result onto connection state.

import type { ReconnectPolicy } from "./types.js";

// [LAW:dataflow-not-control-flow] The retry-or-stop decision is a value, not a
// tangle of branches in the owner. `schedule()` returns exactly one of these;
// the owner's finalize does an exhaustive switch and nothing else.
export type ReconnectDecision =
  | { readonly kind: "scheduled"; readonly attempt: number }
  | { readonly kind: "exhausted"; readonly maxAttempts: number }
  | { readonly kind: "disabled" };

export interface ReconnectHandlers {
  /** Fired when an armed retry timer expires — the owner reopens the socket. */
  onRetry(): void;
}

export class ReconnectController {
  private attempts = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly policy: ReconnectPolicy | undefined,
    private readonly handlers: ReconnectHandlers,
  ) {}

  /** Attempts used in the current episode — for republishing a reconnecting
   *  state's attempt number alongside a fresh error. */
  get currentAttempt(): number {
    return this.attempts;
  }

  /** A retry timer is armed (no live socket, waiting out backoff). */
  isPending(): boolean {
    return this.timer !== null;
  }

  /** New consumer-initiated episode: reset the retry budget and cancel any
   *  armed retry so a fresh connect() starts from a clean slate. */
  reset(): void {
    this.attempts = 0;
    this.cancel();
  }

  /** Stop a pending retry. Sole owner of the retry timer's teardown, so a
   *  cancelled retry can never fire onRetry after the owner has closed. */
  cancel(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  // [LAW:no-ambient-temporal-coupling] The armed timer is the single owner of
  // the backoff wait; incrementing `attempts` and arming the timer happen here
  // together so the retry budget and the schedule can never disagree.
  schedule(): ReconnectDecision {
    const policy = this.policy;
    if (policy === undefined || policy.maxAttempts <= 0) {
      return { kind: "disabled" };
    }
    if (this.attempts >= policy.maxAttempts) {
      return { kind: "exhausted", maxAttempts: policy.maxAttempts };
    }
    this.attempts += 1;
    const delay = this.backoffDelay(policy);
    // [LAW:one-source-of-truth] The controller owns at most one armed retry;
    // cancel any prior timer so a second schedule() cannot leave two live.
    this.cancel();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.handlers.onRetry();
    }, delay);
    (this.timer as unknown as { unref?: () => void }).unref?.();
    return { kind: "scheduled", attempt: this.attempts };
  }

  private backoffDelay(policy: ReconnectPolicy): number {
    const initial = policy.initialDelayMs ?? 250;
    const max = policy.maxDelayMs ?? 10_000;
    const factor = policy.factor ?? 2;
    const jitter = policy.jitterMs ?? 250;
    const base = Math.min(initial * Math.pow(factor, this.attempts - 1), max);
    return base + Math.random() * jitter;
  }
}
