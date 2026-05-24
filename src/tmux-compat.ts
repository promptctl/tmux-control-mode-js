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
 * `client.requestReport()` sends `refresh-client -r`, which tmux 3.4
 * rejects as an unknown flag. Available from tmux 3.5+.
 */
export const REQUEST_REPORT_MIN_VERSION: TmuxVersion = { major: 3, minor: 5 };

/**
 * `%config-error` notifications are only emitted by tmux 3.4+.
 */
export const CONFIG_ERROR_MIN_VERSION: TmuxVersion = { major: 3, minor: 4 };

/**
 * Parse the major/minor pair from a `tmux -V` output line.
 * Trailing suffix letters (e.g. `3.5a`) are ignored — match is on the
 * leading `<major>.<minor>` digits only.
 *
 * Returns `null` if the string contains no recognisable version.
 */
export function parseTmuxVersion(versionString: string): TmuxVersion | null {
  const m = versionString.match(/(\d+)\.(\d+)/);
  if (!m) return null;
  return { major: parseInt(m[1], 10), minor: parseInt(m[2], 10) };
}

/**
 * True if `have` is at least `need` (major-then-minor comparison).
 */
export function meetsTmuxVersion(have: TmuxVersion, need: TmuxVersion): boolean {
  if (have.major !== need.major) return have.major > need.major;
  return have.minor >= need.minor;
}
