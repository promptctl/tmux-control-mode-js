// src/protocol/encoder.ts
// Command string builders for tmux control mode.
// No runtime dependencies. Works in browser, Deno, Bun, Node.
//
// [LAW:one-source-of-truth] All command string construction lives here.
// Every function returns a PLAIN command string — no trailing newline.
// The transport layer (TmuxClient.execute) adds the newline.
// [LAW:single-enforcer] All user-argument escaping goes through tmuxEscape.

import type { PaneAction } from "./types.js";

// [LAW:one-source-of-truth] Encoder owns the SplitOptions shape.
export interface SplitOptions {
  readonly vertical?: boolean;
  readonly target?: string;
}

export function tmuxEscape(arg: string): string {
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

export function refreshClientSize(width: number, height: number): string {
  return `refresh-client -C ${width}x${height}`;
}

// [LAW:one-source-of-truth] The fixed `-F` format strings behind the public
// listWindows/listPanes records live here only; commands/index.ts just
// executes them and pane-output.ts just parses their output. Tab-separated:
// unlike the ids, several of these fields (names, paths, commands) are free
// text that can contain spaces, so space cannot be the delimiter. A literal
// tab is the conventional tmux-scripting delimiter for exactly this reason —
// names/paths essentially never contain one.
export function listWindowsCommand(): string {
  return (
    "list-windows -a -F '#{session_id}\t#{session_name}\t#{window_id}\t" +
    "#{window_name}\t#{window_width}\t#{window_height}'"
  );
}

export function listPanesCommand(): string {
  return (
    "list-panes -a -F '#{session_id}\t#{session_name}\t#{window_id}\t" +
    "#{window_name}\t#{pane_id}\t#{pane_current_path}\t#{pane_pid}\t" +
    "#{pane_start_command}\t#{pane_current_command}\t#{pane_width}\t" +
    "#{pane_height}'"
  );
}

export function refreshClientPaneAction(
  paneId: number,
  action: PaneAction,
): string {
  // [LAW:single-enforcer] tmux's command parser splits unquoted arguments on
  // ':' and rejects `%N:action`. Quote the entire pane:action token.
  return `refresh-client -A ${tmuxEscape(`%${paneId}:${action}`)}`;
}

export function refreshClientSubscribe(
  name: string,
  what: string,
  format: string,
): string {
  return `refresh-client -B ${tmuxEscape(name)}:${tmuxEscape(what)}:${tmuxEscape(format)}`;
}

export function refreshClientUnsubscribe(name: string): string {
  return `refresh-client -B ${tmuxEscape(name)}`;
}

const utf8Encoder = new TextEncoder();

function utf8HexBytes(s: string): string {
  const bytes = utf8Encoder.encode(s);
  const hex = new Array<string>(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    hex[i] = bytes[i].toString(16).padStart(2, "0");
  }
  return hex.join(" ");
}

// [LAW:one-source-of-truth] send-keys wire format lives here only.
// Returns null for empty input — no valid wire form exists for zero keys.
// [LAW:types-are-the-program] string | null carries the command/no-command
// variability; callers handle the null case by structure.
export function sendKeys(target: string, keys: string): string | null {
  if (keys === "") return null;
  return `send-keys -H -t ${tmuxEscape(target)} ${utf8HexBytes(keys)}`;
}

// [LAW:one-source-of-truth] split-window wire format lives here only.
export function splitWindow(options: SplitOptions = {}): string {
  const dirFlag = options.vertical === true ? "-v" : "-h";
  const targetPart =
    options.target !== undefined ? ` -t ${tmuxEscape(options.target)}` : "";
  return `split-window ${dirFlag}${targetPart}`;
}

// [LAW:one-source-of-truth] refresh-client -f wire format lives here only.
export function refreshClientSetFlags(flags: readonly string[]): string {
  return `refresh-client -f ${flags.join(",")}`;
}

export function refreshClientClearFlags(flags: readonly string[]): string {
  return refreshClientSetFlags(flags.map((f) => `!${f}`));
}

// [LAW:one-source-of-truth] refresh-client -r wire format lives here only.
export function refreshClientReport(paneId: number, report: string): string {
  return `refresh-client -r ${tmuxEscape(`%${paneId}:${report}`)}`;
}

// [LAW:one-source-of-truth] refresh-client -l wire format lives here only.
export function refreshClientQueryClipboard(): string {
  return `refresh-client -l`;
}

// [LAW:one-source-of-truth] The version-probe wire format lives here only.
// `#{version}` is a format variable present since tmux 2.4 (verified in the
// tmux 3.2 source, format.c — our load-bearing floor), so this probe resolves
// across the entire supported range. In control mode the reply is a single
// %output line carrying the version string (e.g. `3.5a`).
export function displayMessageVersion(): string {
  return `display-message -p "#{version}"`;
}

// [LAW:one-source-of-truth] Detach byte sequence lives here only.
// Returns just "\n" — a bare newline causes tmux to exit (SPEC §4.1).
// This is NOT a command and does NOT go through execute().
export function detachClient(): string {
  return "\n";
}
