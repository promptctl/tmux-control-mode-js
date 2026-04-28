// tests/e2e/socket-dir.ts
// One-source-of-truth for where the e2e harness puts its tmux sockets.
//
// Sockets live OUTSIDE /tmp/tmux-$UID/ — that directory is shared with
// the user's default tmux server and any other tool that uses tmux. Our
// dedicated directory means cleanup passes can never reach a non-test
// socket: we don't even operate in the directory the default server
// lives in.
//
// Path is hardcoded to /tmp/<dir>/ rather than os.tmpdir() so it lands
// in the same place the user looks when they `ls /tmp`. (`os.tmpdir()`
// on macOS resolves to a per-user `/var/folders/...` path, which is
// correct but invisible.)
//
// Filename schema: `<pid>-<timestamp>-<rand>.sock`. The PID prefix lets
// the prune pass check liveness with `process.kill(pid, 0)` and skip
// sockets owned by a still-running test process.

import { join } from "node:path";

// [LAW:single-enforcer] One module owns the directory path and the
// filename schema. Anywhere else that needs to compute or parse a
// socket path imports from here.
export const E2E_SOCKET_DIR = "/tmp/tmux-control-mode-js-e2e";

// Constructed paths must always sit under E2E_SOCKET_DIR so the prune
// pass's path-isolation guarantee holds (see global-setup.ts).
function inSocketDir(filename: string): string {
  return join(E2E_SOCKET_DIR, filename);
}

const FILENAME_PATTERN = /^(\d+)-[0-9a-z]+-[0-9a-z]+\.sock$/;

/** Build a unique socket path under E2E_SOCKET_DIR. */
export function e2eSocketName(pid: number, now: number): string {
  const time = now.toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return inSocketDir(`${pid}-${time}-${rand}.sock`);
}

/** Extract the embedded PID from a socket filename, or null if it doesn't
 *  match our schema (so we never act on a file we didn't create). */
export function ownerPidOf(filename: string): number | null {
  const m = FILENAME_PATTERN.exec(filename);
  if (m === null) return null;
  const pid = Number.parseInt(m[1], 10);
  if (!Number.isFinite(pid) || pid <= 0) return null;
  return pid;
}
