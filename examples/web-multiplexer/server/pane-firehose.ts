// examples/web-multiplexer/server/pane-firehose.ts
// PaneFirehose — taps the live output of EVERY pane in EVERY session at once,
// regardless of which session a control client is attached to.
//
// THE DISCOVERY (see tmux-showcase-bhx.2): tmux control mode streams live
// `%output` only for the ATTACHED session. "tail -f | grep across everything"
// therefore cannot come from the attached `%output` channel. `pipe-pane` is the
// tmux primitive that taps any pane regardless of focus — verified live: with
// zero clients attached, `pipe-pane -t %N "cat >> fifo"` delivers that pane's
// bytes to the fifo. PaneFirehose fans `pipe-pane` over all panes and reads the
// per-pane FIFOs.
//
// [LAW:single-enforcer] ONE firehose implementation. Both transports' host
//   processes (the WebSocket bridge server and the Electron main process)
//   construct a PaneFirehose; neither re-implements the tap/read mechanics.
// [LAW:decomposition] It depends only on `execute` (run a tmux command and get
//   its response) and `onBytes` (forward tapped bytes). It knows nothing about
//   sockets, WebSocket frames, or IPC — the transport owns the wire encoding.
//   The per-pane tap mechanics live in `./pane-tap.ts`, shared with the mirror.
// [LAW:no-ambient-temporal-coupling] Tap lifecycle has one explicit owner:
//   `start` taps every current pane, a low-rate `refresh` taps panes created
//   later and untaps panes that vanished, `stop` untaps everything and removes
//   the FIFOs. Nothing depends on incidental call ordering.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isConnectionGone } from "@promptctl/tmux-control-mode-js";
import type { CommandResponse } from "@promptctl/tmux-control-mode-js/protocol";
import { reportDetachedFailure } from "./detached-failure.js";
import { tapPaneToFifo } from "./pane-tap.js";

/**
 * Run a tmux command over the host's control connection. A `%error` may reject
 * (the library's `execute`) or resolve unsuccessful; both are a failure.
 */
export type FirehoseExecute = (command: string) => Promise<CommandResponse>;

/** Forward one chunk of tapped pane bytes. */
export type FirehoseSink = (paneId: number, data: Uint8Array) => void;

export interface PaneFirehoseOptions {
  /** How often to re-enumerate panes to tap new ones / drop vanished ones. */
  readonly refreshIntervalMs?: number;
  /** Clock for the retry backoff; injectable so tests control time. */
  readonly now?: () => number;
}

/** Default cadence for discovering panes created after the firehose started. */
const DEFAULT_REFRESH_MS = 1500;

/** Longest wait before re-tapping a pane whose taps keep dying. */
const MAX_RETRY_MS = 60_000;

/**
 * A pane whose tap died and has not yet delivered a byte since. Each death in
 * the streak doubles the wait before the next attempt (refresh interval, then
 * 2x, 4x, … capped at MAX_RETRY_MS), so a host where mkfifo or pipe-pane keeps
 * failing costs one blocking spawn and one warning per pane per backoff step,
 * not per refresh tick. The streak ends when the pane delivers bytes or leaves
 * `list-panes`.
 */
interface RetryState {
  readonly failures: number;
  readonly retryAt: number;
}

export class PaneFirehose {
  // paneId → disposer returned by `tapPaneToFifo`. The set of keys IS the set
  // of tapped panes (the derived projection of `list-panes -a`).
  private readonly taps = new Map<number, () => void>();
  private readonly retries = new Map<number, RetryState>();
  private dir: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private refreshing = false;
  private stopped = false;

  constructor(
    private readonly execute: FirehoseExecute,
    private readonly onBytes: FirehoseSink,
    private readonly options: PaneFirehoseOptions = {},
  ) {}

  /**
   * Tap every current pane and begin draining their FIFOs, then keep tapping
   * panes that appear later. Rejects if the first enumeration fails; the
   * refresh timer is already running and keeps trying. Idempotent: a second
   * `start` while running is a no-op. Rejects once the firehose has ended —
   * stopped, or its connection gone — since it will never tap again.
   */
  async start(): Promise<void> {
    if (this.stopped) throw new Error("firehose has ended; start a new one");
    if (this.dir !== null) return;
    this.dir = mkdtempSync(join(tmpdir(), "tmux-firehose-"));
    const interval = this.options.refreshIntervalMs ?? DEFAULT_REFRESH_MS;
    // The timer fires and forgets, so a failed tick is reported here.
    this.timer = setInterval(() => {
      this.refresh().catch((err: unknown) => {
        reportDetachedFailure("[firehose] refresh", err);
      });
    }, interval);
    await this.refresh();
  }

  /**
   * Untap every pane, close every FIFO stream, and remove the FIFO directory.
   * Safe to call more than once.
   */
  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const paneId of [...this.taps.keys()]) {
      this.untap(paneId);
    }
    if (this.dir !== null) {
      try {
        rmSync(this.dir, { recursive: true, force: true });
      } catch {
        // Best effort — the streams are closed; a leftover dir is harmless.
      }
      this.dir = null;
    }
  }

  /**
   * Re-enumerate panes: tap any not yet tapped, untap any that vanished. The
   * single source of "which panes exist" is `list-panes -a`; the tap set is a
   * derived projection kept in lock-step with it. [LAW:one-source-of-truth]
   *
   * [LAW:no-silent-failure] A failed enumeration rejects, so it is never read
   * as "zero panes" (which would untap everything): the tap set is left as-is.
   */
  private async refresh(): Promise<void> {
    if (this.refreshing || this.dir === null || this.stopped) return;
    this.refreshing = true;
    try {
      const listed = await this.execute("list-panes -a -F '#{pane_id}'").catch(
        (err: unknown) => {
          // A gone connection never answers again and took every tap with
          // it: the firehose ends rather than poll it unseen.
          if (isConnectionGone(err)) this.stop();
          throw err;
        },
      );
      if (!listed.success) {
        throw new Error(`list-panes failed: ${listed.output.join(" ")}`);
      }
      const current = new Set(
        listed.output.flatMap((line) => {
          const m = /^%(\d+)/.exec(line.trim());
          return m !== null ? [Number(m[1])] : [];
        }),
      );

      const now = this.now();
      for (const paneId of current) {
        if (this.taps.has(paneId)) continue;
        const retry = this.retries.get(paneId);
        if (retry !== undefined && retry.retryAt > now) continue;
        this.tap(paneId);
      }
      for (const paneId of [...this.retries.keys()]) {
        if (!current.has(paneId)) this.retries.delete(paneId);
      }
      for (const paneId of [...this.taps.keys()]) {
        if (!current.has(paneId)) this.untap(paneId);
      }
    } finally {
      this.refreshing = false;
    }
  }

  /**
   * Tap one pane via the shared `tapPaneToFifo` primitive, fanning its bytes
   * out tagged with `paneId`. Pane removal is detected by re-enumeration in
   * `refresh`, not by stream end.
   */
  private tap(paneId: number): void {
    if (this.dir === null) return;
    const dispose = tapPaneToFifo(
      this.execute,
      this.dir,
      paneId,
      (data) => {
        this.retries.delete(paneId);
        this.onBytes(paneId, data);
      },
      // A tap that died must leave the map so a later `refresh` can re-tap a
      // still-present pane — preserving "map keys == live taps" — and must
      // push that retry back. [LAW:one-source-of-truth]
      { onReadError: () => this.tapDied(paneId, dispose) },
    );
    this.taps.set(paneId, dispose);
  }

  private tapDied(paneId: number, dispose: () => void): void {
    if (this.taps.get(paneId) !== dispose) return;
    this.taps.delete(paneId);
    const failures = (this.retries.get(paneId)?.failures ?? 0) + 1;
    const interval = this.options.refreshIntervalMs ?? DEFAULT_REFRESH_MS;
    const wait = Math.min(interval * 2 ** (failures - 1), MAX_RETRY_MS);
    this.retries.set(paneId, { failures, retryAt: this.now() + wait });
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /** Stop piping a pane, close its stream, and remove its FIFO. */
  private untap(paneId: number): void {
    const dispose = this.taps.get(paneId);
    if (dispose === undefined) return;
    this.taps.delete(paneId);
    dispose();
  }
}
