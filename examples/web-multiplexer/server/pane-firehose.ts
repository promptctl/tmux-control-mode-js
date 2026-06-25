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
// [LAW:no-ambient-temporal-coupling] Tap lifecycle has one explicit owner:
//   `start` taps every current pane, a low-rate `refresh` taps panes created
//   later and untaps panes that vanished, `stop` untaps everything and removes
//   the FIFOs. Nothing depends on incidental call ordering.

import {
  createReadStream,
  mkdtempSync,
  rmSync,
  type ReadStream,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandResponse } from "@promptctl/tmux-control-mode-js/protocol";

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

/** One tapped pane: its FIFO path and the stream draining it. */
interface Tap {
  readonly fifoPath: string;
  readonly stream: ReadStream;
}

export class PaneFirehose {
  private readonly taps = new Map<number, Tap>();
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
   * Tap one pane: create its FIFO, open a read stream (opened `r+` so the read
   * end survives independent of the writer), then point `pipe-pane` at it. The
   * read end is opened BEFORE `pipe-pane` so the writer `cat` always finds a
   * reader.
   */
  private tap(paneId: number): void {
    if (this.dir === null) return;
    const fifoPath = join(this.dir, String(paneId));
    try {
      execFileSync("mkfifo", [fifoPath]);
    } catch (err) {
      console.warn(`[firehose] mkfifo failed for %${paneId}:`, err);
      return;
    }

    // `r+` (O_RDWR) keeps the stream open across the writer coming and going,
    // so a pane that pauses output never yields a spurious EOF. Pane removal is
    // detected by re-enumeration in `refresh`, not by stream end.
    const stream = createReadStream(fifoPath, { flags: "r+" });
    stream.on("data", (buf: Buffer | string) => {
      const bytes = typeof buf === "string" ? Buffer.from(buf) : buf;
      this.onBytes(paneId, new Uint8Array(bytes));
    });
    stream.on("error", (err) => {
      console.warn(`[firehose] fifo read error for %${paneId}:`, err.message);
      this.untap(paneId);
    });
    this.taps.set(paneId, { fifoPath, stream });

    // A pane that closed between enumerate and tap fails here — expected churn,
    // surfaced as a warning, not fatal. [LAW:no-silent-failure]
    void this.execute(`pipe-pane -t %${paneId} "cat >> '${fifoPath}'"`).then(
      (resp) => {
        if (!resp.success) {
          console.warn(`[firehose] pipe-pane failed for %${paneId}`);
          this.untap(paneId);
        }
      },
    );
  }

  /** Stop piping a pane, close its stream, and remove its FIFO. */
  private untap(paneId: number): void {
    const tap = this.taps.get(paneId);
    if (tap === undefined) return;
    this.taps.delete(paneId);
    tap.stream.destroy();
    // Best-effort: the pane may already be gone, in which case pipe-pane errors
    // harmlessly. We don't await — teardown shouldn't block on tmux.
    void this.execute(`pipe-pane -t %${paneId}`).catch(() => {});
    try {
      rmSync(tap.fifoPath, { force: true });
    } catch {
      // Best effort.
    }
  }
}
