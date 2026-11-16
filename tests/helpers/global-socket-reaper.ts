// vitest globalSetup: give this run a tmux namespace of its own, and reap.
//
// `setup()` reaps the namespaces of runs that were killed before their own
// teardown, then points TMUX_TMPDIR at this run's — the workers vitest starts
// next inherit it, so every tmux they spawn lands there. `teardown()` reaps
// this run's namespace. Registered via `test.globalSetup` in vitest.config.ts.
// See reap-test-sockets.ts for why ownership is a directory.

import { mkdirSync } from "node:fs";
import {
  processAlive,
  reapDeadRuns,
  reapRun,
  runDir,
} from "./reap-test-sockets.js";

const dir = runDir(process.pid);

function report(phase: "pre-run" | "post-run", reaped: string[]): void {
  // Loud only when it reaped — a recurring nonzero count is the signal that
  // runs are being killed, or tests are leaving servers. [LAW:no-silent-failure]
  if (reaped.length > 0) {
    console.log(
      `[reap-test-sockets] ${phase}: killed ${reaped.length} tmux server(s) left running: ${reaped.join(" ")}`,
    );
  }
}

export function setup(): void {
  // A namespace already named for this pid is a dead run's that this run's
  // pid reused: this run has not made its own yet.
  report(
    "pre-run",
    reapDeadRuns(undefined, (pid) => pid !== process.pid && processAlive(pid)),
  );
  // Owner-only, as tmux keeps its own socket directory.
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  process.env.TMUX_TMPDIR = dir;
}

export function teardown(): void {
  report("post-run", reapRun(dir));
}
