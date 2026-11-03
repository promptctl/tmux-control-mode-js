// src/cross-session-layout-messages.ts
// The wire-facing half of the cross-session layout relay: the synthetic
// event types, their runtime membership table, and the relay's reserved
// subscription name. Zero runtime imports, so the Electron renderer and the
// browser WebSocket client can reach it without bundling the relay itself
// (src/cross-session-layout.ts).
//
// [LAW:one-source-of-truth] The subscription name and the event type set are
// defined here once; the relay, the bridge's event routing, and the RPC
// validator all read them from this module.

import type { SubscriptionChangedMessage } from "./protocol/types.js";

// ---------------------------------------------------------------------------
// Public synthetic event types — join SyntheticEmitterMessage in emitter.ts.
// Not TmuxMessage variants: tmux never sends a literal line for any of
// these, so they are not serializeMessage/TmuxParser round-trippable (the
// same reasoning that excludes ProtocolErrorMessage from TmuxMessage).
// ---------------------------------------------------------------------------

/**
 * A window's layout changed somewhere on the server. The global hook this
 * relay installs fires for every session, including this client's own
 * attached one — so this event can arrive for a window already covered by
 * a native `%layout-change`, by design (the ticket this shipped from:
 * "coverage isn't limited to what any consumer uses today"); a consumer
 * that only wants the gap this relay exists for filters on `windowId`
 * against the windows of its own attached session — not on `sessionId`,
 * which is the one session tmux resolves the window in at fetch time (the
 * one `windowFlags` describes) and, for a window linked into several
 * sessions, need not be the attached one. `windowLayout`/
 * `windowVisibleLayout`/`windowFlags` are fetched by this client's own
 * control connection (which defaults to the classic checksum-string format
 * `%layout-change` itself uses — tmux 3.8 changed `#{window_layout}` to
 * render JSON by default for any context without `CLIENT_CONTROL`; fetching
 * via our own already-attached control client avoids that), so they are in
 * the same format as `LayoutChangeMessage`'s fields, not a different shape.
 */
export interface CrossSessionLayoutChangeMessage {
  readonly type: "cross-session-layout-change";
  readonly sessionId: number;
  readonly windowId: number;
  readonly windowLayout: string;
  readonly windowVisibleLayout: string;
  readonly windowFlags: string;
}

/**
 * The relay's queue decoder found bytes that don't match the entry grammar
 * where it expected an entry to start — something other than this
 * library's hook wrote the option. The malformed span was skipped (up to
 * and including the next comma), not misinterpreted as a real identity.
 * [LAW:no-silent-failure]
 */
export interface CrossSessionLayoutDecodeErrorMessage {
  readonly type: "cross-session-layout-decode-error";
  readonly skippedBytes: number;
}

/**
 * Layout changes happened faster than this relay drained them: the hook's
 * `CAP` truncation discarded `lostEntries` entries this relay had not yet
 * seen, so their windows' changes were never fetched. A consumer that needs
 * completeness re-reads every window's layout on this event.
 * [LAW:no-silent-failure]
 */
export interface CrossSessionLayoutOverrunMessage {
  readonly type: "cross-session-layout-overrun";
  readonly lostEntries: number;
}

/**
 * tmux refused the follow-up fetch for a window whose layout changed —
 * most likely the window closed between the hook firing and this
 * ~1s-delayed subscription delivery. Nothing to report (no layout exists
 * for a window that's gone); surfaced rather than left as a silently
 * dropped entry. A fetch cut off by the connection closing emits nothing:
 * the client's own `connection-state` event already reports that.
 * [LAW:no-silent-failure]
 */
export interface CrossSessionLayoutFetchFailedMessage {
  readonly type: "cross-session-layout-fetch-failed";
  readonly windowId: number;
  /** tmux's `%error` output for the fetch. */
  readonly reason: string;
}

/**
 * The relay's global hook had been removed — typically by a `set-hook -g
 * window-layout-changed` without an index (a re-sourced `tmux.conf`), which
 * replaces the whole hook array — and the relay has reinstalled it. Layout
 * changes made while it was gone were never recorded; a consumer that needs
 * completeness re-reads every window's layout on this event, as on overrun.
 * [LAW:no-silent-failure]
 */
export interface CrossSessionLayoutHookRestoredMessage {
  readonly type: "cross-session-layout-hook-restored";
}

/**
 * tmux refused the relay's check or reinstall of its global hook. The last
 * `cross-session-layout-uncovered` still stands; the relay tries again on
 * the next delivery that has uncovered windows, so this can repeat.
 * [LAW:no-silent-failure]
 */
export interface CrossSessionLayoutRepairFailedMessage {
  readonly type: "cross-session-layout-repair-failed";
  /** tmux's `%error` output for the failed command. */
  readonly reason: string;
}

/**
 * The windows, server-wide, whose layout changes the relay cannot see: a
 * window-local hook (`set-hook -w window-layout-changed`) or a hook set on a
 * session the window is in replaces the global hook array for that window,
 * so tmux never runs the relay's entry there — and, until the relay
 * reinstalls it, every window once the global hook is removed. The relay
 * does not override the user's hook; it reports. Emitted on enabling and
 * whenever the set changes, `[]` once coverage is whole again — the latest
 * event is the current truth.
 * [LAW:no-silent-failure]
 */
export interface CrossSessionLayoutUncoveredMessage {
  readonly type: "cross-session-layout-uncovered";
  readonly windowIds: readonly number[];
}

export type CrossSessionLayoutMessage =
  | CrossSessionLayoutChangeMessage
  | CrossSessionLayoutDecodeErrorMessage
  | CrossSessionLayoutOverrunMessage
  | CrossSessionLayoutFetchFailedMessage
  | CrossSessionLayoutHookRestoredMessage
  | CrossSessionLayoutRepairFailedMessage
  | CrossSessionLayoutUncoveredMessage;

/**
 * The `subscribe-changes` name the relay subscribes under. Reserved: a bridge
 * peer may not subscribe or unsubscribe it, since the bridge shares one tmux
 * client and a peer's binding would replace the relay's.
 */
export const CROSS_SESSION_LAYOUT_SUBSCRIPTION_NAME =
  "ttcmjs-cross-session-layout";

const CROSS_SESSION_LAYOUT_MESSAGE_TYPES: Record<
  CrossSessionLayoutMessage["type"],
  true
> = {
  "cross-session-layout-change": true,
  "cross-session-layout-decode-error": true,
  "cross-session-layout-overrun": true,
  "cross-session-layout-fetch-failed": true,
  "cross-session-layout-hook-restored": true,
  "cross-session-layout-repair-failed": true,
  "cross-session-layout-uncovered": true,
};

export function isCrossSessionLayoutMessage(ev: {
  readonly type: string;
}): ev is CrossSessionLayoutMessage {
  return Object.hasOwn(CROSS_SESSION_LAYOUT_MESSAGE_TYPES, ev.type);
}

/** The relay's raw `%subscription-changed` delivery — internal plumbing, never an event for a consumer. */
export function isCrossSessionLayoutRelayFrame(ev: {
  readonly type: string;
}): ev is SubscriptionChangedMessage {
  return (
    ev.type === "subscription-changed" &&
    (ev as SubscriptionChangedMessage).name ===
      CROSS_SESSION_LAYOUT_SUBSCRIPTION_NAME
  );
}
