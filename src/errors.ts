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
import type { TmuxVersion } from "./tmux-compat.js";

/**
 * Thrown via Promise rejection when a dispatched tmux command receives an
 * `%error` reply instead of `%end`. Every command flows through
 * `TmuxClient.execute` (the sole dispatch path), including the command
 * helpers in `./commands/index.ts` that compose on top of it; any of them
 * can reject with this error.
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

/**
 * Thrown via Promise rejection when a command is invoked against a running
 * tmux older than the command's minimum version. This is a *precondition*
 * failure surfaced by the library before the command reaches tmux — distinct
 * from {@link TmuxCommandError}, which wraps tmux's own `%error` reply.
 *
 * The library supports tmux 3.2+, but individual commands have higher floors
 * (e.g. `requestReport` needs the `refresh-client -r` flag, added in tmux 3.5).
 * Without this guard the caller would receive tmux's raw "unknown flag"
 * `%error` instead of a message naming the actual requirement.
 *
 * [LAW:types-are-the-program] A version precondition failure is its own
 * domain category, not a tmux runtime error — it carries the required and
 * actual versions as data, so `instanceof UnsupportedTmuxVersionError` is the
 * authoritative check and consumers can branch on the gap.
 *
 * Usage:
 *
 *     try {
 *       await requestReport(client, paneId, "\x1b]10;?\x07");
 *     } catch (err) {
 *       if (err instanceof UnsupportedTmuxVersionError) {
 *         console.error(`needs tmux ${err.required.major}.${err.required.minor}`);
 *       } else {
 *         throw err;
 *       }
 *     }
 */
export class UnsupportedTmuxVersionError extends Error {
  readonly feature: string;
  readonly required: TmuxVersion;
  readonly actual: TmuxVersion;

  constructor(feature: string, required: TmuxVersion, actual: TmuxVersion) {
    super(
      `${feature} requires tmux ${required.major}.${required.minor}+, ` +
        `but the running tmux is ${actual.major}.${actual.minor}`,
    );
    this.name = "UnsupportedTmuxVersionError";
    this.feature = feature;
    this.required = required;
    this.actual = actual;
  }
}
