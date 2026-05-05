// tests/e2e/global-setup.ts
// Playwright global setup — runs once before any spec.
//
// Cleans up dead tmux sockets in /tmp/tmux-$UID/ using the library's
// liveness primitives. Policy:
//
//   1. Always skip `default` — the user's primary tmux server.
//   2. For everything else: probe `tmux -L NAME list-sessions`. If a
//      server answers, leave alone. If not, the file is dead residue
//      from a process that exited without cleanup — unlink it.
//
// Same policy is applied at demo startup (see
// examples/web-multiplexer/electron/main.ts), so the picker can trust
// `readdir(tmuxSocketDir())` without re-probing liveness.

import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  tmuxSocketDir,
  listTmuxSocketNames,
  isTmuxServerAlive,
} from "@promptctl/tmux-control-mode-js";

export default function globalSetup(): void {
  const dir = tmuxSocketDir();
  if (!existsSync(dir)) return;

  const removed: string[] = [];
  for (const name of listTmuxSocketNames()) {
    if (name === "default") continue; // hard skip
    if (isTmuxServerAlive(name)) continue; // server bound → in use

    try {
      rmSync(join(dir, name), { force: true });
      removed.push(name);
    } catch {
      // Best effort — a failure here is informational, not blocking.
    }
  }

  if (removed.length > 0) {
    // eslint-disable-next-line no-console
    console.log(
      `[e2e] removed ${removed.length} dead tmux socket(s) from ${dir}`,
    );
  }
}
