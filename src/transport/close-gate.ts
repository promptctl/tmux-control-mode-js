// src/transport/close-gate.ts
// Shared lifecycle state machine for TmuxTransport implementations.
//
// [LAW:one-source-of-truth] Every transport answers "can it still deliver,
// and if not why" from exactly one state value, each transition dispatched
// exactly once. Both spawn.ts and the websocket transport derive from this
// single definition, so a change to lifecycle semantics (e.g. what "reason"
// means) cannot drift between implementations without a compile error.

import type { SendResult } from "./types.js";

/**
 * `open` → `lost` → `closed`, or `open` → `closed`. `lost` is a connection
 * that can deliver nothing more whose close reason is not yet known.
 * Plain object contract — no EventEmitter, no Node streams.
 */
export type TransportLifecycle =
  | { readonly phase: "open" }
  | { readonly phase: "lost"; readonly reason: string }
  | { readonly phase: "closed"; readonly reason: string | undefined };

export interface CloseGate {
  /** Current lifecycle state. */
  readonly state: () => TransportLifecycle;
  /**
   * Record that nothing more can be delivered (`open` → `lost`). A no-op
   * once lost or closed: the first failure is the truest one.
   * [LAW:single-enforcer]
   */
  readonly lose: (reason: string) => void;
  /**
   * Dispatch a close with `reason` (`undefined` means a clean exit).
   * [LAW:single-enforcer] Exactly-once: once closed, later calls are a
   * no-op — the first reason is the truest one and is never downgraded
   * by a subsequent, less specific dispatch for the same death.
   */
  readonly dispatch: (reason: string | undefined) => void;
  /** Register a callback to run when the gate is lost. */
  readonly onLost: (callback: (reason: string) => void) => void;
  /** Register a callback to run on dispatch. */
  readonly onClose: (callback: (reason?: string) => void) => void;
  /**
   * Whether a send may proceed: `ok` while open, else the refusal a
   * transport's `send()` returns.
   */
  readonly admit: () => SendResult;
}

// [LAW:single-enforcer] The one formatting of "not sent, because the
// connection ended", for every transport's `send()` and for a `TmuxClient`
// that refuses before asking its transport.
export const closedSendReason = (reason: string | undefined): string =>
  reason === undefined ? "transport closed" : `transport closed: ${reason}`;

export function createCloseGate(): CloseGate {
  let state: TransportLifecycle = { phase: "open" };
  const lostCallbacks: ((reason: string) => void)[] = [];
  const closeCallbacks: ((reason?: string) => void)[] = [];

  return {
    state: () => state,
    lose(reason) {
      if (state.phase !== "open") return;
      state = { phase: "lost", reason };
      lostCallbacks.forEach((cb) => cb(reason));
    },
    dispatch(reason) {
      if (state.phase === "closed") return;
      state = { phase: "closed", reason };
      closeCallbacks.forEach((cb) => cb(reason));
    },
    // [LAW:no-silent-failure] A callback registered after the gate has
    // already reached its state — long after, or synchronously from within
    // another callback during dispatch (the state flips before the loop
    // runs) — fires immediately with the recorded reason instead of being
    // dropped into an array that will never be iterated again.
    onLost(callback) {
      switch (state.phase) {
        case "open":
          lostCallbacks.push(callback);
          return;
        case "lost":
          callback(state.reason);
          return;
        case "closed":
          // Past loss: its close says everything a lost callback would.
          return;
      }
    },
    onClose(callback) {
      if (state.phase === "closed") {
        callback(state.reason);
        return;
      }
      closeCallbacks.push(callback);
    },
    admit() {
      switch (state.phase) {
        case "open":
          return { ok: true };
        case "lost":
          return { ok: false, reason: `transport lost: ${state.reason}` };
        case "closed":
          return { ok: false, reason: closedSendReason(state.reason) };
      }
    },
  };
}
