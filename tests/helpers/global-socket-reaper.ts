// vitest globalSetup: give this run a tmux namespace of its own, and reap.
//
// `setup()` reaps the namespaces of runs that were killed before their own
// teardown, then points TMUX_TMPDIR at this run's — the workers vitest starts
// next inherit it, so every tmux they spawn lands there. `teardown()` reaps
// this run's namespace. Registered via `test.globalSetup` in vitest.config.ts.
// See reap-test-sockets.ts for why ownership is a directory.

import { mkdirSync } from "node:fs";
import { reapDeadRuns, reapRun, runDir } from "./reap-test-sockets.js";

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
  report("pre-run", reapDeadRuns());
  mkdirSync(dir, { recursive: true });
  process.env.TMUX_TMPDIR = dir;
}

export function teardown(): void {
  report("post-run", reapRun(dir));
}
