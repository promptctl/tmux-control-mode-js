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
  // [LAW:single-enforcer] tmux's command parser splits unquoted arguments on
  // ':' and rejects `%N:action`. Quote the entire pane:action token as one
  // argument so it reaches refresh-client intact.
  return buildCommand(`refresh-client -A ${tmuxEscape(`%${paneId}:${action}`)}`);
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

// ---------------------------------------------------------------------------
// Client flags (SPEC §9, refresh-client -f)
// ---------------------------------------------------------------------------

/**
 * Set or clear client flags via `refresh-client -f`.
 *
 * Flag names like `pause-after`, `pause-after=2`, `no-output`, `read-only`,
 * `wait-exit`, `ignore-size`, `active-pane`, `no-detach-on-destroy`. Prefix
 * a flag with `!` to disable it (per SPEC §9).
 *
 * `setClientFlags(["pause-after=2", "no-output"])` →
 *   `refresh-client -f pause-after=2,no-output`
 *
 * `setClientFlags(["!pause-after"])` → `refresh-client -f !pause-after`
 *
 * Use `clearClientFlags(["pause-after"])` for the common "disable these flags"
 * case — it prepends `!` to each name and delegates here.
 */
// [LAW:one-source-of-truth] refresh-client -f wire format lives here only.
function refreshClientSetFlags(flags: readonly string[]): string {
  // [LAW:dataflow-not-control-flow] Always join; empty input yields empty list,
  // tmux will reject it with %error — that's a value-driven outcome, not a
  // skipped operation. The flags list is comma-separated and NOT escaped per
  // tmux's syntax (cmd-refresh-client.c parses this directly).
  return buildCommand(`refresh-client -f ${flags.join(",")}`);
}

/**
 * Clear (disable) client flags. Convenience wrapper that prepends `!` to each
 * flag name and delegates to `refreshClientSetFlags`.
 *
 * `clearClientFlags(["pause-after", "no-output"])` →
 *   `refresh-client -f !pause-after,!no-output`
 */
// [LAW:one-source-of-truth] Bang-prefix logic lives here only.
function refreshClientClearFlags(flags: readonly string[]): string {
  return refreshClientSetFlags(flags.map((f) => `!${f}`));
}

// ---------------------------------------------------------------------------
// Reports (SPEC §15, refresh-client -r)
// ---------------------------------------------------------------------------

/**
 * Provide a terminal report (e.g., OSC 10/11 color response) to tmux on
 * behalf of a pane. Used to feed back fg/bg color queries.
 *
 * `refreshClientReport(0, "\\033]10;rgb:0000/0000/0000\\033\\\\")` →
 *   `refresh-client -r %0:'<the OSC string>'`
 */
// [LAW:one-source-of-truth] refresh-client -r wire format lives here only.
// The whole `pane-id:report` string must be a single quoted argument so
// tmux's parser doesn't split on the colon.
function refreshClientReport(paneId: number, report: string): string {
  return buildCommand(`refresh-client -r ${tmuxEscape(`%${paneId}:${report}`)}`);
}

// ---------------------------------------------------------------------------
// Clipboard query (SPEC §19, refresh-client -l)
// ---------------------------------------------------------------------------

/**
 * Request the terminal's clipboard contents via OSC 52. Returns the
 * `refresh-client -l` wire string. The actual clipboard content arrives
 * asynchronously via the terminal's response channel; from the protocol
 * library's perspective this is a fire-and-correlate request that resolves
 * with a `%end` confirmation.
 */
// [LAW:one-source-of-truth] refresh-client -l wire format lives here only.
function refreshClientQueryClipboard(): string {
  return buildCommand(`refresh-client -l`);
}

// ---------------------------------------------------------------------------
// Detach (SPEC §4.1)
// ---------------------------------------------------------------------------

/**
 * The detach signal: a single LF on stdin causes the tmux client to exit
 * (sets CLIENT_EXIT). Returns just `"\n"` so it flows through the same
 * `transport.send` path as every other wire string.
 */
// [LAW:one-source-of-truth] Detach byte sequence lives here only.
function detachClient(): string {
  return "\n";
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
  refreshClientSetFlags,
  refreshClientClearFlags,
  refreshClientReport,
  refreshClientQueryClipboard,
  detachClient,
};
