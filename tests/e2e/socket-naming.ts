// tests/e2e/socket-naming.ts
// One-source-of-truth for the e2e suite's tmux socket naming.
//
// Sockets land in /tmp/tmux-$UID/ (where named tmux sockets live by
// default — `tmux -L NAME` puts them there). The prefix below is what
// the orphan-prune pass uses as its allow-list discriminator: any
// socket whose name does NOT start with this prefix is left alone.
//
// Filename schema after the prefix: `<pid>-<base36-time>`. The PID
// portion lets the prune pass check `process.kill(pid, 0)` to skip
// sockets owned by a still-running sibling test.

// [LAW:single-enforcer] Both the spec (when picking a name) and the
// prune pass (when matching names to act on) import this constant.
// Diverging the two would either create unmatched test sockets that
// never get cleaned up, or worse, an over-broad regex that touches
// other tools' sockets.
export const E2E_SOCKET_PREFIX = "web-multiplexer-e2e-";

// Regex anchored to E2E_SOCKET_PREFIX, capturing the embedded PID.
// Anything outside this allow-list shape is invisible to cleanup.
export const E2E_SOCKET_PATTERN = new RegExp(
  `^${E2E_SOCKET_PREFIX.replace(/-/g, "\\-")}(\\d+)-[0-9a-z]+$`,
);

/** Extract the embedded PID from an e2e socket filename, or null if it
 *  does not match our schema (so the cleanup never acts on a foreign
 *  file even if the prefix happened to align). */
export function ownerPidOf(filename: string): number | null {
  const m = E2E_SOCKET_PATTERN.exec(filename);
  if (m === null) return null;
  const pid = Number.parseInt(m[1], 10);
  if (!Number.isFinite(pid) || pid <= 0) return null;
  return pid;
}
