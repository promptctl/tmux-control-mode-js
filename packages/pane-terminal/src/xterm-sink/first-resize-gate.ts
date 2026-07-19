// packages/pane-terminal/src/xterm-sink/first-resize-gate.ts
//
// FirstResizeGate — the seed/first-resize ordering state machine, extracted
// from XtermSink as a *pure* collaborator (no DOM, no xterm, no rAF).
//
// The problem it owns: XtermSink defers its very first `term.resize()` by one
// rAF (xterm's renderer `dimensions` object is not instantiated until the first
// render tick, so a synchronous resize inside `term.open()` throws). While that
// defer is pending, both the seed snapshot and the trailing live bytes arrive,
// and they MUST reach xterm in the order `seed → live bytes`, all written at
// the correct terminal dimensions. This gate is the single owner of that
// ordering invariant: it buffers content until released, then hands it back in
// order for XtermSink to apply.
//
// [LAW:effects-at-boundaries] The gate computes *what* to write and in *what*
//   order; it never touches xterm. XtermSink (the effect boundary) performs the
//   writes returned in a `DrainBatch`. A pure gate is unit-testable with zero
//   DOM.
// [LAW:one-source-of-truth] The seed-before-live ordering lived scattered
//   across XtermSink's seed()/write()/resize()/drain before; it now lives here,
//   in one class. tmux-complexity-lkg.12 (SD2) unifies the two-scheduler
//   handshake across PaneStream + this gate — concentrating the ordering here
//   is what makes that a change to one collaborator's input contract, not a
//   cross-file untangle.
// [LAW:no-ambient-temporal-coupling] The gate holds no timer of its own. The
//   rAF that drives the first-resize defer stays in XtermSink (its single
//   timing authority); the gate only reacts to `release()` being called.

import type { SeedCursor } from "../sink/index.js";

/** A buffered seed snapshot: the captured bytes plus optional cursor position. */
export interface SeedContent {
  readonly captured: Uint8Array;
  readonly cursor: SeedCursor | null;
}

/**
 * Content released from the gate in application order: the pending seed (if
 * any) first, then the buffered live writes. XtermSink applies `seed` then
 * iterates `writes`, preserving the seed-before-live guarantee.
 */
export interface DrainBatch {
  readonly seed: SeedContent | null;
  readonly writes: readonly Uint8Array[];
}

// [LAW:no-silent-failure] Upper bound on bytes held before the first resize.
// The buffer preserves seed-before-live ordering across the one-rAF first-resize
// defer — normally drained within a round-trip of attach. But `resize()` is
// driven ONLY by tmux's pane-size subscription; if that subscription failed
// (PaneStream surfaces this on its 'error' seam), the resize never comes and
// this buffer would grow without limit behind a permanently blank screen. On
// crossing the cap the gate DRAINS (never drops — dropping would lose data while
// still reporting success), letting XtermSink render at xterm's current
// dimensions; a later real resize reflows. 4 MiB is generous for the transient
// window yet bounds the pathological no-resize path.
export const DEFAULT_PENDING_WRITES_CAP_BYTES = 4 * 1024 * 1024;

/**
 * State machine with two phases: `buffering` (before the first resize / cap
 * drain) and `open` (steady state). Callers MUST consult `buffering` before
 * offering content — the buffer methods assume the buffering phase, and the
 * live-write hot path bypasses the gate entirely once open so it never
 * allocates per byte.
 */
export class FirstResizeGate {
  private phase: "buffering" | "open" = "buffering";
  private pendingSeed: SeedContent | null = null;
  private pendingWrites: Uint8Array[] = [];
  private pendingWritesBytes = 0;

  constructor(
    private readonly capBytes: number = DEFAULT_PENDING_WRITES_CAP_BYTES,
  ) {}

  /**
   * True while content must be buffered. Once `false`, XtermSink writes to
   * xterm directly and never calls the buffer methods again — keeping the live
   * byte path zero-allocation.
   */
  get buffering(): boolean {
    return this.phase === "buffering";
  }

  /**
   * Buffer a seed snapshot. Latest wins: a second seed before release simply
   * overwrites the first (newer content supersedes any re-seed).
   *
   * Precondition: `buffering` is true — enforced loudly (throws), not merely
   * documented. Buffering after the gate opened would strand the content in a
   * field no later call drains, a silent data loss; surface it instead.
   */
  bufferSeed(content: SeedContent): void {
    this.assertBuffering("bufferSeed");
    this.pendingSeed = content;
  }

  /**
   * Buffer a live write. Returns `null` while under the cap, or a `DrainBatch`
   * (and transitions to `open`) when the accumulated bytes cross the cap — the
   * no-resize safety valve.
   *
   * Precondition: `buffering` is true — enforced loudly (throws), see
   * `bufferSeed`.
   */
  bufferWrite(data: Uint8Array): DrainBatch | null {
    this.assertBuffering("bufferWrite");
    this.pendingWrites.push(data);
    this.pendingWritesBytes += data.byteLength;
    if (this.pendingWritesBytes > this.capBytes) {
      return this.drain();
    }
    return null;
  }

  /**
   * Release buffered content in order and transition to `open`. Called from
   * XtermSink's first-resize rAF after `term.resize()`. Idempotent: if a
   * cap-forced drain already opened the gate, this returns an empty batch and
   * stays open.
   */
  release(): DrainBatch {
    return this.drain();
  }

  /** Drop all buffered content. Called from XtermSink.dispose(). */
  dispose(): void {
    this.phase = "open";
    this.pendingSeed = null;
    this.pendingWrites = [];
    this.pendingWritesBytes = 0;
  }

  // [LAW:no-silent-failure] The buffer methods are only meaningful before the
  // gate opens; calling them afterwards would push content into a field that no
  // later call drains (the caller, seeing an open gate, writes directly and
  // never touches the gate again). Rather than lose that data silently, fail
  // loudly. Unreachable via the sole caller (XtermSink checks `buffering`
  // first), but the right failure mode if a future caller forgets to.
  private assertBuffering(method: string): void {
    if (this.phase !== "buffering") {
      throw new Error(
        `FirstResizeGate.${method} called after the gate opened — content would be lost`,
      );
    }
  }

  private drain(): DrainBatch {
    const batch: DrainBatch = {
      seed: this.pendingSeed,
      writes: this.pendingWrites,
    };
    this.phase = "open";
    this.pendingSeed = null;
    this.pendingWrites = [];
    this.pendingWritesBytes = 0;
    return batch;
  }
}
