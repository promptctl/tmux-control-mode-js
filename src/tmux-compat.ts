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
