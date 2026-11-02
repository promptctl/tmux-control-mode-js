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
// text that can contain spaces, so space cannot be the delimiter. tmux
// rejects a literal tab in a window or session name outright ("invalid
// window name", confirmed live on tmux 3.8), so those two fields are safe
// as plain values. `pane_current_path`, by contrast, is a raw filesystem
// path with no such restriction and tmux emits it byte-for-byte — a literal
// tab in the cwd (confirmed live: `new-session -c $'/tmp/x\ty'`) desyncs a
// flat split-by-tab. `pane_start_command`/`pane_current_command` need no
// such treatment either: they come from tmux's own argv-reconstruction,
// which already backslash-escapes (confirmed live: a literal backslash in
// the command renders as `\\`, a literal tab as `\t`) before we ever see
// them — escaping them again here would double-escape tmux's own encoding.
// `escapeFreeTextField` below applies the equivalent treatment to
// `pane_current_path`, which gets none of that protection natively.
export function listWindowsCommand(): string {
  return (
    "list-windows -a -F '#{session_id}\t#{session_name}\t#{window_id}\t" +
    "#{window_name}\t#{window_width}\t#{window_height}'"
  );
}

// One real backslash byte / one real tab byte, used to build the `s///`
// pattern and replacement arguments below without hand-counting backslashes
// in a template literal — tmux's own replacement-text parser consumes a
// backslash to escape the next character, so the JS-source backslash count
// and the wire-level backslash count are not the same number, and getting
// that mismatch wrong by eye is exactly the class of bug this function
// exists to prevent. Verified against a real tmux 3.8 process (see
// escapeFreeTextField below for the exact byte counts).
const BACKSLASH = "\\";
const TAB = "\t";

// Escapes backslash and tab in a free-text format expression so the result
// can never contain either byte literally, while staying losslessly
// reversible. Order matters: backslash is escaped first so the tab step
// cannot misinterpret a backslash this function introduced.
// [LAW:one-source-of-truth] `unescapeFreeTextField` (pane-output.ts) is the
// sole reverse of this encoding; the two must only ever change together.
function escapeFreeTextField(expr: string): string {
  // tmux's replacement-text parser collapses each escaped backslash pair to
  // one literal backslash, so a 2-byte pattern (one escaped backslash) with
  // a 4-byte replacement (two escaped backslash pairs) doubles every
  // backslash in the value.
  const backslashEscaped = `#{s/${BACKSLASH}${BACKSLASH}/${BACKSLASH.repeat(4)}/:${expr}}`;
  // A literal tab needs no pattern-side escaping (not an ERE metacharacter).
  // The 3-byte replacement is one escaped backslash pair (-> one literal
  // backslash) followed by a literal `t`, so the net effect is the two-byte
  // sequence `\t`.
  return `#{s/${TAB}/${BACKSLASH}${BACKSLASH}t/:${backslashEscaped}}`;
}

export function listPanesCommand(): string {
  return (
    "list-panes -a -F '#{session_id}\t#{session_name}\t#{window_id}\t" +
    `#{window_name}\t#{pane_id}\t${escapeFreeTextField("#{pane_current_path}")}\t` +
    "#{pane_pid}\t#{pane_start_command}\t#{pane_current_command}\t" +
    "#{pane_width}\t#{pane_height}'"
  );
}

export function listSessionsCommand(): string {
  return (
    "list-sessions -F '#{session_id}\t#{session_name}\t#{session_windows}\t" +
    "#{session_attached}'"
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
