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
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

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

/** A run's namespace is named for its vitest process id; nothing else under RUNS_ROOT is a run. */
const RUN_NAME = /^\d+$/;

/** How long one `kill-server` may take before the environment counts as broken. */
const KILL_TIMEOUT_MS = 5000;

/** The namespace of the run whose vitest process is `pid`. */
export function runDir(pid: number): string {
  return join(RUNS_ROOT, String(pid));
}

/** Where tmux puts the sockets of a server started with TMUX_TMPDIR=`dir`. */
export function socketDirIn(dir: string): string {
  return join(dir, `tmux-${uid()}`);
}

/** Entries of directory `path`; none once it is gone, as a concurrent run's reap may make it. */
function entries(path: string): string[] {
  try {
    return readdirSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

/**
 * Kill the tmux server `socket` names under `env`'s TMUX_TMPDIR. True when one
 * was running: tmux leaves a killed server's socket file behind, so most
 * sockets in a namespace are dead files, and only a kill tells them apart.
 */
export function killTmuxServer(
  socket: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  try {
    execFileSync("tmux", ["-L", socket, "kill-server"], {
      stdio: "ignore",
      env,
      timeout: KILL_TIMEOUT_MS,
    });
    return true;
  } catch (err) {
    // [LAW:no-silent-failure] Only tmux exiting non-zero means "no server".
    // A missing tmux, a timeout or a signal is a broken environment: read as
    // "dead", it would have the reaper delete a live server's socket.
    if (typeof (err as { status?: unknown }).status === "number") return false;
    throw err;
  }
}

function killServerIn(dir: string, socket: string): boolean {
  return killTmuxServer(socket, { ...process.env, TMUX_TMPDIR: dir });
}

/** Whether process `pid` is running. A reused pid reads as alive: a leak, never a kill. */
export function processAlive(pid: number): boolean {
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
  const running = entries(socketDirIn(dir)).filter((name) =>
    killServer(dir, name),
  );
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
  return entries(root)
    .filter((name) => RUN_NAME.test(name) && !isAlive(Number(name)))
    .flatMap((name) => reapRun(join(root, name), killServer));
}
