import { execSync } from "node:child_process";
import { type TmuxVersion, parseTmuxVersion } from "../../src/tmux-compat.js";

// [LAW:no-silent-failure] An unreadable `tmux -V` throws at module load
// rather than quietly skipping every version-gated integration test.
export function runningTmuxVersion(): TmuxVersion {
  const banner = execSync("tmux -V", { encoding: "utf8" }).trim();
  const version = parseTmuxVersion(banner);
  if (version === null) {
    throw new Error(`cannot read a version from \`tmux -V\`: ${banner}`);
  }
  return version;
}
