// src/protocol/encoder.ts
// Command string builders for tmux control mode.
// No runtime dependencies. Works in browser, Deno, Bun, Node.

import { PaneAction } from "./types.js";

// [LAW:one-source-of-truth] Encoder owns the SplitOptions shape; client.ts re-exports
// for API compatibility. Two definitions would drift.
export interface SplitOptions {
  readonly vertical?: boolean;
  readonly target?: string;
}

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

// [LAW:one-source-of-truth] send-keys wire format lives here only.
function sendKeys(target: string, keys: string): string {
  return buildCommand(`send-keys -t ${tmuxEscape(target)} -l ${tmuxEscape(keys)}`);
}

// [LAW:one-source-of-truth] split-window wire format lives here only.
// [LAW:dataflow-not-control-flow] Ternaries select VALUES (flag string, target fragment);
// the build operation runs unconditionally.
function splitWindow(options: SplitOptions = {}): string {
  const dirFlag = options.vertical === true ? "-v" : "-h";
  const targetPart = options.target !== undefined ? ` -t ${tmuxEscape(options.target)}` : "";
  return buildCommand(`split-window ${dirFlag}${targetPart}`);
}

export {
  tmuxEscape,
  buildCommand,
  refreshClientSize,
  refreshClientPaneAction,
  refreshClientSubscribe,
  refreshClientUnsubscribe,
  sendKeys,
  splitWindow,
};
