// tests/e2e/global-setup.ts
// Playwright global setup — runs once before any spec.
//
// Prune orphan tmux sockets left in E2E_SOCKET_DIR by previous test runs
// that exited without their afterAll cleanup (Ctrl-C, crash, OOM). The
// pass has two safety guarantees:
//
//   1. **Path isolation.** We only ever operate in E2E_SOCKET_DIR — a
//      dedicated directory under os.tmpdir(). The user's default tmux
//      server lives in /tmp/tmux-$UID/, so it's not even reachable from
//      this code path. By construction we cannot kill it.
//
//   2. **PID-aliveness check.** Each socket filename embeds the Node PID
//      that created it. Before pruning, we check `process.kill(pid, 0)`
//      to see if that process is still alive. If it is, we leave the
//      socket alone — that's a sibling test run still in progress.
//      False-negative side is the safe direction: a stale leftover whose
//      original PID has been recycled survives one extra cycle, but a
//      live test never gets nuked.
//
// Filenames that don't match our schema are skipped — we never act on a
// file we didn't create.

import { existsSync, readdirSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";

import { E2E_SOCKET_DIR, ownerPidOf } from "./socket-dir.js";

function isPidAlive(pid: number): boolean {
  try {
    // Signal 0 doesn't kill — it just probes for existence + permissions.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but we can't signal it (uncommon
    // when we own the file, but treat as alive — safer.)
    if (err instanceof Error && "code" in err && err.code === "EPERM") {
      return true;
    }
    return false;
  }
}

function pruneOne(socketPath: string, ownerPid: number): void {
  // Try to ask tmux to shut down a server on this socket. tmux is a
  // no-op + nonzero exit if no server is listening; that's fine — the
  // file itself is what we want gone.
  try {
    execSync(`tmux -S ${socketPath} kill-server`, { stdio: "ignore" });
  } catch {
    // No server running. Move on.
  }
  // Remove the socket file. If tmux just unlinked it during kill-server,
  // rmSync with force:true is a no-op.
  try {
    rmSync(socketPath, { force: true });
  } catch {
    // Best effort; nothing to do.
  }
  // Logged so a CI failure investigation can correlate orphan cleanup
  // with the test that left it behind.
  // eslint-disable-next-line no-console
  console.log(
    `[e2e] pruned orphan tmux socket from dead pid ${ownerPid}: ${socketPath}`,
  );
}

export default function globalSetup(): void {
  if (!existsSync(E2E_SOCKET_DIR)) return;
  const entries = readdirSync(E2E_SOCKET_DIR);
  for (const entry of entries) {
    const ownerPid = ownerPidOf(entry);
    if (ownerPid === null) continue; // not ours — leave it.
    if (isPidAlive(ownerPid)) continue; // sibling test still running.
    pruneOne(join(E2E_SOCKET_DIR, entry), ownerPid);
  }
}
