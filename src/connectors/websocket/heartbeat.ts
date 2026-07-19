// src/connectors/websocket/heartbeat.ts
// [LAW:decomposition] WS ping/pong liveness extracted from Connection. Owns
// the interval timer and pong deadline; the owner holds no heartbeat state.
//
// [LAW:one-type-per-behavior] One probe type serves both bridge halves. The
// server's transport-level pong carries no correlation id (Token = void); the
// client's app-level pong carries the ping id it answers (Token = string). The
// difference is a value flowing through `ping()`/`onPong()`, not a second
// class — so the outstanding-id bookkeeping lives here, never in the owner.

export interface HeartbeatHandlers<Token> {
  /** Called on every tick before the ping-or-skip decision — used by the
   *  owner as the idle-path backstop for the OS-buffer drain sample. */
  onTick?(): void;
  /** Send a ping and return the correlation token the matching pong will
   *  carry. May throw; the heartbeat swallows the error and arms no deadline. */
  ping(): Token;
  /** Called when the pong deadline expires. */
  onTimeout(): void;
}

export class Heartbeat<Token = void> {
  private timer: ReturnType<typeof setInterval> | null = null;
  private pongDeadline: ReturnType<typeof setTimeout> | null = null;
  // Meaningful only while `pongDeadline !== null` — the token of the single
  // in-flight ping the next pong must match.
  private outstanding: Token | undefined = undefined;

  constructor(
    private readonly intervalMs: number,
    private readonly timeoutMs: number,
    private readonly handlers: HeartbeatHandlers<Token>,
  ) {}

  start(): void {
    // [LAW:composability] Idempotent: a second start() without an intervening
    // stop() is a no-op, so the instance owns at most one interval by
    // construction — no leaked timer racing on pongDeadline/outstanding.
    if (this.timer !== null) return;
    if (this.intervalMs <= 0) return;
    this.timer = setInterval(() => {
      this.handlers.onTick?.();
      if (this.pongDeadline !== null) return; // pong still outstanding
      let token: Token;
      try {
        token = this.handlers.ping();
      } catch {
        return;
      }
      this.outstanding = token;
      this.pongDeadline = setTimeout(() => {
        // [LAW:composability] Reset before firing so the probe self-heals: a
        // consumer that keeps the heartbeat running past a missed pong resumes
        // pinging on the next tick instead of wedging on a stale deadline. The
        // collaborator must be correct standalone, not only when the consumer
        // happens to stop-and-rebuild it on timeout.
        this.pongDeadline = null;
        this.outstanding = undefined;
        this.handlers.onTimeout();
      }, this.timeoutMs);
      this.pongDeadline.unref?.();
    }, this.intervalMs);
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
    // [LAW:dataflow-not-control-flow] The deadline's presence is the "is a ping
    // outstanding" signal; the token only disambiguates which ping. A pong that
    // does not match the outstanding token (a stale or duplicate reply) is
    // ignored so it cannot clear a fresh ping's deadline.
    if (this.pongDeadline === null) return;
    if (token !== this.outstanding) return;
    clearTimeout(this.pongDeadline);
    this.pongDeadline = null;
    this.outstanding = undefined;
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.pongDeadline !== null) {
      clearTimeout(this.pongDeadline);
      this.pongDeadline = null;
    }
    this.outstanding = undefined;
  }
}
