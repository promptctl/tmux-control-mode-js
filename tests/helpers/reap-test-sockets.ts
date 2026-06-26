// Reaper for leaked ephemeral tmux test sockets.
//
// Every integration test isolates itself on its own `tmux -L <socket>` server
// and tears it down in afterEach. When a run is *killed* (timeout, machine
// load, ^C) that afterEach never fires: tmux daemonizes via double-fork, so the
// server outlives the runner. The result is two leak shapes under the socket
// dir — live orphan daemons (whose socket still has a listener) and dead socket
// files (SIGKILLed servers that never unlinked). Both accumulate run over run;
// the ticket observed 1298 leaked sockets driving load high enough to fail an
// otherwise-green suite — silent resource accumulation that corrupts the
// verification signal. [LAW:no-silent-failure]
//
// This module reaps both shapes for *test-prefixed* sockets only. It is wired as
// vitest globalSetup (reap before AND after every run); the seams below let the
// behavioral test drive it against a temp dir with no real tmux.

import { execSync } from "node:child_process";
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

// [LAW:one-source-of-truth] The canonical registry of socket-name prefixes the
// suite mints. Every `tmux -L <name>` a test allocates begins with one of these.
// The reaper AND the coverage guard test both read THIS list, so adding a test
// that mints a new prefix without registering it here is a loud test failure,
// not a silent leak. Derived from source, never hand-copied from a ticket.
//
// [LAW:single-enforcer] These are deliberately specific (each carries its
// distinguishing segment and trailing `-`) so the reaper can never match the
// developer's real `default` socket or unrelated demo sockets (`mreg`,
// `collab`, `cmtest-…`, `imgtest-…`), none of which start with these strings.
export const TEST_SOCKET_PREFIXES = [
  "tmux-js-test-",
  "tmux-js-conf-",
  "tmux-js-pstream-",
  "tmux-scope-test-",
  "tmux-line-test-",
  "tmux-idle-test-",
  "tmux-bridge-test-",
  "tmux-bytes-sink-test-",
  "tmux-js-demo-bench-",
] as const;

// Pure predicate — the one place "is this ours to reap?" is decided.
// [LAW:effects-at-boundaries] kept separate from the IO below so the matching
// rule is testable in isolation and the safety guarantee is one readable line.
export function isTestSocket(name: string): boolean {
  return TEST_SOCKET_PREFIXES.some((prefix) => name.startsWith(prefix));
}

// tmux resolves its socket directory as `<TMUX_TMPDIR | /tmp>/tmux-<uid>`.
// Returns null where tmux sockets don't apply (no POSIX uid, e.g. Windows),
// so callers treat "nothing to reap" and "no socket namespace" identically.
export function socketDir(): string | null {
  const uid = process.getuid?.();
  if (uid === undefined) return null;
  const base = process.env.TMUX_TMPDIR ?? "/tmp";
  return join(base, `tmux-${uid}`);
}

export interface ReapOptions {
  // Socket directory to sweep. Defaults to the resolved tmux socket dir; the
  // behavioral test injects a temp dir so it needs no real tmux.
  dir?: string | null;
  // Best-effort termination of a live daemon before its socket is unlinked.
  // Defaults to `tmux -L <socket> kill-server`; the test injects a no-op.
  killServer?: (socket: string) => void;
}

function killTmuxServer(socket: string): void {
  try {
    execSync(`tmux -L ${socket} kill-server`, { stdio: "ignore" });
  } catch {
    // A stale socket file has no live server to kill — kill-server failing here
    // is the expected "already dead" case, not a swallowed error: the unlink
    // below is the actual reap and it is allowed to fail loudly.
  }
}

// Reap every test-prefixed socket in `dir`: kill its daemon if one is live,
// then unlink the socket file. Returns the names reaped so callers can report a
// loud, verifiable summary. [LAW:no-silent-failure]
export function reapTestSockets(opts: ReapOptions = {}): string[] {
  // [LAW:no-defensive-null-guards] `undefined` means "caller didn't provide an
  // override — use the resolved socket dir"; `null` means "caller explicitly
  // disabled reaping (e.g. no POSIX uid environment)". `??` conflates them, so
  // use an explicit undefined check.
  const dir = opts.dir !== undefined ? opts.dir : socketDir();
  if (dir === null) return [];
  const kill = opts.killServer ?? killTmuxServer;

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    // Dir absent → nothing was ever leaked. Any other failure (permissions)
    // is real and must surface rather than masquerade as "clean". [LAW:no-silent-failure]
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const reaped: string[] = [];
  for (const name of entries) {
    if (!isTestSocket(name)) continue;
    kill(name);
    rmSync(join(dir, name), { force: true });
    reaped.push(name);
  }
  return reaped;
}
