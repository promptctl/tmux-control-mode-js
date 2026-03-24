// src/protocol/encoder.ts
// Command string builders for tmux control mode.
// No runtime dependencies. Works in browser, Deno, Bun, Node.

import { PaneAction } from "./types.js";

// [LAW:single-enforcer] All user-argument escaping goes through this one function.
function tmuxEscape(arg: string): string {
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

// [LAW:dataflow-not-control-flow] Every function builds a string and appends LF.
// No conditional paths — variability is in the values, not whether we build.

function buildCommand(cmd: string): string {
  return cmd + "\n";
}

function refreshClientSize(width: number, height: number): string {
  return buildCommand(`refresh-client -C ${width}x${height}`);
}

function refreshClientPaneAction(paneId: number, action: PaneAction): string {
  return buildCommand(`refresh-client -A %${paneId}:${action}`);
}

function refreshClientSubscribe(name: string, what: string, format: string): string {
  return buildCommand(
    `refresh-client -B ${tmuxEscape(name)}:${tmuxEscape(what)}:${tmuxEscape(format)}`
  );
}

function refreshClientUnsubscribe(name: string): string {
  return buildCommand(`refresh-client -B ${tmuxEscape(name)}`);
}

export {
  tmuxEscape,
  buildCommand,
  refreshClientSize,
  refreshClientPaneAction,
  refreshClientSubscribe,
  refreshClientUnsubscribe,
};
