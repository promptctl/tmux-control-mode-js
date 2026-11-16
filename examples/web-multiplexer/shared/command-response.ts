// examples/web-multiplexer/shared/command-response.ts
// The single enforcer for "a tmux command rejection, as a CommandResponse".
//
// A failed tmux command rejects with `TmuxCommandError` — an `Error` whose
// `.response` is the real `CommandResponse` carrying tmux's `%error` output —
// from the library's connections and from the page's `TmuxBridge` alike. Every
// caller that wants the reply as a value, to inspect `success` / `output`,
// funnels its `.catch` through HERE, never re-deriving the unwrap inline. An
// inline `.catch((r: CommandResponse) => r)` is a type-lie: the caught value is
// a `TmuxCommandError`, so `r.success` is `undefined` (it only *accidentally*
// reads as failure) and a non-command rejection — a transport drop, a version
// precondition — gets laundered into a phantom "command failed" instead of
// surfacing.
//
// [LAW:single-enforcer] One translation from rejection → `CommandResponse`,
//   shared by the server and the page. None of them can drift from the others.
// [LAW:no-silent-failure] A non-command rejection is rethrown, not swallowed:
//   the caller's surrounding `try`/`catch` (or its unhandled-rejection path)
//   surfaces it loudly rather than masking it as a failed tmux command.
// [LAW:one-way-deps] Imported from the `/browser` subpath, which the page can
//   bundle; it is the same `TmuxCommandError` class the root entry exports.

import { TmuxCommandError } from "@promptctl/tmux-control-mode-js/browser";
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
