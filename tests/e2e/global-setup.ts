// tests/e2e/global-setup.ts
// Playwright global setup — runs once before any spec.
//
// Cleans up dead tmux sockets in /tmp/tmux-$UID/. The policy is the
// simplest one that still gives "absolute guarantees" against touching
// anything in use:
//
//   1. Always skip `default`. Hard rule, no liveness probing — the
//      user's primary tmux server is never a candidate.
//
//   2. For everything else: probe `tmux -L NAME list-sessions`. If a
//      server is bound to the socket, leave it alone. If no server
//      answers, the file is dead residue from a process that exited
//      without cleanup — unlink it.
//
// Liveness via the server probe is the canonical "in use" signal; we
// don't need PID-aliveness or name allow-listing on top. The trade-off
// vs. an allow-list of our own prefixes: dead sockets owned by other
// tools (promptctl-*, cc-probe-*, …) get cleaned too. Those files are
// harmless when dead, so the cost is negligible and the user benefits
// from a tidy /tmp.

import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { isServerAlive, tmuxSocketDir } from "./socket-naming.js";

export default function globalSetup(): void {
  const dir = tmuxSocketDir();
  if (!existsSync(dir)) return;

  const removed: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "default") continue; // hard skip — see policy above
    if (isServerAlive(name)) continue; // server bound → in use

    try {
      rmSync(join(dir, name), { force: true });
      removed.push(name);
    } catch {
      // Best effort. A failure here is informational, not blocking.
    }
  }

  if (removed.length > 0) {
    // eslint-disable-next-line no-console
    console.log(
      `[e2e] removed ${removed.length} dead tmux socket(s) from ${dir}`,
    );
  }
}
