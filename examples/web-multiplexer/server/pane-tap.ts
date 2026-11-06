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
// [LAW:single-enforcer] It also owns the failure policy. Every way a tap can
//   fail to stand up or die (mkfifo throws, `pipe-pane` rejects or returns
//   %error, the FIFO read errors) goes through one path: log the detail here,
//   tear down, then fire `onReadError` on a later microtask. Callers never wrap
//   the call in try/catch; they react only through `onReadError`.

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
   * Invoked at most once when the tap dies on its own: it could not stand up
   * (mkfifo failed, or `pipe-pane` failed because the pane vanished) or its
   * FIFO read errored. Always invoked asynchronously, after `tapPaneToFifo`
   * has returned, so an owner can reference the object it is building. NOT
   * invoked when the caller's disposer is what stops the tap. The detail is
   * logged here; the owner only decides what the death means to it.
   */
  readonly onReadError?: () => void;
}

/**
 * Tap `paneId` into a FIFO under `dir` and drain it to `onBytes`. Returns a
 * disposer that stops the `pipe-pane`, closes the stream, and removes the FIFO;
 * calling it twice is safe. The caller owns `dir` (its creation and removal) so
 * one directory can host many taps.
 *
 * Never throws. A leftover path at the FIFO's location is removed first, so a
 * stale FIFO from an earlier tap cannot block this one. Any failure tears the
 * tap down (removing the FIFO) and reports through `onReadError`.
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
  // routes through `fail`, which additionally fires `onReadError`.
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    stream?.destroy();
    stream = null;
    // Best-effort: the pane may already be gone, in which case pipe-pane errors
    // harmlessly. Not awaited — teardown shouldn't block on tmux.
    void execute(`pipe-pane -t %${paneId}`).catch(() => {
      // no-op: the pane being gone already detached the pipe (see above).
    });
    try {
      rmSync(fifoPath, { force: true });
    } catch {
      // Best effort — a leftover FIFO under a soon-removed dir is harmless.
    }
  };

  const fail = (detail: string): void => {
    if (disposed) return;
    console.warn(`[pane-tap] tap of %${paneId} failed: ${detail}`);
    dispose();
    // Deferred so the callback never runs inside the caller's construction.
    queueMicrotask(() => options.onReadError?.());
  };

  try {
    rmSync(fifoPath, { force: true });
    execFileSync("mkfifo", [fifoPath]);
  } catch (err) {
    fail(`mkfifo: ${err instanceof Error ? err.message : String(err)}`);
    return dispose;
  }

  // `r+` keeps the read end open across the writer coming and going.
  stream = createReadStream(fifoPath, { flags: "r+" });
  stream.on("data", (buf: Buffer | string) => {
    const bytes = typeof buf === "string" ? Buffer.from(buf) : buf;
    onBytes(new Uint8Array(bytes));
  });
  stream.on("error", (err) => fail(`fifo read: ${err.message}`));

  void execute(`pipe-pane -t %${paneId} "cat >> '${fifoPath}'"`).then(
    (resp) => {
      if (!resp.success) fail("pipe-pane returned %error");
    },
    (err: unknown) =>
      fail(`pipe-pane: ${err instanceof Error ? err.message : String(err)}`),
  );

  return dispose;
}
