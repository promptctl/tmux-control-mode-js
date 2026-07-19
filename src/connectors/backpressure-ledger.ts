// src/connectors/backpressure-ledger.ts
// [LAW:decomposition] Per-peer per-pane outstanding-byte accounting and the
// watermark loop that pauses / resumes panes, extracted from
// createBridgeConnection. This ledger's ONE invariant is: a pane is paused iff
// the SUM of outstanding bytes across every peer subscribed to it has crossed
// the high watermark and not yet fallen back below the low watermark. It shares
// nothing with the subscription ledger except the opaque `Peer` token it
// indexes on.
//
// [LAW:dataflow-not-control-flow] Pause/resume decisions are pure functions of
// the per-peer `outstanding` maps; the same account / ack pipeline runs every
// time and the data (the per-pane sum) decides whether setPaneAction fires.

import { PaneAction } from "../protocol/types.js";
import { refreshClientPaneAction } from "../protocol/encoder.js";
import {
  TmuxCommandError,
  TmuxProtocolError,
  isConnectionGone,
} from "../errors.js";
import type { TmuxConnection } from "../client.js";

import { BridgeError } from "./errors.js";
import type { Peer } from "./bridge-peer.js";

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Default per-pane high watermark (1 MiB summed across peers). */
export const DEFAULT_OUTPUT_HIGH_WATERMARK = 1 << 20;
/** Default per-pane low watermark (256 KiB summed across peers). */
export const DEFAULT_OUTPUT_LOW_WATERMARK = 1 << 18;

/**
 * A resume (Continue) command that tmux was alive to answer but did NOT apply
 * — the pane is still paused in tmux while the watermark loop wanted it flowing.
 * The bridge keeps the pane in its ledger (so the next watermark crossing
 * retries) and hands this description to the transport, which performs the
 * observable emission on its own channel. Connection-gone rejections are NOT
 * reported here (a paused pane on a dead connection is moot) — only failures
 * that leave a LIVE pane stranded reach the reporter.
 *
 * [LAW:effects-at-boundaries] The bridge DESCRIBES the failure; the transport
 * (websocket server, electron main) PERFORMS the emission — mirroring the
 * topology-error reporter seam.
 */
export interface ResumeFailure {
  /** The pane whose Continue tmux refused. */
  readonly paneId: number;
  /** Classified, self-describing failure — carries the tmux/transport cause. */
  readonly error: BridgeError;
}

// ---------------------------------------------------------------------------
// Resume-failure classification
//
// [LAW:no-silent-failure] The old blanket `.catch(swallow)` conflated two
// domain categories with opposite correct handling. Split them by error CLASS
// (the mechanically-checked signal), never by parsing tmux's English:
//   - connection-gone: the transport refused the send or closed mid-flight, so
//     tmux never applied the resume AND is now unreachable. A paused pane on a
//     dead connection is moot — the whole connection is tearing down. Quiet.
//   - everything else (tmux replied %error, a corrupted terminator, or an
//     unexpected throw): tmux was ALIVE and the pane is still paused. This is
//     the meaning-altering strand the epic targets — keep it paused, retry,
//     and surface it.
// ---------------------------------------------------------------------------
// [LAW:single-enforcer] `isConnectionGone` is the shared taxonomy predicate
//   from ../errors.js — the pane-terminal subscribe/seed seam splits
//   quiet-vs-surface through the same check, so the two sites cannot drift.

// [LAW:types-are-the-program] Map each rejection class onto the existing
// BridgeError taxonomy so the surfaced error is transport-agnostic and typed.
// TOTAL by construction: the fallthrough never calls String() (which throws on
// null-proto causes — the kwv.1 lesson), only reads `.message` off a checked
// Error. A throw here would itself be the silence we are removing.
const resumeFailureToBridgeError = (
  paneId: number,
  err: unknown,
): BridgeError => {
  if (err instanceof TmuxCommandError) {
    return new BridgeError(
      "TMUX_ERROR",
      `resume (continue) rejected by tmux for pane %${paneId}: ${err.message}`,
    );
  }
  if (err instanceof TmuxProtocolError) {
    return new BridgeError(
      "BRIDGE_PROTOCOL_ERROR",
      `resume (continue) response for pane %${paneId} had a corrupted ` +
        `terminator; the pane's flow-control state is unknown: ${err.message}`,
    );
  }
  // [LAW:no-silent-failure] A non-Error reject on this path is already the
  // unexpected case; preserve a diagnostic hint. `typeof` never throws (the
  // reason this branch avoids `String()`, which throws on a null-proto cause)
  // and at least distinguishes a string / number / raw object rejection.
  const detail =
    err instanceof Error ? err.message : `non-Error rejection (${typeof err})`;
  return new BridgeError(
    "BRIDGE_INTERNAL",
    `resume (continue) failed unexpectedly for pane %${paneId}: ${detail}`,
  );
};

/**
 * Per-pane flow-control state. Presence in the pause ledger means "paused (per
 * our belief)"; `resuming` is true while a Continue for this pane is in flight,
 * which both suppresses duplicate sends and — via this object's identity — lets
 * a settling Continue recognize its own episode after an intervening teardown.
 */
interface PaneFlow {
  resuming: boolean;
}

export interface BackpressureLedgerDeps {
  /** Only `execute` is needed — the weakest sufficient view of the connection. */
  readonly client: Pick<TmuxConnection, "execute">;
  readonly outputHighWatermark?: number;
  readonly outputLowWatermark?: number;
  /**
   * Surface a resume failure that stranded a LIVE pane paused. REQUIRED — a
   * bridge that could silently drop such a failure must not be constructible.
   * [LAW:no-silent-failure] There is deliberately no default no-op: a default
   * would let every caller reintroduce the swallowed strand this seam removes.
   */
  readonly reportResumeFailure: (failure: ResumeFailure) => void;
}

export class BackpressureLedger {
  private readonly outstanding = new Map<Peer, Map<number, number>>();

  // [LAW:types-are-the-program] The pause ledger is NOT a bare `Set<number>`
  // (paused | not) — too weak to represent a resume in flight, which is what
  // let the old code delete the entry BEFORE the Continue settled and then
  // swallow the outcome. Presence in this map means "paused (per our belief)";
  // the value carries the resume-in-flight state. The PaneFlow OBJECT identity
  // is the episode token: a captured reference that a later dispose/re-pause
  // replaces, so a settling Continue can tell its own episode from a new one.
  // The guard compares identity, never a value — a value check would be
  // ABA-blind (paused → resumed → re-paused reads as "unchanged").
  private readonly pausedPanes = new Map<number, PaneFlow>();

  private readonly client: Pick<TmuxConnection, "execute">;
  private readonly high: number;
  private readonly low: number;
  private readonly reportResumeFailure: (failure: ResumeFailure) => void;

  // Fire-and-forget on the genuinely-moot cleanup seams only: a Pause that
  // races a vanishing pane, and dispose teardown. The resume seam does NOT use
  // this — see maybeResume, which classifies the failure instead of swallowing
  // it ([LAW:no-silent-failure]).
  private readonly swallow = (): void => undefined;

  constructor(deps: BackpressureLedgerDeps) {
    this.client = deps.client;
    this.reportResumeFailure = deps.reportResumeFailure;
    this.high = deps.outputHighWatermark ?? DEFAULT_OUTPUT_HIGH_WATERMARK;
    this.low = deps.outputLowWatermark ?? DEFAULT_OUTPUT_LOW_WATERMARK;
    // [LAW:single-enforcer] Shared validation site: invalid watermark config
    // is rejected at construction so both transports surface the same error
    // shape (`BRIDGE_INVALID_ARG`) without each one re-implementing the check.
    if (!(this.high > this.low && this.low >= 0)) {
      throw new BridgeError(
        "BRIDGE_INVALID_ARG",
        `outputHighWatermark (${this.high}) must be > ` +
          `outputLowWatermark (${this.low}) >= 0`,
      );
    }
  }

  /** Seed this peer's outstanding-bytes slot. Called once by the façade's
   *  `registerPeer`; presence of the slot is this ledger's registration truth. */
  register(peer: Peer): void {
    this.outstanding.set(peer, new Map());
  }

  private totalOutstanding(paneId: number): number {
    let sum = 0;
    for (const m of this.outstanding.values()) sum += m.get(paneId) ?? 0;
    return sum;
  }

  private maybePause(paneId: number): void {
    if (this.pausedPanes.has(paneId)) return;
    if (this.totalOutstanding(paneId) < this.high) return;
    this.pausedPanes.set(paneId, { resuming: false });
    void this.client
      .execute(refreshClientPaneAction(paneId, PaneAction.Pause))
      .catch(this.swallow);
  }

  // [LAW:one-source-of-truth] The ledger transition FOLLOWS the effect outcome
  // instead of racing ahead of it: the pane leaves `pausedPanes` only when tmux
  // confirms the Continue. On a live-pane failure the entry stays, so the next
  // watermark crossing retries (event-driven — no ambient retry timer,
  // [LAW:no-ambient-temporal-coupling]); the failure is surfaced, never dropped.
  private maybeResume(paneId: number): void {
    const flow = this.pausedPanes.get(paneId);
    if (flow === undefined) return; // not paused per the ledger
    if (this.totalOutstanding(paneId) > this.low) return; // above low → stay paused
    if (flow.resuming) return; // a Continue is already in flight; don't double-send
    flow.resuming = true;
    void this.client
      .execute(refreshClientPaneAction(paneId, PaneAction.Continue))
      .then(
        () => {
          // Identity guard: only this episode's entry may be cleared. A dispose
          // (or, defensively, a future path that re-pauses under a NEW PaneFlow)
          // makes `get(paneId) !== flow`, so a stale outcome cannot touch the
          // current episode. While paused tmux emits no output, so outstanding
          // cannot have re-crossed high in the interim — no reconcile needed.
          if (this.pausedPanes.get(paneId) === flow) {
            this.pausedPanes.delete(paneId);
          }
        },
        (err: unknown) => {
          if (this.pausedPanes.get(paneId) !== flow) return; // superseded → ignore
          flow.resuming = false; // clear in-flight so the next crossing may retry
          if (isConnectionGone(err)) {
            // Transport/bridge gone: the pane's flow-control no longer matters.
            // The genuine cleanup case the old blanket catch conflated with the
            // strand — drop the entry quietly.
            this.pausedPanes.delete(paneId);
            return;
          }
          // tmux is alive and the pane is still paused. Keep the entry (retry on
          // the next crossing) and surface the failure.
          this.reportResumeFailure({
            paneId,
            error: resumeFailureToBridgeError(paneId, err),
          });
        },
      );
  }

  /**
   * Account `bytes` of pane output sent to `peer` for `paneId`. When the
   * per-pane sum across all peers crosses the high watermark, fires
   * `client.setPaneAction(paneId, Pause)` exactly once. A peer with no slot
   * (never registered, or already released) is a no-op — a stray account can
   * never resurrect a dead peer's accounting.
   */
  account(peer: Peer, paneId: number, bytes: number): void {
    const m = this.outstanding.get(peer);
    if (m === undefined) return;
    if (bytes <= 0) return;
    const prev = m.get(paneId) ?? 0;
    m.set(paneId, prev + bytes);
    this.maybePause(paneId);
  }

  /**
   * Apply an ack: `peer` reports it has consumed `bytes` for `paneId`. Subtracts
   * from the peer's outstanding tally and, when the per-pane sum drops below the
   * low watermark, fires `client.setPaneAction(paneId, Continue)` exactly once.
   *
   * Negative or oversized acks are clamped to the peer's current outstanding —
   * bad acks can only starve the peer that sent them, never confuse the shared
   * bookkeeping.
   */
  ack(peer: Peer, paneId: number, bytes: number): void {
    const m = this.outstanding.get(peer);
    if (m === undefined) return;
    if (bytes <= 0) return;
    const prev = m.get(paneId) ?? 0;
    const next = Math.max(0, prev - bytes);
    if (next === 0) m.delete(paneId);
    else m.set(paneId, next);
    this.maybeResume(paneId);
  }

  /**
   * Zero this peer's outstanding bytes for every pane and resume any pane whose
   * remaining sum (across surviving peers) drops below the low watermark. Used
   * by transports whose underlying drain signal is connection-wide rather than
   * per-pane — notably the WebSocket bridge observing `ws.bufferedAmount`
   * reaching zero. Per-pane accounting is preserved for other peers; this clears
   * just the caller's slice.
   */
  clearPeer(peer: Peer): void {
    const m = this.outstanding.get(peer);
    if (m === undefined) return;
    const paneIds = [...m.keys()];
    m.clear();
    // [LAW:dataflow-not-control-flow] Same maybeResume call as ack; only the
    // data the ledger sees on those panes (this peer's bytes gone, others'
    // remain) decides whether continue actually fires.
    for (const paneId of paneIds) this.maybeResume(paneId);
  }

  /**
   * Drop this peer's outstanding accounting entirely and resume panes whose
   * remaining sum (across surviving peers) drops below the low watermark. The
   * peer's slot is removed BEFORE the resume decisions so it no longer counts
   * toward any pane's sum. Idempotent — a peer with no slot is a no-op.
   */
  releasePeer(peer: Peer): void {
    const m = this.outstanding.get(peer);
    if (m === undefined) return;
    const paneIds = [...m.keys()];
    this.outstanding.delete(peer);
    for (const paneId of paneIds) this.maybeResume(paneId);
  }

  /**
   * Final teardown flush: resume every pane still paused that is NOT already
   * being resumed, so a programming error that left one stranded still gets a
   * Continue, without double-sending one already in flight. Teardown is a
   * genuinely-moot cleanup seam (the bridge is done; nothing left to retry or
   * report to), so a failed Continue here is swallowed. Clears the ledger.
   */
  flushPausedPanes(): void {
    for (const [paneId, flow] of this.pausedPanes) {
      if (flow.resuming) continue;
      void this.client
        .execute(refreshClientPaneAction(paneId, PaneAction.Continue))
        .catch(this.swallow);
    }
    this.pausedPanes.clear();
  }
}
