// examples/web-multiplexer/server/detached-failure.ts
// The single enforcer for "a fire-and-forget tmux command failed".
//
// The server starts some commands with nobody awaiting them: a collaborator's
// keystrokes, a mirror viewer's join, the liveness and firehose polls. Node ends
// the process on an unhandled rejection, so each of those owners catches its
// own failure and reports it HERE, and the `void` at its call site is honest.
//
// [LAW:single-enforcer] One rule for every detached command: a command lost
//   with its connection is not reported, because the connection's end is
//   reported once by whoever owns that connection (`DedicatedControlClient`,
//   or the host that closes its socket on `exit`). Anything else — a command
//   tmux refused, a fault in the owner's own bookkeeping — is warned.
// [LAW:no-silent-failure] "Lost with its connection" is recognised by the
//   library's connection-gone predicate, not by assumption.

import { isConnectionGone } from "@promptctl/tmux-control-mode-js";

/** Report the failure of a command nobody awaits; `what` names the work. */
export function reportDetachedFailure(what: string, err: unknown): void {
  if (isConnectionGone(err)) return;
  const detail = err instanceof Error ? err.message : String(err);
  console.warn(`${what} failed: ${detail}`);
}
