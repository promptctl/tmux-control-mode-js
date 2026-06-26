// src/connectors/websocket/heartbeat.ts
// [LAW:decomposition] WS ping/pong liveness extracted from Connection. Owns
// the interval timer and pong deadline; Connection holds no heartbeat state.

export interface HeartbeatHandlers {
  /** Called on every tick before the ping-or-skip decision — used by Connection
   *  as the idle-path backstop for the OS-buffer drain sample. */
  onTick?(): void;
  /** Called to send a WS ping. May throw; the heartbeat swallows the error. */
  ping(): void;
  /** Called when the pong deadline expires. */
  onTimeout(): void;
}

export class Heartbeat {
  private timer: ReturnType<typeof setInterval> | null = null;
  private pongDeadline: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly intervalMs: number,
    private readonly timeoutMs: number,
    private readonly handlers: HeartbeatHandlers,
  ) {}

  start(): void {
    if (this.intervalMs <= 0) return;
    this.timer = setInterval(() => {
      this.handlers.onTick?.();
      if (this.pongDeadline !== null) return; // pong still outstanding
      try {
        this.handlers.ping();
      } catch {
        return;
      }
      this.pongDeadline = setTimeout(() => {
        this.handlers.onTimeout();
      }, this.timeoutMs);
      this.pongDeadline.unref?.();
    }, this.intervalMs);
    this.timer.unref?.();
  }

  onPong(): void {
    if (this.pongDeadline !== null) {
      clearTimeout(this.pongDeadline);
      this.pongDeadline = null;
    }
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
  }
}
