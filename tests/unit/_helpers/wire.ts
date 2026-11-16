// tests/unit/_helpers/wire.ts
// What tmux writes back for a line TmuxClient.execute() sent: one guard block
// per command tmux ran for it, then its sentinel line's block, which ends the
// line (SPEC.md §5.6).
//
// [LAW:one-source-of-truth] The sentinel's reply text is the encoder's; a
// fake transport that answers execute() replays these, or it is asserting
// against a wire trace no real tmux produces. Guard numbers are opaque to the
// client, so a line's blocks share the caller's number.

import { LINE_SENTINEL_REPLY } from "../../../src/protocol/encoder.js";

/** One guard block, flags=1: it answers a line this client wrote. */
export function block(
  commandNumber: number,
  terminator: "end" | "error",
  output: readonly string[] = [],
): string {
  const guard = `${commandNumber} ${commandNumber} 1`;
  return [`%begin ${guard}`, ...output, `%${terminator} ${guard}`, ""].join(
    "\n",
  );
}

/** The block that ends a line: the sentinel's parse error. */
export function sentinelBlock(commandNumber: number): string {
  return block(commandNumber, "error", [LINE_SENTINEL_REPLY]);
}

/** A one-command line that succeeded with `output`. */
export function lineReply(
  commandNumber: number,
  output: readonly string[] = [],
): string {
  return block(commandNumber, "end", output) + sentinelBlock(commandNumber);
}

/** A one-command line that failed with `output`. */
export function lineError(
  commandNumber: number,
  output: readonly string[] = [],
): string {
  return block(commandNumber, "error", output) + sentinelBlock(commandNumber);
}
