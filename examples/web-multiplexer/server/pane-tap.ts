// examples/web-multiplexer/server/pane-tap.ts
// PaneTap — tap ONE pane's live pty bytes via `pipe-pane` into a FIFO and drain
// it to a byte sink. The single implementation of "observe a pane's raw output,
// focus-independent" — the mechanism the regex/image/recorder firehose
// (`PaneFirehose`, tap-every-pane) and the read-only mirror (`MirrorRegistry`,
// tap-a-named-pane) both reduce to.
//
// THE MECHANISM (see tmux-showcase-bhx.2): tmux control mode streams live
// `%output` only for the ATTACHED session. `pipe-pane -t %N "cat >> fifo"` taps
// any pane regardless of which session a control client is viewing (verified:
// reaches panes with zero clients attached). The read end is opened `r+`
// (O_RDWR) BEFORE `pipe-pane` so the writer `cat` always finds a reader and a
// pane that pauses output never yields a spurious EOF.
//
// [LAW:single-enforcer] ONE place knows the mkfifo + pipe-pane + read-stream
//   dance. Two callers wanted it; this is where it lives so neither drifts.
// [LAW:decomposition] Depends only on `execute` (run a tmux command, get a
//   response) and `onBytes` (forward tapped bytes). It knows nothing about
//   sockets, FIFO directory ownership, or which panes are interesting — the
//   caller owns the lifecycle and the byte destination.
// [LAW:no-silent-failure] A `pipe-pane` that fails (pane closed between the
//   caller's enumeration and the tap) untaps itself and surfaces a warning,
//   rather than leaving a dead FIFO masquerading as a live tap.

import { createReadStream, rmSync, type ReadStream } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { CommandResponse } from "@promptctl/tmux-control-mode-js/protocol";

/** Run a tmux command (over the host's control connection) and resolve its response. */
export type TapExecute = (command: string) => Promise<CommandResponse>;

/** Forward one chunk of tapped pane bytes. */
export type TapSink = (data: Uint8Array) => void;

export interface PaneTapOptions {
  /**
   * Invoked at most once when the tap tears ITSELF down — a failed `pipe-pane`
   * (the pane vanished before the tap stood up) or a FIFO read error. NOT
   * invoked when the caller's disposer is what stops the tap. Lets the owner
   * drop the pane from its live-tap set (so a firehose `refresh` can re-tap) or
   * surface a "pane gone" signal to a mirror's viewers. [LAW:no-silent-failure]
   */
  readonly onReadError?: () => void;
}

/**
 * Tap `paneId` into a FIFO under `dir` and drain it to `onBytes`. Returns a
 * disposer that stops the `pipe-pane`, closes the stream, and removes the FIFO;
 * calling it twice is safe. The caller owns `dir` (its creation and removal) so
 * one directory can host many taps.
 *
 * The tap is best-effort to STAND UP — a pane that vanished between the caller
 * deciding to tap it and this call fails the `pipe-pane` and self-disposes — but
 * once standing it stays live until disposed or the FIFO read errors.
 */
export function tapPaneToFifo(
  execute: TapExecute,
  dir: string,
  paneId: number,
  onBytes: TapSink,
  options: PaneTapOptions = {},
): () => void {
  const fifoPath = join(dir, String(paneId));
  let stream: ReadStream | null = null;
  let disposed = false;

  // Tear-down owned by the caller's disposer. Self-tear-down (error paths)
  // routes through `selfDispose`, which additionally fires `onReadError`.
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    stream?.destroy();
    stream = null;
    // Best-effort: the pane may already be gone, in which case pipe-pane errors
    // harmlessly. Not awaited — teardown shouldn't block on tmux.
    void execute(`pipe-pane -t %${paneId}`).catch(() => {});
    try {
      rmSync(fifoPath, { force: true });
    } catch {
      // Best effort — a leftover FIFO under a soon-removed dir is harmless.
    }
  };

  const selfDispose = (): void => {
    if (disposed) return;
    dispose();
    options.onReadError?.();
  };

  try {
    execFileSync("mkfifo", [fifoPath]);
  } catch (err) {
    console.warn(`[pane-tap] mkfifo failed for %${paneId}:`, err);
    selfDispose();
    return dispose;
  }

  // `r+` keeps the read end open across the writer coming and going.
  stream = createReadStream(fifoPath, { flags: "r+" });
  stream.on("data", (buf: Buffer | string) => {
    const bytes = typeof buf === "string" ? Buffer.from(buf) : buf;
    onBytes(new Uint8Array(bytes));
  });
  stream.on("error", (err) => {
    console.warn(`[pane-tap] fifo read error for %${paneId}:`, err.message);
    selfDispose();
  });

  void execute(`pipe-pane -t %${paneId} "cat >> '${fifoPath}'"`).then((resp) => {
    if (!resp.success && !disposed) {
      console.warn(`[pane-tap] pipe-pane failed for %${paneId}`);
      selfDispose();
    }
  });

  return dispose;
}
