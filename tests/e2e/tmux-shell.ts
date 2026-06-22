// tests/e2e/tmux-shell.ts
// The deterministic shell e2e tmux panes run, and how the suite pins it.
//
// [LAW:no-ambient-temporal-coupling] e2e correctness must not depend on the
// developer's shell. A heavy interactive login shell (e.g. zsh + oh-my-zsh)
// floods a fresh pane with startup output, is slow to reach a prompt, and
// clears the screen mid-startup — so a sentinel typed right after the xterm
// grid mounts gets eaten and the round-trip assertion times out. Worse, the
// pane shell is chosen by the user's `~/.tmux.conf` `default-command`, which
// outranks both `default-shell` and `$SHELL`, so an environment override
// cannot reach it.
//
// The fix operates at the top of tmux's shell-resolution ladder AND discards
// the user config: the SUITE seeds the session itself with an explicit pane
// command under `-f /dev/null`. tmux's shell precedence is
//   explicit pane command > default-command > default-shell > $SHELL,
// so an explicit `/bin/sh` wins outright; `-f /dev/null` drops the user's
// hooks/status/default-command from the server entirely.
//
// [LAW:no-ambient-temporal-coupling] The demo app's `ensureSession` runs
// `has-session` before creating one, so a session the suite seeded FIRST is
// attached to rather than recreated under the login shell. The suite is thus
// the single owner of the pane's shell + lifecycle.

/** Minimal, quiet shell present on macOS + Linux CI. */
export const E2E_SHELL = "/bin/sh";

/**
 * tmux args (after `-L <socket>`) that seed a detached session whose single
 * pane runs {@link E2E_SHELL}, with the developer's `~/.tmux.conf` discarded.
 *
 * Use BEFORE launching the demo app so its `ensureSession` attaches to this
 * session instead of spawning the user's login shell.
 */
export function cleanSessionArgs(session: string): readonly string[] {
  return ["-f", "/dev/null", "new-session", "-d", "-s", session, E2E_SHELL];
}
