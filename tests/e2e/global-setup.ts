// tests/e2e/global-setup.ts
// Playwright global setup — runs once before any spec.
//
// Prunes orphan tmux sockets left in /tmp/tmux-$UID/ by previous test
// runs that exited without their afterAll cleanup (Ctrl-C, crash, OOM).
//
// Three filters in series; an entry must clear ALL THREE before we touch
// it. Failing any one is "skip and never act."
//
//   FILTER 1 — Allow-list of socket names we own.
//       The name must match E2E_SOCKET_PATTERN (the regex anchored to
//       the e2e prefix in socket-naming.ts). The user's `default`
//       server, every other tool's sockets (`promptctl-*`,
//       `cc-probe-*`, …), and any session the user named manually all
//       fail this check and are invisible to the cleanup. Defense in
//       depth: an explicit `default` skip too.
//
//   FILTER 2 — PID liveness.
//       The owning PID encoded in the filename is checked with
//       `process.kill(pid, 0)`. If the spawning Node process is still
//       alive, that's a sibling test in progress — skip. False-negative
//       side is the safe direction: a recycled PID makes us THINK the
//       socket is in use, so it survives one extra cycle.
//
//   FILTER 3 — Server liveness.
//       Even if the owning PID is gone, `tmux -L NAME list-sessions` is
//       run as a final probe. If it succeeds, a server is bound to the
//       socket — leave it alone. Catches the unlikely race where the
//       owner exits but tmux is still draining clients.
//
// Only after all three pass do we kill-server (idempotent) + unlink.

import { existsSync, readdirSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";

import { E2E_SOCKET_PATTERN, ownerPidOf } from "./socket-naming.js";

function tmuxSocketDir(): string {
  // tmux puts named sockets at /tmp/tmux-<UID>/<NAME>. process.getuid
  // is unavailable on Windows; we don't run e2e there.
  const uid =
    typeof process.getuid === "function" ? process.getuid() : "unknown";
  return `/tmp/tmux-${uid}`;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "EPERM") {
      // Process exists but we can't signal it. Treat as alive — safer.
      return true;
    }
    return false;
  }
}

function isServerAlive(socketName: string): boolean {
  try {
    execSync(`tmux -L ${socketName} list-sessions`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function pruneOne(dir: string, name: string, ownerPid: number): void {
  const path = join(dir, name);
  // kill-server is idempotent: it errors silently if no server is
  // bound. Do it anyway for the rare case where filter 3 raced.
  try {
    execSync(`tmux -L ${name} kill-server`, { stdio: "ignore" });
  } catch {
    // No server. Move on.
  }
  // Unlink the socket file. If kill-server already removed it, force:true
  // is a no-op.
  try {
    rmSync(path, { force: true });
  } catch {
    // Best effort — nothing else to do.
  }
  // Logged so a CI failure investigation can correlate orphan cleanup
  // with the test that left it behind.
  // eslint-disable-next-line no-console
  console.log(`[e2e] pruned orphan tmux socket ${name} (dead pid ${ownerPid})`);
}

export default function globalSetup(): void {
  const dir = tmuxSocketDir();
  if (!existsSync(dir)) return;

  for (const name of readdirSync(dir)) {
    // FILTER 1a: defense in depth. The pattern below would not match
    // `default` either, but explicit > implicit when the failure mode
    // is "you killed the user's tmux server."
    if (name === "default") continue;
    // FILTER 1b: name must match our e2e schema.
    if (!E2E_SOCKET_PATTERN.test(name)) continue;

    // FILTER 2: owning PID must be dead.
    const ownerPid = ownerPidOf(name);
    if (ownerPid === null) continue; // belt-and-suspenders; pattern matched implies non-null
    if (isPidAlive(ownerPid)) continue;

    // FILTER 3: server on this socket must not be running.
    if (isServerAlive(name)) continue;

    pruneOne(dir, name, ownerPid);
  }
}
