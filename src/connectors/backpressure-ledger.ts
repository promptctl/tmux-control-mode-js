// src/connectors/backpressure-ledger.ts
// [LAW:decomposition] Per-peer per-pane outstanding-byte accounting and the
// watermark loop that pauses / resumes panes, extracted from
// createBridgeConnection. This ledger's ONE invariant is: a pane is paused iff
// its slowest peer — the one with the most outstanding bytes for it — has
// reached the high watermark and not yet fallen back to or below the low
// watermark. The two boundaries are inclusive and symmetric — pause at
// `slowest >= high`, resume at `slowest <= low` — so the hysteresis band is
// `(low, high)`. It shares nothing with the subscription ledger except the
// opaque `Peer` token it indexes on.
//
// Each peer holds its own copy of a pane's bytes in its own pipe, so a peer's
// outstanding total is what measures how far behind that consumer is; a sum
// across peers measures nothing a consumer sees. It would also add up what
// each peer withholds by design — the Electron renderer acks in batches, so
// every proxy keeps up to one batch unacked — until enough peers kept a paused
// pane above low forever, with no output left to fill a batch and ack it.
// Per peer, a paused pane resumes as long as what one peer withholds is at
// most `low` (see `RendererBridgeOptions.ackBatchBytes`).
//
// [LAW:dataflow-not-control-flow] Pause/resume decisions are pure functions of
// the per-peer `outstanding` maps; the same account / ack pipeline runs every
// time and the data (the slowest peer's bytes) decides whether setPaneAction
// fires.

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

/** Default per-pane high watermark (1 MiB outstanding at the slowest peer). */
export const DEFAULT_OUTPUT_HIGH_WATERMARK = 1 << 20;
/** Default per-pane low watermark (256 KiB outstanding at the slowest peer). */
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
//   from ../errors.js — the window-terminal subscribe/seed seam splits
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
    // [LAW:no-silent-failure] Symmetric with SubscriptionLedger.register: a
    // re-register is unreachable (fresh `Peer` per registerPeer), but a silent
    // overwrite would drop this peer's outstanding accounting. Fail loud.
    if (this.outstanding.has(peer)) {
      throw new BridgeError(
        "BRIDGE_INTERNAL",
        `peer ${peer.id} is already registered with the backpressure ledger`,
      );
    }
    this.outstanding.set(peer, new Map());
  }

  private slowestOutstanding(paneId: number): number {
    let slowest = 0;
    for (const m of this.outstanding.values()) {
      slowest = Math.max(slowest, m.get(paneId) ?? 0);
    }
    return slowest;
  }

  // Only the peer just billed changed, and any other peer at `high` would
  // have paused the pane already, so its total alone decides.
  private maybePause(paneId: number, billed: number): void {
    if (this.pausedPanes.has(paneId)) return;
    if (billed < this.high) return;
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
    // Inclusive boundary, symmetric with maybePause's `>= high`: resume once the
    // slowest peer is at or below low; stay paused while it is above.
    if (this.slowestOutstanding(paneId) > this.low) return;
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
   * pane's slowest peer reaches the high watermark, fires
   * `client.setPaneAction(paneId, Pause)` exactly once. A peer with no slot
   * (never registered, or already released) is a no-op — a stray account can
   * never resurrect a dead peer's accounting.
   */
  account(peer: Peer, paneId: number, bytes: number): void {
    const m = this.outstanding.get(peer);
    if (m === undefined) return;
    if (bytes <= 0) return;
    const next = (m.get(paneId) ?? 0) + bytes;
    m.set(paneId, next);
    this.maybePause(paneId, next);
  }

  /**
   * Apply an ack: `peer` reports it has consumed `bytes` for `paneId`. Subtracts
   * from the peer's outstanding tally and, when the pane's slowest peer drops
   * to or below the low watermark, fires `client.setPaneAction(paneId, Continue)`
   * exactly once.
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
   * slowest remaining peer is at or below the low watermark. Used
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
   * slowest remaining peer is at or below the low watermark. The peer's slot
   * is removed BEFORE the resume decisions so it no longer counts for any
   * pane. Idempotent — a peer with no slot is a no-op.
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

  /**
   * Tear down every peer this ledger holds (resuming panes whose remaining sum
   * hits zero), then flush any pane still paused but not being resumed. The
   * ledger owns its own peer roster, so the composing façade fans `dispose` out
   * to here rather than tracking a separate peer set. [LAW:one-source-of-truth]
   */
  dispose(): void {
    for (const peer of [...this.outstanding.keys()]) this.releasePeer(peer);
    this.flushPausedPanes();
  }
}
