// tests/e2e/socket-naming.ts
// E2e-specific socket naming. The general primitives (tmuxSocketDir,
// isTmuxServerAlive, listTmuxSocketNames) live in the library
// (`@promptctl/tmux-control-mode-js`); this file only owns the prefix
// + name builder for THIS test suite's sockets.

// [LAW:single-enforcer] All e2e socket names start with this prefix so
// they're greppable when something does leak. The cleanup pass does NOT
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
