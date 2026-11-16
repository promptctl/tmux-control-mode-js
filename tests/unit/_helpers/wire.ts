// tests/unit/_helpers/wire.ts
// What tmux writes back for a command line TmuxClient.execute() sent: one
// guard block per command tmux ran for it, then the block of the line's
// sentinel, which ends the line and names its number (SPEC.md §5.6).
//
// [LAW:one-source-of-truth] The sentinel's shape is the encoder's; a fake
// transport answers with these, or it asserts against a wire trace no real
// tmux produces. Guard numbers are opaque to the client.

import { SENTINEL_PREFIX } from "../../../src/protocol/encoder.js";
import { serializeMessage } from "../../../src/protocol/serializer.js";
import { CONTROL_FLAGS } from "../../../src/protocol/types.js";

/** One guard block, flags=1: it answers a line this client wrote. Its
 * timestamp is its number, so a test can tell which block numbered a reply. */
export function block(
  commandNumber: number,
  terminator: "end" | "error",
  output: readonly string[] = [],
): string {
  const guard = {
    timestamp: commandNumber,
    commandNumber,
    flags: CONTROL_FLAGS,
  };
  return [
    serializeMessage({ type: "begin", ...guard }),
    ...output,
    serializeMessage({ type: terminator, ...guard }),
    "",
  ].join("\n");
}

/** The number execute() gave the line it wrote as `sent`. */
export function lineNumberOf(sent: string): number {
  const sentinel = sent.split("\n").at(-2) ?? "";
  if (!sentinel.startsWith(SENTINEL_PREFIX)) {
    throw new Error(`not a line execute() wrote: ${JSON.stringify(sent)}`);
  }
  return Number(sentinel.slice(SENTINEL_PREFIX.length));
}

/** The block that ends command line `lineNumber`: its sentinel's parse error. */
export function sentinelBlock(
  commandNumber: number,
  lineNumber: number,
): string {
  return block(commandNumber, "error", [
    `parse error: unknown command: ${SENTINEL_PREFIX}${lineNumber}`,
  ]);
}

/** tmux's reply to `sent`, a one-command line that ended with `terminator`:
 * block `commandNumber`, then its sentinel's, numbered next as tmux does. */
export function replyTo(
  sent: string,
  output: readonly string[] = [],
  terminator: "end" | "error" = "end",
  commandNumber = 1,
): string {
  return (
    block(commandNumber, terminator, output) +
    sentinelBlock(commandNumber + 1, lineNumberOf(sent))
  );
}
