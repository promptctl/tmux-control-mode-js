// src/connectors/websocket/call-pump.ts
// [LAW:decomposition] Per-call in-flight tracking + timeout race extracted
// from Connection. Owns `inflight`; Connection holds no call-timing state.

export interface CallPumpHandlers {
  /** Fired when a call's timeout expires before `complete()` is called.
   *  `startedAt` is the ms-since-epoch timestamp when the call was tracked. */
  onTimeout(id: string, startedAt: number): void;
}

export class CallPump {
  private readonly inflight = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; startedAt: number }
  >();

  constructor(
    private readonly maxInflight: number,
    private readonly requestTimeoutMs: number,
    private readonly handlers: CallPumpHandlers,
  ) {}

  isFull(): boolean {
    return this.inflight.size >= this.maxInflight;
  }

  // Begin tracking a call and arm its timeout.
  track(id: string): void {
    const startedAt = Date.now();
    const timer = setTimeout(() => {
      if (!this.inflight.has(id)) return;
      this.inflight.delete(id);
      this.handlers.onTimeout(id, startedAt);
    }, this.requestTimeoutMs);
    timer.unref?.();
    this.inflight.set(id, { timer, startedAt });
  }

  // Acknowledge completion. Returns `{startedAt}` if the call was still
  // in-flight; `undefined` if the timeout already fired and replied.
  // [LAW:no-ambient-temporal-coupling] The inflight map is the single owner
  // of "this call still needs a reply" — the race between dispatch and
  // timeout resolves here, not at the call site.
  complete(id: string): { startedAt: number } | undefined {
    const entry = this.inflight.get(id);
    if (entry === undefined) return undefined;
    this.inflight.delete(id);
    clearTimeout(entry.timer);
    return { startedAt: entry.startedAt };
  }

  // Cancel all in-flight calls; calls `onReject` for each id.
  drain(onReject: (id: string) => void): void {
    for (const [id, pending] of this.inflight) {
      clearTimeout(pending.timer);
      onReject(id);
    }
    this.inflight.clear();
  }
}
