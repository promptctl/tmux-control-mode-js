// src/transport/close-gate.ts
// Shared end-of-life state machine for TmuxTransport implementations.
//
// [LAW:one-source-of-truth] Every transport answers "is it closed, and why"
// from exactly one state value, dispatched exactly once. Both spawn.ts and
// the websocket transport independently defined this same discriminated
// union and guard-then-dispatch pattern; this is the single definition they
// now derive from, so a change to close semantics (e.g. what "reason"
// means) cannot drift between implementations without a compile error.

/** Plain object contract — no EventEmitter, no Node streams. */
export type TransportCloseState =
  | { readonly closed: false }
  | { readonly closed: true; readonly reason: string | undefined };

export interface CloseGate {
  /** Current end-of-life state. */
  readonly state: () => TransportCloseState;
  /**
   * Dispatch a close with `reason` (`undefined` means a clean exit).
   * [LAW:single-enforcer] Exactly-once: once closed, later calls are a
   * no-op — the first reason is the truest one and is never downgraded
   * by a subsequent, less specific dispatch for the same death.
   */
  readonly dispatch: (reason: string | undefined) => void;
  /** Register a callback to run on dispatch. */
  readonly onClose: (callback: (reason?: string) => void) => void;
}

export function createCloseGate(): CloseGate {
  let state: TransportCloseState = { closed: false };
  const callbacks: ((reason?: string) => void)[] = [];

  return {
    state: () => state,
    dispatch(reason) {
      if (state.closed) return;
      state = { closed: true, reason };
      callbacks.forEach((cb) => cb(reason));
    },
    onClose(callback) {
      callbacks.push(callback);
    },
  };
}
