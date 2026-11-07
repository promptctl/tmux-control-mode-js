// src/connectors/websocket/heartbeat.ts
// [LAW:decomposition] WS ping/pong liveness extracted from Connection. Owns
// the interval timer and pong deadline; the owner holds no heartbeat state.
//
// [LAW:one-type-per-behavior] One probe type serves both bridge halves. The
// server's transport-level pong carries no correlation id (Token = void); the
// client's app-level pong carries the ping id it answers (Token = string). The
// difference is a value flowing through `ping()`/`onPong()`, not a second
// class — so the outstanding-id bookkeeping lives here, never in the owner.

import type { DurationMs, HeartbeatInterval } from "./limits.js";

/** The cadence a probe runs at: a ping every `intervalMs`, each pong due
 *  within `timeoutMs` of its ping. Both values are stamped by limits.ts, so
 *  a probe cannot be built with a deadline no pong can meet. */
export interface HeartbeatCadence {
  readonly intervalMs: HeartbeatInterval;
  readonly timeoutMs: DurationMs;
}

export interface HeartbeatHandlers<Token> {
  /** Called on every tick before the ping-or-skip decision — used by the
   *  owner as the idle-path backstop for the OS-buffer drain sample. */
  onTick?(): void;
  /** Send a ping and return the correlation token the matching pong will
   *  carry. May throw: a ping the transport refuses is a ping no pong will
   *  answer, so the deadline arms as for one that was sent and `onTimeout`
   *  fires when it expires. */
  ping(): Token;
  /** Called when the pong deadline expires: no matching pong arrived within
   *  `timeoutMs` of the ping, or the transport refused to carry the ping. */
  onTimeout(): void;
}

// The single in-flight ping: its deadline, and the token it was sent with or
// `null` when the transport refused it and no pong can answer.
// [LAW:types-are-the-program] The token is wrapped so a `void` token
// (`undefined`) stays distinct from "no ping was sent"; unwrapped, a bare
// `onPong()` would match a refusal.
interface Inflight<Token> {
  readonly deadline: ReturnType<typeof setTimeout>;
  readonly sent: { readonly token: Token } | null;
}

export class Heartbeat<Token = void> {
  private timer: ReturnType<typeof setInterval> | null = null;
  // [LAW:one-source-of-truth] "Is a ping outstanding" and "which ping" are one
  // value: present while a pong is awaited, null otherwise.
  private inflight: Inflight<Token> | null = null;

  constructor(
    private readonly cadence: HeartbeatCadence,
    private readonly handlers: HeartbeatHandlers<Token>,
  ) {}

  start(): void {
    // [LAW:composability] Idempotent: a second start() without an intervening
    // stop() is a no-op, so the instance owns at most one interval by
    // construction — no leaked timer racing on `inflight`.
    if (this.timer !== null) return;
    // [LAW:dataflow-not-control-flow] The off switch is the cadence type's own
    // literal, read once here where the timer lives; owners call start(),
    // onPong() and stop() the same way whether or not a probe runs.
    if (this.cadence.intervalMs === 0) return;
    this.timer = setInterval(() => {
      this.handlers.onTick?.();
      if (this.inflight !== null) return; // pong still outstanding
      // [LAW:dataflow-not-control-flow] Every tick that pings arms the
      // deadline; the ping's outcome is the value of `sent`, not a branch over
      // whether a deadline exists. One timing path for a refused and a dropped
      // ping keeps the owner's documented bound independent of how the
      // transport fails, which is why a refusal is not reported at once. The
      // error object is not forwarded: liveness is the owner's only question
      // of this probe, and the transports it runs over do not throw from a
      // send once open. [LAW:no-silent-failure]
      let sent: Inflight<Token>["sent"];
      try {
        sent = { token: this.handlers.ping() };
      } catch {
        sent = null;
      }
      const deadline = setTimeout(() => {
        // [LAW:composability] Reset before firing so the probe self-heals: a
        // consumer that keeps the heartbeat running past a missed pong resumes
        // pinging on the next tick instead of wedging on a stale deadline. The
        // collaborator must be correct standalone, not only when the consumer
        // happens to stop-and-rebuild it on timeout.
        this.inflight = null;
        this.handlers.onTimeout();
      }, this.cadence.timeoutMs);
      deadline.unref?.();
      this.inflight = { deadline, sent };
    }, this.cadence.intervalMs);
    this.timer.unref?.();
  }

  // [LAW:types-are-the-program] The token is required exactly when the protocol
  // carries one: `Heartbeat<string>.onPong(id)` must pass its id, while
  // `Heartbeat<void>.onPong()` takes none. The conditional rest-tuple states
  // this precisely — no optional `?` that would let a string-token caller drop
  // the id, and no reliance on the void-parameter-omission rule (which fails
  // when `Token` infers as `any`, e.g. from a test's untyped `ping` mock).
  // The `void` below is the correct discriminant of the "no correlation token"
  // case in a conditional type; `no-invalid-void-type` doesn't model
  // conditional-type checks, and the type is exactly right (token required iff
  // Token is not void). The disable is scoped to this one line.
  // eslint-disable-next-line @typescript-eslint/no-invalid-void-type
  onPong(...args: [Token] extends [void] ? [] : [token: Token]): void;
  onPong(token?: Token): void {
    // [LAW:dataflow-not-control-flow] A pong clears the deadline only of the
    // ping it answers. One that does not match the outstanding token (a stale
    // or duplicate reply) is ignored so it cannot clear a fresh ping's
    // deadline, and no pong matches a ping the transport refused.
    if (this.inflight === null || this.inflight.sent === null) return;
    if (token !== this.inflight.sent.token) return;
    clearTimeout(this.inflight.deadline);
    this.inflight = null;
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.inflight !== null) {
      clearTimeout(this.inflight.deadline);
      this.inflight = null;
    }
  }
}
