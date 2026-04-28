// tests/e2e/socket-naming.ts
// One-source-of-truth for the e2e suite's tmux socket naming and the
// shared "is socket alive" classifier used by both the orphan-prune
// pass and (forthcoming) the demo's socket picker.
//
// tmux puts named sockets at /tmp/tmux-<UID>/<NAME>; both the spec and
// the prune pass operate against that directory.

import { execSync } from "node:child_process";

// [LAW:single-enforcer] All e2e socket names start with this prefix so
// they're greppable when something does leak. The prune pass does NOT
// gate on this prefix — it cleans every dead socket except `default` —
// but keeping the prefix makes ad-hoc inspection (`ls /tmp/tmux-$UID/ |
// grep web-multiplexer-e2e-`) trivial.
export const E2E_SOCKET_PREFIX = "web-multiplexer-e2e-";

/**
 * Build a unique e2e socket NAME (suitable for `tmux -L NAME`).
 * The PID + base36 timestamp give per-run uniqueness even when the
 * runtime clock has low resolution.
 */
export function e2eSocketName(pid: number, now: number): string {
  return `${E2E_SOCKET_PREFIX}${pid}-${now.toString(36)}`;
}

/** Filesystem location of the tmux socket directory for the running user. */
export function tmuxSocketDir(): string {
  // tmux puts named sockets at /tmp/tmux-<UID>/. process.getuid is
  // unavailable on Windows; we don't run e2e there.
  const uid =
    typeof process.getuid === "function" ? process.getuid() : "unknown";
  return `/tmp/tmux-${uid}`;
}

/**
 * Probe whether a tmux server is bound to the named socket.
 *
 * `list-sessions` is the canonical liveness probe: it exits 0 when the
 * server is reachable (regardless of whether it has any sessions yet)
 * and non-zero with "no server running" when the socket is dead. We
 * ignore stdio because we only care about the exit status.
 */
export function isServerAlive(socketName: string): boolean {
  try {
    execSync(`tmux -L ${socketName} list-sessions`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
