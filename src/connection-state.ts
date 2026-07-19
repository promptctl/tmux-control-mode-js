// src/connection-state.ts
// Unified ConnectionState shape — every TmuxClient-shaped class produces values
// of this exact union.

// [LAW:one-source-of-truth] One declaration; transports map their internal
// state machines onto this shape. Consumers never see per-connector dialects.

/**
 * Lifecycle state for any `TmuxClient`-shaped class.
 *
 * - `connecting`    — pre-handshake. For spawn this spans the transport being
 *                     established AND tmux's unsolicited startup %begin/%end
 *                     greeting (SPEC.md §5) being consumed — that guard block
 *                     is real traffic, but caller commands are not yet safe
 *                     to correlate against it. For the WebSocket connector
 *                     this is "pre-welcome".
 * - `ready`         — safe to correlate a caller's command against the next
 *                     guard block. For spawn this is "the startup greeting's
 *                     %end/%error has been consumed", not merely "first byte
 *                     from stdout" (see TmuxClient.awaitingGreeting); for the
 *                     WebSocket connector this is "post-welcome".
 * - `reconnecting`  — connector is between attempts (only emitted by
 *                     transports that auto-reconnect, currently WebSocket).
 * - `closed`        — no live connection, and no automatic transition leaves
 *                     this state. The `reason` distinguishes consumer-
 *                     initiated close (`disposed`) from clean transport exit
 *                     (`exit`) and from error-driven close (`transport-error`).
 *                     Connectors that expose an explicit `connect()` (the
 *                     WebSocket client) re-enter `connecting` when the
 *                     consumer calls it; nothing else exits `closed`.
 *
 *                     This `reason` classifies the TRANSPORT's own close
 *                     signal — it is independent of, and can disagree with,
 *                     the `reason` on a client's `exit` event. `exit`'s
 *                     reason is tmux's own protocol-level explanation (SPEC.md
 *                     "Exit Reasons": `detached`, `lost tty`, …) when tmux
 *                     sent one, falling back to the transport's signal only
 *                     when tmux never got the chance to announce (a killed
 *                     server). So a graceful `%exit` can still ride a
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
 * Emitted when a topology bootstrap effect (`list-panes -a`) fails.
 *
 * The pure topology substrate keeps computing — an empty topology table is a
 * representable value — but an empty table cannot silently stand in for a
 * failed bootstrap: with no topology, byte dispatch matches only pane- and
 * server-scoped sinks, so every session/window-scoped consumer would receive
 * zero bytes, indistinguishable from a genuinely empty tmux. This event is the
 * observable distinction between "empty because bootstrap failed" and "empty
 * because tmux has no panes."
 *
 * [LAW:no-silent-failure] The bootstrap effect's failure is surfaced, not
 *   swallowed. [LAW:effects-at-boundaries] The router (pure substrate) describes
 *   the failure through an injected seam; the transport adapter (which owns the
 *   emitter) performs this emission.
 *
 * Non-terminal: the router's existing event-driven bootstrap triggers
 * (`session-changed`, window events, a new topology-scoped attach) re-attempt
 * the bootstrap, so a later success recovers a starved sink.
 */
export interface TopologyErrorMessage {
  readonly type: "topology-error";
  /** The error the bootstrap command rejected with, normalized to `Error`. */
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
    return a.reason === b.reason;
  }
  return true;
}
