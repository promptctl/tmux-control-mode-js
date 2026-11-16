// src/connection-state.ts
// Unified ConnectionState shape — every TmuxClient-shaped class produces values
// of this exact union.

// [LAW:one-source-of-truth] One declaration; transports map their internal
// state machines onto this shape. Consumers never see per-connector dialects.

/**
 * Lifecycle state for any `TmuxClient`-shaped class.
 *
 * - `connecting`    — pre-handshake. For spawn this spans the transport being
 *                     established AND tmux running the command it was
 *                     started with (SPEC.md §5). For the WebSocket connector
 *                     this is "pre-welcome".
 * - `ready`         — tmux has answered. For spawn this is "the reply to the
 *                     command tmux was started with has closed", not merely
 *                     "first byte from stdout"; that reply, failed or not,
 *                     is also an `unsolicited-response` event. For the
 *                     WebSocket connector this is "post-welcome".
 * - `reconnecting`  — connector is between attempts (only emitted by
 *                     transports that auto-reconnect, currently WebSocket).
 * - `closed`        — no live connection, and no automatic transition leaves
 *                     this state. The `reason` distinguishes consumer-
 *                     initiated close (`disposed`) from clean transport exit
 *                     (`exit`), from a server's refusal (`refused`, which
 *                     carries the server's account as `error`) and from
 *                     error-driven close (`transport-error`:
 *                     the transport failed, or the reply stream it carried
 *                     became unreadable — `TmuxClient`'s `protocol-error`
 *                     with kind `begin` says which line).
 *                     Connectors that expose an explicit `connect()` (the
 *                     WebSocket client) re-enter `connecting` when the
 *                     consumer calls it; nothing else exits `closed`.
 *
 *                     This `reason` classifies how the connection ended, not
 *                     tmux's account of it — it is independent of, and can
 *                     disagree with,
 *                     the `reason` on a client's `exit` event. `exit`'s
 *                     reason is tmux's own explanation: its text for a failed
 *                     startup command (`can't find session: main`), else what
 *                     its `%exit` said (SPEC.md "Exit Reasons": `detached`,
 *                     `lost tty`, …), falling back to the transport's signal
 *                     only when tmux never got the chance to announce (a
 *                     killed server). So a graceful `%exit` can still ride a
 *                     transport close that itself reports an error (a flaky
 *                     pipe closing right after tmux said goodbye) and land
 *                     here as `transport-error` while `exit` carried tmux's
 *                     benign reason, or vice versa.
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
    }
  | {
      readonly status: "closed";
      /** The server refused this connection for good (the WebSocket bridge's
       *  auth denial, or a `createClient` that names a target that does not
       *  exist), so no retry was made: one would be refused again. */
      readonly reason: "refused";
      /** The server's account of the refusal: the WebSocket bridge's fatal
       *  error (`BRIDGE_AUTH_DENIED`, `BRIDGE_REFUSED`), or its close's
       *  reason when no fatal frame arrived. */
      readonly error: Error;
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
 * Emitted when the pane table that session- and window-scoped sinks route by
 * could not be kept true: a bootstrap (`list-panes -a`) or a window refresh
 * failed, or output held for unplaced panes overflowed the hold.
 *
 * A pane the table has not placed matches only pane- and server-scoped sinks,
 * so in each of the three a session/window-scoped consumer misses output of
 * the affected panes, indistinguishable from a quiet tmux. This event is
 * the observable distinction between "no output because routing failed" and
 * "no output because tmux wrote none."
 *
 * [LAW:no-silent-failure] The failure is surfaced, not swallowed.
 *   [LAW:effects-at-boundaries] The router (pure substrate) describes the
 *   failure through an injected seam; the transport adapter (which owns the
 *   emitter) performs this emission.
 *
 * A failed query is non-terminal: the router's event-driven bootstrap triggers
 * (`session-changed`, window events, a new topology-scoped attach) re-attempt
 * the bootstrap, so a later success recovers a starved sink. Output an
 * overflowing hold refused is never delivered to those sinks.
 */
export interface TopologyErrorMessage {
  readonly type: "topology-error";
  /**
   * `message` says which of the three happened; for a failed query, `cause`
   * is what its command rejected with.
   */
  readonly error: Error;
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
    return a.reason === "refused" && b.reason === "refused"
      ? a.error === b.error
      : a.reason === b.reason;
  }
  return true;
}
