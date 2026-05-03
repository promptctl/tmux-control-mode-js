// src/transport/sockets.ts
// Node-only filesystem-level utilities for tmux's named-socket directory.
//
// tmux stores named sockets (`tmux -L NAME`) at /tmp/tmux-<UID>/<NAME>.
// Consumers that drive multiple servers, want to enumerate live servers,
// or clean up after their own ephemeral test sockets all need the same
// three primitives:
//
//   - the directory path (UID-derived)
//   - listing the files in it (no liveness probing here)
//   - probing whether a server is bound to a given socket name
//
// Cleanup policy and "what to display in a picker" both live one layer
// up — this module deliberately does not own those decisions, only the
// primitives they're built from. See [LAW:no-mode-explosion]: a single
// "tidy up sockets" function would need flags for "skip default, allow
// any name, only my prefix, etc." — instead we expose neutral primitives
// and let callers compose policy from them.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";

/**
 * Filesystem location of the tmux named-socket directory for the
 * current user. Returns `/tmp/tmux-<UID>` on POSIX systems.
 *
 * Throws if the platform has no `process.getuid` (Windows) — tmux
 * itself is POSIX-only, so this should never happen in practice.
 */
export function tmuxSocketDir(): string {
  if (typeof process.getuid !== "function") {
    throw new Error(
      "tmuxSocketDir(): process.getuid is unavailable on this platform; " +
        "tmux is POSIX-only.",
    );
  }
  return `/tmp/tmux-${process.getuid()}`;
}

/**
 * Names of every file currently in the tmux socket directory, sorted
 * lexicographically. Empty array if the directory does not exist (no
 * tmux server has ever been started by this user).
 *
 * NB: this is a directory listing, not a liveness check. Some entries
 * may be dead socket files left by processes that exited without
 * cleanup. Use {@link isTmuxServerAlive} when you specifically need to
 * know whether a server is still bound.
 */
export function listTmuxSocketNames(): readonly string[] {
  const dir = tmuxSocketDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort();
}

/**
 * Probe whether a tmux server is bound to the named socket.
 *
 * `tmux -L NAME list-sessions` is the canonical liveness signal: it
 * exits 0 if the server is reachable (regardless of whether any
 * sessions exist yet) and non-zero with "no server running" otherwise.
 * stdio is silenced because callers only care about the exit status.
 */
export function isTmuxServerAlive(socketName: string): boolean {
  try {
    // [LAW:single-enforcer] tmux liveness probes pass socketName as an argv
    // element, never through a shell-interpreted command string.
    execFileSync("tmux", ["-L", socketName, "list-sessions"], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}
