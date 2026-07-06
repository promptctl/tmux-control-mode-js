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
  /**
   * The `SendResult.reason` string for a send refused because this gate is
   * closed. [LAW:single-enforcer] The one formatting of "why is send
   * refused" — previously duplicated identically across all three
   * transports' `send()` implementations. Callers must check
   * `state().closed` first — calling this on an open gate throws rather
   * than silently claiming "transport closed" while it is not.
   */
  readonly deniedSendReason: () => string;
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
    // [LAW:no-silent-failure] A callback registered after the gate has
    // already closed — whether long after, or synchronously from within
    // another onClose callback during dispatch (state.closed flips to true
    // before the dispatch loop runs) — fires immediately with the recorded
    // reason instead of being silently dropped into an array that will
    // never be iterated again.
    onClose(callback) {
      if (state.closed) {
        callback(state.reason);
        return;
      }
      callbacks.push(callback);
    },
    deniedSendReason() {
      // [LAW:no-silent-failure] A caller that skipped the state().closed
      // check would otherwise silently get "transport closed" back for a
      // gate that is not, in fact, closed — a real answer to the wrong
      // question. Fail loud instead of misrepresenting the state.
      if (!state.closed) {
        throw new Error(
          "CloseGate.deniedSendReason() called on a gate that is not closed",
        );
      }
      return state.reason === undefined
        ? "transport closed"
        : `transport closed: ${state.reason}`;
    },
  };
}
