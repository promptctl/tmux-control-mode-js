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
import type { CommandResponse } from "@promptctl/tmux-control-mode-js/protocol";
import { tapPaneToFifo } from "./pane-tap.js";

/** Run a tmux command (over the host's control connection) and resolve its response. */
export type FirehoseExecute = (command: string) => Promise<CommandResponse>;

/** Forward one chunk of tapped pane bytes. */
export type FirehoseSink = (paneId: number, data: Uint8Array) => void;

export interface PaneFirehoseOptions {
  /** How often to re-enumerate panes to tap new ones / drop vanished ones. */
  readonly refreshIntervalMs?: number;
}

/** Default cadence for discovering panes created after the firehose started. */
const DEFAULT_REFRESH_MS = 1500;

export class PaneFirehose {
  // paneId → disposer returned by `tapPaneToFifo`. The set of keys IS the set
  // of tapped panes (the derived projection of `list-panes -a`).
  private readonly taps = new Map<number, () => void>();
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
   * panes that appear later. Idempotent: a second `start` while running is a
   * no-op.
   */
  async start(): Promise<void> {
    if (this.dir !== null || this.stopped) return;
    this.dir = mkdtempSync(join(tmpdir(), "tmux-firehose-"));
    await this.refresh();
    const interval = this.options.refreshIntervalMs ?? DEFAULT_REFRESH_MS;
    this.timer = setInterval(() => void this.refresh(), interval);
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
   */
  private async refresh(): Promise<void> {
    if (this.refreshing || this.dir === null || this.stopped) return;
    this.refreshing = true;
    try {
      const listed = await this.execute("list-panes -a -F '#{pane_id}'");
      // [LAW:no-silent-failure] A failed enumeration is surfaced, not treated
      // as "zero panes" (which would untap everything). Leave taps as-is.
      if (!listed.success) {
        console.warn("[firehose] list-panes failed; tap set unchanged");
        return;
      }
      const current = new Set(
        listed.output.flatMap((line) => {
          const m = /^%(\d+)/.exec(line.trim());
          return m !== null ? [Number(m[1])] : [];
        }),
      );

      for (const paneId of current) {
        if (!this.taps.has(paneId)) this.tap(paneId);
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
    this.taps.set(
      paneId,
      tapPaneToFifo(
        this.execute,
        this.dir,
        paneId,
        (data) => this.onBytes(paneId, data),
        // A self-tear-down (pipe-pane failure / FIFO read error) must drop the
        // map entry so the next `refresh` can re-tap a still-present pane —
        // preserving "map keys == live taps". [LAW:one-source-of-truth]
        { onReadError: () => this.taps.delete(paneId) },
      ),
    );
  }

  /** Stop piping a pane, close its stream, and remove its FIFO. */
  private untap(paneId: number): void {
    const dispose = this.taps.get(paneId);
    if (dispose === undefined) return;
    this.taps.delete(paneId);
    dispose();
  }
}
