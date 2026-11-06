import { execFileSync } from "node:child_process";

/**
 * Run `tmux args...` against the isolated server `socketName` and return its
 * trimmed stdout. `-f /dev/null` keeps the developer's tmux.conf from shaping
 * a server this call starts, so local runs match CI. Argv, not a shell string:
 * no shell ever re-splits or interprets an argument. tmux itself still parses
 * some: an element ending in `;` is a command separator, and format-taking
 * arguments (`-F`, `-c`, display formats) still expand `#{...}`. stderr is
 * piped so a failure's error carries tmux's reason.
 * [LAW:single-enforcer] The one place a vitest suite builds a tmux invocation
 * against a server (the Playwright specs in tests/e2e keep their own). Kept free of src/ imports so the reaper's globalSetup can share it.
 */
export function tmux(socketName: string, args: readonly string[]): string {
  return execFileSync("tmux", ["-f", "/dev/null", "-L", socketName, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
