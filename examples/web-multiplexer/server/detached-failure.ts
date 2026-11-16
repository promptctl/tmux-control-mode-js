// examples/web-multiplexer/server/detached-failure.ts
// The single enforcer for "a fire-and-forget tmux command failed".
//
// The server starts some commands with nobody awaiting them: a collaborator's
// keystrokes, a mirror viewer's join, the liveness and firehose polls. Node ends
// the process on an unhandled rejection, so each of those owners catches its
// own failure and reports it HERE, and the `void` at its call site is honest.
//
// [LAW:single-enforcer] One rule for every detached command: the connection
//   ending because its owner closed it is expected and quiet; anything else —
//   tmux going away under a live owner, a command tmux refused — is warned.
// [LAW:no-silent-failure] Only the owner's own close is silent, and it is
//   recognised by the library's connection-gone predicate, not by assumption.

import { isConnectionGone } from "@promptctl/tmux-control-mode-js";

/**
 * Report the failure of a command nobody awaits. `what` names the work for the
 * log line; `ownerClosed` is whether the owner has already closed its client.
 */
export function warnUnlessOwnClose(
  what: string,
  err: unknown,
  ownerClosed: boolean,
): void {
  if (ownerClosed && isConnectionGone(err)) return;
  const detail = err instanceof Error ? err.message : String(err);
  console.warn(`${what} failed: ${detail}`);
}
