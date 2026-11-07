// src/connectors/websocket/reconnect-controller.ts
// [LAW:decomposition] Reconnect scheduling extracted from WebSocketTmuxClient:
// the retry-attempt budget, the backoff-delay computation, and the armed retry
// timer. The owner holds none of this; it asks for a decision and maps the
// result onto connection state.

import {
  DURATION_MAX_MS,
  invalidArg,
  parseDurationMs,
  parser,
  zeroOrDurationMsParser,
  type DurationMs,
} from "./limits.js";
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

// [LAW:parse-dont-validate] The policy as the timer sees it: every field
// resolved and stamped once, in the constructor, so `backoffDelay` computes
// from values a timer honors and never re-applies a default or re-checks a
// range. `maxAttempts: 0` is the off switch, as `0` is for the heartbeat.
interface BackoffSchedule {
  readonly maxAttempts: number;
  readonly initialDelayMs: DurationMs;
  readonly maxDelayMs: DurationMs;
  readonly factor: number;
  readonly jitterMs: 0 | DurationMs;
}

const DEFAULTS = Object.freeze({
  initialDelayMs: 250,
  maxDelayMs: 10_000,
  factor: 2,
  jitterMs: 250,
}) satisfies Record<string, number>;

// [LAW:one-type-per-behavior] The two shapes only a backoff policy has are
// instances of the one parser factory, failing like every consumer option.
const parseMaxAttempts = parser(
  (v): v is number =>
    v === Number.POSITIVE_INFINITY ||
    (Number.isInteger(v) && (v as number) >= 0),
  "0 (no reconnect), a positive integer, or Infinity",
)(invalidArg);
const parseBackoffFactor = parser(
  (v): v is number => typeof v === "number" && Number.isFinite(v) && v >= 1,
  "a finite number >= 1",
)(invalidArg);
const parseJitterMs = zeroOrDurationMsParser("no jitter")(invalidArg);

function resolveSchedule(policy: ReconnectPolicy | undefined): BackoffSchedule {
  const p = policy ?? { maxAttempts: 0 };
  const schedule: BackoffSchedule = {
    maxAttempts: parseMaxAttempts("reconnect.maxAttempts", p.maxAttempts),
    initialDelayMs: parseDurationMs(
      "reconnect.initialDelayMs",
      p.initialDelayMs ?? DEFAULTS.initialDelayMs,
    ),
    maxDelayMs: parseDurationMs(
      "reconnect.maxDelayMs",
      p.maxDelayMs ?? DEFAULTS.maxDelayMs,
    ),
    factor: parseBackoffFactor("reconnect.factor", p.factor ?? DEFAULTS.factor),
    jitterMs: parseJitterMs(
      "reconnect.jitterMs",
      p.jitterMs ?? DEFAULTS.jitterMs,
    ),
  };
  // The largest delay the schedule can produce is the capped base plus the
  // full jitter; past the timer's range Node clamps it to 1 ms, the storm the
  // per-field stamps exist to prevent.
  if (schedule.maxDelayMs + schedule.jitterMs > DURATION_MAX_MS) {
    throw invalidArg(
      `reconnect.maxDelayMs + reconnect.jitterMs (${schedule.maxDelayMs} + ${schedule.jitterMs}) must be at most ${DURATION_MAX_MS}`,
    );
  }
  return schedule;
}

export class ReconnectController {
  private readonly backoff: BackoffSchedule;
  private attempts = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  /** Throws `BRIDGE_INVALID_ARG` naming `reconnect.<field>` and the value for
   *  a policy field outside its shape (see `ReconnectPolicy`). */
  constructor(
    policy: ReconnectPolicy | undefined,
    private readonly handlers: ReconnectHandlers,
  ) {
    this.backoff = resolveSchedule(policy);
  }

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
    const { maxAttempts } = this.backoff;
    if (maxAttempts === 0) {
      return { kind: "disabled" };
    }
    // [LAW:one-source-of-truth] Idempotent while a retry is pending: a second
    // schedule() before the armed timer fires returns the already-scheduled
    // decision rather than burning another attempt and re-arming. This keeps
    // `attempts` = retries actually scheduled, and holds the controller to one
    // armed timer by construction (symmetric with Heartbeat.start()).
    if (this.timer !== null) {
      return { kind: "scheduled", attempt: this.attempts };
    }
    if (this.attempts >= maxAttempts) {
      return { kind: "exhausted", maxAttempts };
    }
    this.attempts += 1;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.handlers.onRetry();
    }, this.backoffDelay());
    (this.timer as unknown as { unref?: () => void }).unref?.();
    return { kind: "scheduled", attempt: this.attempts };
  }

  // Exponential backoff with jitter: the base grows by `factor` per attempt
  // up to `maxDelayMs`, and a uniform draw from [0, jitterMs) is added.
  private backoffDelay(): number {
    const s = this.backoff;
    const base = Math.min(
      s.initialDelayMs * Math.pow(s.factor, this.attempts - 1),
      s.maxDelayMs,
    );
    return base + Math.random() * s.jitterMs;
  }
}
