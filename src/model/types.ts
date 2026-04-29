// src/model/types.ts
// Public data shapes for the TmuxModel topology projection.
//
// [LAW:one-source-of-truth] These types are the canonical shape consumers
// read; TmuxModel is responsible for delivering and maintaining them.
// Demos and downstream consumers MUST NOT redeclare equivalent shapes —
// import them from here.
//
// [LAW:dataflow-not-control-flow] Active state is encoded as flags on the
// snapshot tree (`session.attached`, `window.active`, `pane.active`). It
// is never stored as a separate id; selectors derive ids from the tree.

export interface PaneSnapshot {
  readonly id: number;
  readonly index: number;
  readonly active: boolean;
  readonly title: string;
  /**
   * Pane width in cells. `null` until tmux has reported a width for this
   * pane at least once. The demo's `width || 80` magic-number fallback
   * encoded "unknown" as control flow; encoding it in the type forces
   * consumers to handle the unknown case explicitly.
   */
  readonly width: number | null;
  readonly height: number | null;
}

export interface WindowSnapshot {
  readonly id: number;
  readonly index: number;
  readonly name: string;
  readonly active: boolean;
  readonly zoomed: boolean;
  readonly panes: readonly PaneSnapshot[];
}

export interface SessionSnapshot {
  readonly id: number;
  readonly name: string;
  readonly attached: boolean;
  readonly windows: readonly WindowSnapshot[];
}

export interface TmuxSnapshot {
  readonly sessions: readonly SessionSnapshot[];
  /**
   * Session this control client is currently attached to, captured from
   * `%client-session-changed`. tmux's per-session `attached` flag means
   * "some client is attached" — with multiple attached clients it cannot
   * identify our own. `null` until tmux has reported it (or ourselves
   * during bootstrap via `display-message`).
   */
  readonly clientSessionId: number | null;
}

// ---------------------------------------------------------------------------
// Diff shapes
// ---------------------------------------------------------------------------

/**
 * Per-tier rename payload — useful for both UI labels and "session/window
 * was renamed; refresh anything keyed by name" reactions.
 */
export interface RenamePayload {
  readonly id: number;
  readonly oldName: string;
  readonly newName: string;
}

export interface SessionsDiff {
  readonly added: readonly number[];
  readonly removed: readonly number[];
  readonly renamed: readonly RenamePayload[];
  /** Session ids whose `attached` flag flipped between snapshots. */
  readonly attachChanged: readonly number[];
}

export interface WindowsDiff {
  readonly added: readonly number[];
  readonly removed: readonly number[];
  readonly renamed: readonly RenamePayload[];
  /** Window ids whose `active` flag flipped. */
  readonly activeChanged: readonly number[];
  /** Window ids whose `zoomed` flag flipped. */
  readonly zoomedChanged: readonly number[];
}

export interface PanesDiff {
  readonly added: readonly number[];
  readonly removed: readonly number[];
  /** Pane ids whose width or height changed (either direction). */
  readonly dimChanged: readonly number[];
  /** Pane ids whose title changed. */
  readonly titleChanged: readonly number[];
  /** Pane ids whose `active` flag flipped. */
  readonly activeChanged: readonly number[];
}

export interface TmuxDiff {
  readonly sessions: SessionsDiff;
  readonly windows: WindowsDiff;
  readonly panes: PanesDiff;
  /** True when `clientSessionId` changed between snapshots. */
  readonly clientSessionChanged: boolean;
}

// ---------------------------------------------------------------------------
// Error shape
// ---------------------------------------------------------------------------

/**
 * Phase of the model lifecycle when an error originated. `subscribe` covers
 * the initial `subscribeSessions/Windows/Panes` calls; `bootstrap` covers
 * the `list-*` snapshot fetch and `display-message` for clientSessionId;
 * `refresh-session` and `refresh-dims` are the two fast-paths.
 */
export type TmuxModelErrorPhase =
  | "subscribe"
  | "bootstrap"
  | "refresh-session"
  | "refresh-dims";

export interface TmuxModelError {
  readonly phase: TmuxModelErrorPhase;
  readonly cause: unknown;
}

// ---------------------------------------------------------------------------
// Empty snapshot constant — handed back before any subscription delivers.
// ---------------------------------------------------------------------------

/**
 * Sentinel snapshot used as the previous-state input to the first diff and
 * as the return value of `model.snapshot()` before any data has arrived.
 *
 * [LAW:one-source-of-truth] Every read of "no data yet" returns the same
 * frozen object — no per-instance defaulting that could drift.
 */
export const EMPTY_SNAPSHOT: TmuxSnapshot = Object.freeze({
  sessions: Object.freeze([]) as readonly SessionSnapshot[],
  clientSessionId: null,
});
