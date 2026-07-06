// src/transport/line-termination.ts
//
// [LAW:single-enforcer] The one definition of "how a command becomes a wire
// line" for every TmuxTransport implementation that speaks LF-delimited text
// (spawn, websocket) — previously duplicated identically in both, so the
// terminator could drift between them if it ever changed.

/** Append a trailing LF if `command` doesn't already end with one. */
export function terminateLine(command: string): string {
  return command.endsWith("\n") ? command : command + "\n";
}
