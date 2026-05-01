// src/errors.ts
// Typed errors thrown by TmuxClient.
//
// The library used to reject command Promises with a raw `CommandResponse`
// object — callers had to either check `success: false` on the resolve path
// or duck-type the rejection. Bridges (websocket, electron) ended up writing
// the same `"success" in err && err.success === false` check; library
// consumers had no `instanceof` to use.
//
// TmuxCommandError is the typed receipt: it extends Error (so it survives
// every Promise pipeline that expects an Error), and it carries the original
// `CommandResponse` on `.response` so consumers can still inspect tmux's
// output lines.
//
// [LAW:single-enforcer] One class for command failures; downstream
// `instanceof TmuxCommandError` is the authoritative check.

import type { CommandResponse } from "./protocol/types.js";

/**
 * Thrown via Promise rejection from any TmuxClient method that maps to a
 * tmux command (i.e. anything backed by sendRaw — `execute`, `sendKeys`,
 * `setSize`, `setPaneAction`, `subscribe`, `unsubscribe`, `setFlags`,
 * `clearFlags`, `requestReport`, `queryClipboard`) when tmux replies with
 * `%error`.
 *
 * The original `CommandResponse` (containing the captured error output) is
 * available on `.response`.
 *
 * Usage:
 *
 *     try {
 *       await client.execute("nonsense-command");
 *     } catch (err) {
 *       if (err instanceof TmuxCommandError) {
 *         console.error("tmux rejected:", err.response.output);
 *       } else {
 *         throw err;
 *       }
 *     }
 */
export class TmuxCommandError extends Error {
  readonly response: CommandResponse;

  constructor(response: CommandResponse) {
    // First non-empty output line is usually tmux's diagnostic; fall back to
    // a generic message when tmux returned no body.
    const headline =
      response.output.find((line) => line.length > 0) ??
      "tmux command failed (%error)";
    super(headline);
    this.name = "TmuxCommandError";
    this.response = response;
  }
}
