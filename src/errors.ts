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
    // a generic message when tmux returned no body. A response-block line
    // may carry a trailing \r run (TmuxParser.processLine() no longer strips
    // it there, for capture-pane byte fidelity — see CommandResponse.output's
    // doc), so strip the whole run before judging "empty" and before using
    // the line as the message, or a lone "\r\r" line would survive a
    // single-\r strip and silently become the headline instead of being
    // skipped as blank.
    const headline =
      response.output
        .map((line) => line.replace(/\r+$/, ""))
        .find((line) => line.length > 0) ?? "tmux command failed (%error)";
    super(headline);
    this.name = "TmuxCommandError";
    this.response = response;
  }
}

/**
 * Thrown via Promise rejection when a command could not be handed to the
 * transport at all — the transport refused the send (dead process, closed
 * socket, failed pipe). Distinct from {@link TmuxCommandError}: the command
 * never reached tmux, so there is no `CommandResponse` to carry.
 *
 * [LAW:types-are-the-program] "Never sent" is its own domain category with its
 * own shape (a transport reason, no command number), not a command failure
 * wearing fake response fields.
 */
export class TransportSendError extends Error {
  /** The transport's stated refusal reason, verbatim. */
  readonly reason: string;

  constructor(reason: string) {
    super(`command not sent: ${reason}`);
    this.name = "TransportSendError";
    this.reason = reason;
  }
}

/**
 * Thrown via Promise rejection when a command was accepted by the transport
 * (queued, or already inflight awaiting `%end`/`%error`) but the transport
 * closed before tmux ever replied. Distinct from {@link TransportSendError}
 * (the transport refused the command outright — it never left this process)
 * and {@link TmuxCommandError} (tmux replied, and the reply was `%error`):
 * here tmux never got the chance to decide the command's fate at all.
 *
 * [LAW:types-are-the-program] "Sent, but the connection died before an
 * answer arrived" is its own domain category — it carries the transport's
 * close reason, not a fabricated `CommandResponse`.
 */
export class TransportClosedError extends Error {
  /** The transport's close reason, verbatim (`undefined` for a clean exit). */
  readonly reason: string | undefined;

  constructor(reason: string | undefined) {
    super(
      reason === undefined
        ? "transport closed before command completed"
        : `transport closed before command completed: ${reason}`,
    );
    this.name = "TransportClosedError";
    this.reason = reason;
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

/**
 * Thrown via Promise rejection when the running tmux answers `#{version}`
 * with a value that is not a tmux version shape — a vendor tag such as
 * OpenBSD base's `openbsd-7.4`. The reply is well-formed (so this is not a
 * {@link TmuxReplyFormatError}); the library just cannot place it against a
 * version floor, so a gated feature is refused rather than guessed into.
 * `reported` is the raw reply.
 */
export class UnrecognizedTmuxVersionError extends Error {
  readonly reported: readonly string[];

  constructor(reported: readonly string[]) {
    super(
      `the running tmux reports an unrecognised version: ${JSON.stringify(reported)}`,
    );
    this.name = "UnrecognizedTmuxVersionError";
    this.reported = reported;
  }
}

/**
 * Thrown via Promise rejection when a dispatched tmux command's `%end`/
 * `%error` guard terminator was malformed on the wire (fewer than the three
 * required fields — SPEC.md §5) while its response block was open. Distinct
 * from {@link TmuxCommandError} (a well-formed `%error` reply): here tmux's
 * own response framing was unparseable, not merely negative, so whether the
 * command actually applied is unknown — only that the connection is corrupted
 * at exactly the moment this command's block should have closed.
 *
 * The parser still recovers (`TmuxParser`'s malformed-guard-terminator
 * tolerance): the block force-closes so subsequent traffic routes normally,
 * and this rejection is the caller's only signal that this command's true
 * outcome was never learned. `output` carries whatever lines the command
 * produced before the corrupted terminator — the same diagnostic value
 * {@link TmuxCommandError} preserves on a real `%error`, just without a
 * `timestamp`/`success` to pair it with (there is no well-formed
 * `CommandResponse` here; the terminator that would have carried it is
 * exactly what was corrupted).
 *
 * [LAW:types-are-the-program] "The terminator itself was corrupted" is its
 * own domain category, not a command failure wearing a fake `%error` shape —
 * it carries the raw malformed line and partial output, not a fabricated
 * `CommandResponse`.
 */
export class TmuxProtocolError extends Error {
  readonly commandNumber: number;
  readonly line: string;
  readonly output: readonly string[];

  constructor(
    commandNumber: number,
    line: string,
    output: readonly string[] = [],
  ) {
    super(
      `malformed guard terminator for command ${commandNumber}: ${JSON.stringify(line)}`,
    );
    this.name = "TmuxProtocolError";
    this.commandNumber = commandNumber;
    this.line = line;
    this.output = output;
  }
}

/**
 * `execute()` refused a command whose line would not get exactly one reply,
 * so correlating it would shift every later pending command onto the wrong
 * reply. A newline splits it into several commands; an empty line detaches
 * the control client (SPEC §4.1); a blank or comment-only line gets no reply
 * at all. Nothing was sent.
 */
export class TmuxInvalidCommandError extends Error {
  readonly command: string;

  constructor(command: string) {
    super(`command must be one non-empty line: ${JSON.stringify(command)}`);
    this.name = "TmuxInvalidCommandError";
    this.command = command;
  }
}

// [LAW:single-enforcer] The one predicate every TmuxConnection.execute
// (TmuxClient, the WebSocket client, the Electron renderer) applies before
// sending, so a caller sees the same typed error locally and over a bridge.
export function invalidCommand(
  command: string,
): TmuxInvalidCommandError | null {
  const trimmed = command.trim();
  return trimmed === "" || trimmed.startsWith("#") || command.includes("\n")
    ? new TmuxInvalidCommandError(command)
    : null;
}

/**
 * A command succeeded but its reply does not have the shape of the `-F`
 * format the library sent with it (e.g. `newWindow`'s `@N\t%N`). The block
 * closed normally, so this is not a {@link TmuxProtocolError}; it means the
 * library's reply format and the running tmux disagree. Whatever the command
 * does (`newWindow` creates a window) did happen. `output` is the raw reply.
 */
export class TmuxReplyFormatError extends Error {
  readonly command: string;
  readonly output: readonly string[];

  constructor(command: string, output: readonly string[]) {
    super(
      `unexpected reply to ${JSON.stringify(command)}: ${JSON.stringify(output)}`,
    );
    this.name = "TmuxReplyFormatError";
    this.command = command;
    this.output = output;
  }
}

/**
 * Classify a command rejection as "the connection is already gone" — the
 * transport refused the send ({@link TransportSendError}) or closed before
 * tmux replied ({@link TransportClosedError}). Both mean the command never got
 * a verdict from a live tmux, so the operation it drove is *moot*: the pane /
 * subscription it targeted is being torn down and, on reconnect, re-driven.
 *
 * Any other rejection class ({@link TmuxCommandError}, {@link TmuxProtocolError},
 * anything else) means tmux was ALIVE and the effect's real outcome matters —
 * that is the meaning-altering failure a seam must surface, not swallow.
 *
 * [LAW:single-enforcer] The connection-gone predicate lives once, here, beside
 *   the taxonomy it classifies. Both the bridge resume-strand seam and the
 *   pane-terminal subscribe/seed seam split quiet-vs-surface through this one
 *   check, so the two sites cannot drift on what "gone" means.
 */
export const isConnectionGone = (err: unknown): boolean =>
  err instanceof TransportClosedError || err instanceof TransportSendError;
