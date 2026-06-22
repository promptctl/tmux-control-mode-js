// src/idle-pane-suppressor.ts
// IdlePaneSuppressor — translates pane-interest transitions into tmux
// pause/continue actions.
//
// [LAW:effects-at-boundaries] This is the boundary where pane-interest derivation
//   (the pure PaneInterestTracker) meets the world. The suppressor holds no
//   topology and no attachment state — it receives transitions and emits actions
//   through the injected sender. The sender is the seam to tmux.
// [LAW:decomposition] Suppression policy ("idle → pause, interesting → continue")
//   is one thing, distinct from interest derivation and from byte dispatch. It is
//   testable in isolation: feed it transitions, observe the actions.

import { PaneAction } from "./protocol/types.js";
import type { PaneInterestListener } from "./pane-output.js";

/**
 * Emits a pane action to tmux. Injected by the owner (the TopologyRouter), which
 * binds it to the live command runner and drops actions when no connection is
 * available. Keeping this a plain function leaves the suppressor free of any
 * TmuxClient / transport reference.
 */
export type PaneActionSender = (paneId: number, action: PaneAction) => void;

/**
 * Pauses panes nobody is interested in and continues them when interest returns.
 *
 * Wired to a {@link PaneInterestTracker} via the {@link PaneInterestListener}
 * interface. The tracker fires a transition; the suppressor issues the matching
 * tmux action.
 *
 * tmux's `pause`/`continue` (via `refresh-client -A`) is **per-control-mode
 * client** — pausing here suppresses only this client's view of the pane. Other
 * tmux clients attached to the same session are unaffected.
 *
 * [LAW:dataflow-not-control-flow] Each transition deterministically issues its
 *   one action; the suppressor does not branch on "is suppression enabled" (its
 *   mere existence is the enablement) nor re-derive interest. `paused` records
 *   which panes were paused purely so {@link dispose} can leave tmux clean.
 */
export class IdlePaneSuppressor implements PaneInterestListener {
  // [LAW:one-source-of-truth] The set of panes this suppressor has paused. Used
  //   only by dispose() to continue them; interest truth lives in the tracker.
  private readonly paused = new Set<number>();

  constructor(private readonly send: PaneActionSender) {}

  onPaneBecameInteresting(paneId: number): void {
    this.send(paneId, PaneAction.Continue);
    this.paused.delete(paneId);
  }

  onPaneBecameIdle(paneId: number): void {
    this.send(paneId, PaneAction.Pause);
    this.paused.add(paneId);
  }

  /**
   * Continue every pane this suppressor paused, leaving tmux in a clean state.
   *
   * Idempotent: after the sweep the paused set is empty, so a second call is a
   * no-op. Whether the continue actions reach tmux is the sender's concern — on
   * connection teardown the sender drops them (a detached control-mode client's
   * pauses are already moot), so this clears local state without wire traffic.
   */
  dispose(): void {
    for (const paneId of this.paused) this.send(paneId, PaneAction.Continue);
    this.paused.clear();
  }
}
