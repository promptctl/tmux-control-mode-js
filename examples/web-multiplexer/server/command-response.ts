// examples/web-multiplexer/server/command-response.ts
// The single enforcer for "a tmux command rejection, as a CommandResponse".
//
// The library rejects a failed command with `TmuxCommandError` — an `Error`
// whose `.response` is the real `CommandResponse` carrying tmux's `%error`
// output. Every server-side caller that ran a command and now wants to inspect
// `success` / `output` must funnel its `.catch` through HERE, never re-derive
// the unwrap inline. An inline `.catch((r: CommandResponse) => r)` is a
// type-lie: the caught value is a `TmuxCommandError`, so `r.success` is
// `undefined` (it only *accidentally* reads as failure) and a non-command
// rejection — a transport drop, a version precondition — gets laundered into a
// phantom "command failed" instead of surfacing.
//
// [LAW:single-enforcer] One translation from rejection → `CommandResponse`,
//   shared by the bridge's request handler, the mirror registry, and the
//   collab input. None of them can drift from the others.
// [LAW:no-silent-failure] A non-command rejection is rethrown, not swallowed:
//   the caller's surrounding `try`/`catch` (or its unhandled-rejection path)
//   surfaces it loudly rather than masking it as a failed tmux command.

import { TmuxCommandError } from "@promptctl/tmux-control-mode-js";
import type { CommandResponse } from "@promptctl/tmux-control-mode-js/protocol";

/**
 * Unwrap a command rejection into its `CommandResponse`. Pass this directly to
 * `.catch` on a command promise:
 *
 *     const response = await client.execute(cmd).catch(asCommandResponse);
 *     if (!response.success) { ... }  // tmux's %error output is in response.output
 *
 * A `TmuxCommandError` yields its carried `.response`; any other rejection
 * (transport, version precondition) is rethrown to the caller's error path.
 */
export function asCommandResponse(err: unknown): CommandResponse {
  if (err instanceof TmuxCommandError) return err.response;
  throw err;
}
