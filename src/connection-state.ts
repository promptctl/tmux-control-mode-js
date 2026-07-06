// src/connection-state.ts
// Unified ConnectionState shape — every TmuxClient-shaped class produces values
// of this exact union.

// [LAW:one-source-of-truth] One declaration; transports map their internal
// state machines onto this shape. Consumers never see per-connector dialects.

/**
 * Lifecycle state for any `TmuxClient`-shaped class.
 *
 * - `connecting`    — pre-handshake; the transport is being established but
 *                     no traffic from tmux has been observed yet.
 * - `ready`         — tmux is talking. For spawn this is "first byte from
 *                     stdout"; for the WebSocket connector this is "post-welcome".
 * - `reconnecting`  — connector is between attempts (only emitted by
 *                     transports that auto-reconnect, currently WebSocket).
 * - `closed`        — no live connection, and no automatic transition leaves
 *                     this state. The `reason` distinguishes consumer-
 *                     initiated close (`disposed`) from clean transport exit
 *                     (`exit`) and from error-driven close (`transport-error`).
 *                     Connectors that expose an explicit `connect()` (the
 *                     WebSocket client) re-enter `connecting` when the
 *                     consumer calls it; nothing else exits `closed`.
 */
export type ConnectionState =
  | { readonly status: "connecting" }
  | { readonly status: "ready" }
  | {
      readonly status: "reconnecting";
      readonly attempt: number;
      readonly lastError?: Error;
    }
  | {
      readonly status: "closed";
      readonly reason: "exit" | "transport-error" | "disposed";
    };

/**
 * Synthetic lifecycle messages emitted through the same `TypedEmitter` that
 * carries parsed tmux notifications. These are NOT parsed from tmux output —
 * client classes synthesize them as their connection state changes.
 *
 * [LAW:locality-or-seam] These live alongside `ConnectionState`, outside the
 * pure `src/protocol/` boundary, because they're a client/transport concern,
 * not a wire-protocol concern.
 */
export interface ConnectionStateMessage {
  readonly type: "connection-state";
  readonly state: ConnectionState;
}

export interface ReconnectedMessage {
  readonly type: "reconnected";
}

/**
 * Structural equality for `ConnectionState` values. Used by client
 * implementations to make `setConnectionState` idempotent — a transition to
 * the same effective state is a no-op and emits no event.
 *
 * [LAW:one-source-of-truth] Equality lives here so every connector compares
 * states the same way.
 */
export function sameConnectionState(
  a: ConnectionState,
  b: ConnectionState,
): boolean {
  if (a.status !== b.status) return false;
  if (a.status === "reconnecting" && b.status === "reconnecting") {
    return a.attempt === b.attempt && a.lastError === b.lastError;
  }
  if (a.status === "closed" && b.status === "closed") {
    return a.reason === b.reason;
  }
  return true;
}
