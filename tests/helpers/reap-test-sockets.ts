// Per-run tmux namespaces for the vitest suites, and the reaper that clears them.
//
// tmux puts every `tmux -L <name>` socket in `$TMUX_TMPDIR/tmux-<uid>/`. Each
// vitest run points TMUX_TMPDIR at a directory of its own under RUNS_ROOT,
// named for the run's process id, so every server the run starts — whatever
// its socket is called — lives where only that run looks. Teardown reaps the
// run's own directory; setup reaps the directory of every run whose process is
// gone (killed before its teardown — tmux daemonizes, so its servers outlive
// it). A live run's directory is never touched, so concurrent runs, such as
// another worktree's suite, cannot kill each other's servers mid-test.
//
// [LAW:one-source-of-truth] Ownership is where a socket lives, not what it is
// named: no prefix registry can tell a dead run's server from a live
// neighbour's, and the old one killed them alike.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmux } from "./tmux-cli.js";

function uid(): number {
  if (process.getuid === undefined) {
    throw new Error("tmux test runs need a POSIX uid; tmux is POSIX-only");
  }
  return process.getuid();
}

/**
 * Parent of every run's namespace. Under `/tmp`, not `os.tmpdir()`: macOS caps
 * a socket path at 104 bytes and tmux resolves TMUX_TMPDIR to its real path,
 * so a run's sockets must sit shallow.
 */
export const RUNS_ROOT = `/tmp/tmux-js-test-runs-${uid()}`;

/** The namespace of the run whose vitest process is `pid`. */
export function runDir(pid: number): string {
  return join(RUNS_ROOT, String(pid));
}

/** Kill the tmux server `socket` names in the current TMUX_TMPDIR. */
export function killTmuxServer(socket: string): void {
  try {
    tmux(socket, ["kill-server"]);
  } catch {
    // A stale socket file has no live server to kill — that failing here is
    // the expected "already dead" case, not a swallowed error.
  }
}

/**
 * Kill the tmux server named `socket` in the run namespace `dir`. True when
 * one was running: tmux leaves a killed server's socket file behind, so most
 * sockets in a namespace are dead files, and only a kill tells them apart.
 */
function killServerIn(dir: string, socket: string): boolean {
  try {
    execFileSync("tmux", ["-L", socket, "kill-server"], {
      stdio: "ignore",
      env: { ...process.env, TMUX_TMPDIR: dir },
    });
    return true;
  } catch {
    // No server listening: a dead file, which the directory's removal reaps.
    return false;
  }
}

/** Whether process `pid` is running. A reused pid reads as alive: a leak, never a kill. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw err;
  }
}

/**
 * Kill every server in run directory `dir`, then remove it. Returns the
 * sockets whose server was still running — the servers its run left behind.
 */
export function reapRun(
  dir: string,
  killServer: (dir: string, socket: string) => boolean = killServerIn,
): string[] {
  const socketDir = join(dir, `tmux-${uid()}`);
  const sockets = existsSync(socketDir) ? readdirSync(socketDir) : [];
  const running = sockets.filter((name) => killServer(dir, name));
  rmSync(dir, { recursive: true, force: true });
  return running;
}

/**
 * Reap the namespace of every run under `root` whose process is gone. Returns
 * the sockets whose server those runs left running.
 */
export function reapDeadRuns(
  root: string = RUNS_ROOT,
  isAlive: (pid: number) => boolean = processAlive,
  killServer: (dir: string, socket: string) => boolean = killServerIn,
): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((name) => !isAlive(Number(name)))
    .flatMap((name) => reapRun(join(root, name), killServer));
}
