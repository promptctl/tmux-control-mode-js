/**
 * Canonical tmux version requirements.
 *
 * [LAW:one-source-of-truth] Every other doc/test that asserts a tmux
 * version requirement either imports a constant from here or links to
 * the README Compatibility section (which mirrors these constants in
 * prose). Adding a new feature gate? Add the constant here first; the
 * test and README follow.
 */

export interface TmuxVersion {
  readonly major: number;
  readonly minor: number;
}

/**
 * Library-wide minimum. The 3.2 floor is load-bearing — format
 * subscriptions, pane flow control, and `%client-detached` all arrived
 * in 3.2. See README.md Compatibility for the full rationale.
 */
export const MIN_TMUX_VERSION: TmuxVersion = { major: 3, minor: 2 };

/**
 * `queryClipboard()` sends `refresh-client -l`. On tmux 3.2 that writes an
 * OSC 52 query to the control client's tty and the control client exits,
 * taking the connection down. Works from tmux 3.3+ (measured on 3.2a / 3.3a).
 */
export const QUERY_CLIPBOARD_MIN_VERSION: TmuxVersion = { major: 3, minor: 3 };

/**
 * `%paste-buffer-changed` / `%paste-buffer-deleted` notifications; tmux 3.2
 * and 3.3 never emit them. Emitted from tmux 3.4+.
 */
export const PASTE_BUFFER_NOTIFY_MIN_VERSION: TmuxVersion = {
  major: 3,
  minor: 4,
};

/**
 * `%message` notification (display-message targeting a control client);
 * tmux 3.2 and 3.3 never emit it. Emitted from tmux 3.4+.
 */
export const MESSAGE_NOTIFY_MIN_VERSION: TmuxVersion = { major: 3, minor: 4 };

/**
 * `client.requestReport()` sends `refresh-client -r`, which tmux 3.4
 * rejects as an unknown flag. Available from tmux 3.5+.
 */
export const REQUEST_REPORT_MIN_VERSION: TmuxVersion = { major: 3, minor: 5 };

/**
 * `watchServerArgs`' `no-detach-on-destroy` client flag; older tmux silently
 * ignores it. Available from tmux 3.6+.
 */
export const NO_DETACH_ON_DESTROY_MIN_VERSION: TmuxVersion = {
  major: 3,
  minor: 6,
};

/**
 * `paneCwd()` reads `#{pane_current_path}` once. Before tmux 3.7 the server
 * forks first and the child chdirs after, so a read right after `newWindow()`
 * can report the server's own cwd. From 3.7 (tmux commit f58b8d0, GitHub issue
 * 4719) the server chdirs before fork, so the child starts in its final cwd.
 */
export const PANE_CWD_MIN_VERSION: TmuxVersion = { major: 3, minor: 7 };

/**
 * `newEmptyWindow()` sends `new-window -E`, which tmux 3.7 rejects as an
 * unknown flag. Available from tmux 3.8+.
 */
export const EMPTY_WINDOW_MIN_VERSION: TmuxVersion = { major: 3, minor: 8 };

/**
 * `respawnPane()` sends `respawn-pane`. Before tmux 3.8 a respawn gives the
 * pane a new, empty output buffer but keeps each client's read offset into the
 * old one. With a control client attached, which this library's connection is,
 * the next read can then run past the new buffer and the tmux server crashes,
 * ending every session on it (reproduced on 3.7b, seen on 3.4). tmux 3.8
 * resets the offsets when a pane is respawned (its CHANGES, issue 5498).
 */
export const RESPAWN_PANE_MIN_VERSION: TmuxVersion = { major: 3, minor: 8 };

/**
 * Where a pane starts when its `new-window -c` directory does not exist and
 * $HOME does (with $HOME missing too, every version falls through to `/`). $HOME
 * on 3.2 and 3.4+; tmux 3.3's spawn.c tests
 * `(tmp = find_home()) != NULL || chdir(tmp) == 0`, so the chdir never runs
 * and the pane keeps the server's own cwd while its $PWD still says $HOME
 * (measured on 3.3a; 3.4 restores `&&`). An exact version, not a floor, which
 * is why this is a predicate and not a *_MIN_VERSION constant.
 */
export function missingCwdFallback(v: TmuxVersion): "home" | "server-cwd" {
  return v.major === 3 && v.minor === 3 ? "server-cwd" : "home";
}

/**
 * The version shapes portable tmux's configure.ac produces (`3.2a`,
 * `next-3.6`, `3.4-rc`) — the bare `#{version}` value. Anchored on both ends
 * so a vendor tag like OpenBSD base's `openbsd-7.4` is rejected instead of
 * read as tmux 7.4, which would pass every version gate.
 */
const TMUX_VERSION_VALUE = /^(?:next-)?(\d+)\.(\d+)[a-z]?(?:-rc\d*)?$/;

/**
 * `tmux -V` prints `<progname> <version>`; progname is argv[0]'s basename,
 * so any word is legitimate there.
 */
const TMUX_V_BANNER = /^\S+ (\S+)$/;

/**
 * Parse a bare `#{version}` value. Returns `null` for anything that is not a
 * tmux version shape — callers must treat that as an unknown version, never
 * guess one.
 */
// [LAW:no-silent-failure] An unplaceable version is null, never a loose read
// or a floor: loosening the shape lets vendor tags pass every version gate.
export function parseTmuxVersionValue(value: string): TmuxVersion | null {
  const m = TMUX_VERSION_VALUE.exec(value.trim());
  if (!m) return null;
  return { major: parseInt(m[1], 10), minor: parseInt(m[2], 10) };
}

/**
 * Parse the major/minor pair from a `tmux -V` line or a bare `#{version}`
 * value; `null` when neither shape matches (see {@link parseTmuxVersionValue}).
 */
export function parseTmuxVersion(versionString: string): TmuxVersion | null {
  const trimmed = versionString.trim();
  const banner = TMUX_V_BANNER.exec(trimmed);
  return parseTmuxVersionValue(banner ? banner[1] : trimmed);
}

/**
 * True if `have` is at least `need` (major-then-minor comparison).
 */
export function meetsTmuxVersion(
  have: TmuxVersion,
  need: TmuxVersion,
): boolean {
  if (have.major !== need.major) return have.major > need.major;
  return have.minor >= need.minor;
}
