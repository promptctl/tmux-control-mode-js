// src/commands/index.ts
// Free functions over TmuxConnection — the public tmux command surface.
//
// [LAW:types-are-the-program] All tmux commands are free functions over the
// 5-method TmuxConnection interface. Nothing in this module requires the full
// TmuxClient class. Anything that needs to issue tmux commands types against
// TmuxConnection, not TmuxClient.
// [LAW:one-source-of-truth] Command string construction delegates entirely to
// src/protocol/encoder.ts. This module is pure dispatch: typed params in,
// CommandResponse out.
// [LAW:single-enforcer] execute() is the sole dispatch path; these functions
// are thin wrappers, not an alternate escape hatch.

import type { TmuxConnection } from "../client.js";
import type {
  CommandResponse,
  NewWindowResult,
  PaneCapture,
  PaneRecord,
  SessionRecord,
  WindowRecord,
} from "../protocol/types.js";
import { PaneAction, emptyKeysResponse } from "../protocol/types.js";
import type {
  NewWindowPlacement,
  PaneProcess,
  SplitOptions,
} from "../protocol/encoder.js";
import {
  refreshClientSize,
  refreshClientPaneAction,
  refreshClientSubscribe,
  refreshClientUnsubscribe,
  refreshClientSetFlags,
  refreshClientClearFlags,
  refreshClientReport,
  refreshClientQueryClipboard,
  displayMessageVersion,
  displayMessageOwnClient,
  displayMessagePaneCwd,
  listWindowsCommand,
  listPanesCommand,
  listSessionsCommand,
  sendKeys as encodeSendKeys,
  splitWindow as encodeSplitWindow,
  capturePane as encodeCapturePane,
  newWindow as encodeNewWindow,
  newEmptyWindow as encodeNewEmptyWindow,
  respawnPane as encodeRespawnPane,
} from "../protocol/encoder.js";
import {
  parseWindowRecordLine,
  parsePaneRecordLine,
  parseSessionRecordLine,
  parseNewWindowReply,
  parsePaneCwdReply,
} from "../pane-output.js";
import { latin1ToBytes } from "../protocol/byte-codec.js";
import {
  type TmuxVersion,
  REQUEST_REPORT_MIN_VERSION,
  QUERY_CLIPBOARD_MIN_VERSION,
  PANE_CWD_MIN_VERSION,
  EMPTY_WINDOW_MIN_VERSION,
  parseTmuxVersionValue,
  meetsTmuxVersion,
} from "../tmux-compat.js";
import {
  PaneCwdUnavailableError,
  TmuxReplyFormatError,
  UnsupportedTmuxVersionError,
  UnrecognizedTmuxVersionError,
} from "../errors.js";

export { PaneAction };
export type { NewWindowPlacement, PaneProcess, SplitOptions };

// [LAW:one-source-of-truth] The command string lives in encoder.ts, the line
// grammar lives in pane-output.ts; this function is pure dispatch + filter,
// same as every other free function here. Structured records, never a raw
// CommandResponse for the caller to parse — that parsing is exactly what
// cc-tmux-lifeboat's founding doc forbids downstream.
export async function listWindows(
  client: TmuxConnection,
): Promise<readonly WindowRecord[]> {
  const response = await client.execute(listWindowsCommand());
  return response.output
    .map(parseWindowRecordLine)
    .filter((record): record is WindowRecord => record !== null);
}

export async function listPanes(
  client: TmuxConnection,
): Promise<readonly PaneRecord[]> {
  const response = await client.execute(listPanesCommand());
  return response.output
    .map(parsePaneRecordLine)
    .filter((record): record is PaneRecord => record !== null);
}

export async function listSessions(
  client: TmuxConnection,
): Promise<readonly SessionRecord[]> {
  const response = await client.execute(listSessionsCommand());
  return response.output
    .map(parseSessionRecordLine)
    .filter((record): record is SessionRecord => record !== null);
}

// [LAW:one-source-of-truth] `response.output` is already one latin1-container
// string per captured line (the same boundary every other command's output
// crosses); every element crosses it through `latin1ToBytes`, matching
// `byte-codec.ts`'s single-enforcer contract — never a hand-rolled
// charCodeAt loop here instead.
// [LAW:carrying-cost] `-S -` makes this the one command whose output can be
// arbitrarily large (a full scrollback, not a bounded `-F` list). Converting
// per line into one preallocated buffer avoids materializing a second
// full-size copy as an intermediate `response.output.join("\n")` string
// (which `String.fromCharCode`-based latin1 content doubles again, being
// UTF-16) before it is ever reduced to bytes.
export async function capturePane(
  client: TmuxConnection,
  paneId: number,
): Promise<PaneCapture> {
  const response = await client.execute(encodeCapturePane(paneId));
  const lines = response.output.map(latin1ToBytes);
  const separatorCount = lines.length > 0 ? lines.length - 1 : 0;
  const bytes = new Uint8Array(
    lines.reduce((total, line) => total + line.length, separatorCount),
  );
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) bytes[offset++] = 0x0a; // "\n" between captured lines
    bytes.set(lines[i], offset);
    offset += lines[i].length;
  }
  return { bytes, lineCount: response.output.length };
}

// [LAW:one-source-of-truth] Command and reply format live in encoder.ts,
// the reply grammar in pane-output.ts.
// [LAW:no-silent-failure] A reply that is not exactly one `@N\t%N` line
// throws rather than inventing ids.
async function createWindow(
  client: TmuxConnection,
  command: string,
): Promise<NewWindowResult> {
  const response = await client.execute(command);
  const result = parseNewWindowReply(response.output);
  if (result === null) {
    throw new TmuxReplyFormatError(command, response.output);
  }
  return result;
}

/**
 * Open a window in the session with id `sessionId` and start a process in its
 * pane (`new-window`). A caller that holds a session's name reads the id on
 * this connection first:
 * `(await listSessions(client)).find((s) => s.sessionName === name)?.sessionId`,
 * which is `undefined` when no session has that name.
 *
 * Rejects with `TmuxCommandError` carrying tmux's text when tmux refuses
 * (`can't find session: $9`). Rejects with `RangeError`, nothing sent, for a
 * value tmux would honor somewhere other than asked: a `cwd` that is not
 * absolute, an empty `command`, an environment name that is empty or holds
 * `=`, a newline in any of them.
 *
 * tmux does not refuse a command that cannot run: the ids come back and the
 * window closes when the shell exits. {@link newEmptyWindow} is how to keep
 * that pane.
 *
 * A `cwd` that does not exist does NOT reject: tmux starts the pane in $HOME
 * instead (verified on tmux 3.8; tmux 3.3 keeps the server's cwd, see
 * missingCwdFallback in tmux-compat.ts), and the library, typed over any
 * TmuxConnection, cannot stat the tmux host's filesystem. A caller that must
 * not fall back checks the path on the host it controls; paneCwd() reads the
 * directory the pane's process is in now (its live cwd, not the requested
 * string), which right after the spawn is where it started. Before tmux 3.7
 * the ids come back before the pane's child has chdir'd, so a listPanes()
 * straight after can still report the server's cwd (see PANE_CWD_MIN_VERSION).
 */
export async function newWindow(
  client: TmuxConnection,
  options: NewWindowPlacement & PaneProcess,
): Promise<NewWindowResult> {
  return createWindow(client, encodeNewWindow(options, options));
}

/**
 * Open a window whose pane has no process (`new-window -E`, tmux 3.8+; below
 * that it rejects with `UnsupportedTmuxVersionError` and makes no window).
 * Nothing runs in the pane until {@link respawnPane}, so what must hold before
 * the process starts is set in between, each step its own call:
 *
 * ```ts
 * const { windowId, paneId } = await newEmptyWindow(client, { sessionId });
 * await client.execute(`set-option -p -t %${paneId} remain-on-exit failed`);
 * await respawnPane(client, paneId, { command });
 * ```
 *
 * With `remain-on-exit failed` a command that cannot run leaves a dead pane
 * holding the shell's message, where `newWindow` leaves nothing. The window
 * exists from the first call: when a later one rejects, the caller finishes
 * it or removes it (`kill-window -t @${windowId}`).
 */
export async function newEmptyWindow(
  client: TmuxConnection,
  placement: NewWindowPlacement,
): Promise<NewWindowResult> {
  await requireTmuxVersion(
    client,
    "newEmptyWindow (new-window -E)",
    EMPTY_WINDOW_MIN_VERSION,
  );
  return createWindow(client, encodeNewEmptyWindow(placement));
}

/**
 * Start a process in a pane that has none (`respawn-pane`): the pane of
 * {@link newEmptyWindow}, or a dead one tmux kept under `remain-on-exit`. A
 * pane whose process is alive rejects with `TmuxCommandError`
 * (`respawn pane failed: pane work:1.0 still active`). Refuses the same values
 * as {@link newWindow}; {@link PaneProcess} says what an omitted field means
 * here.
 */
export async function respawnPane(
  client: TmuxConnection,
  paneId: number,
  paneProcess: PaneProcess = {},
): Promise<CommandResponse> {
  return client.execute(encodeRespawnPane(paneId, paneProcess));
}

// The directory the pane's foreground process is in now, which right after
// newWindow() is the one it started in: the requested cwd as a realpath
// (compare against realpath(cwd), not cwd), or tmux's $HOME / "/" fallback.
// [LAW:no-ambient-temporal-coupling] Gated at 3.7 rather than polled below
// it: older tmux forks before the child chdirs, and no format tells a
// pre-chdir read from a settled one, so one read is the answer only where
// tmux makes it so.
// tmux 3.7 chdirs before it forks, so any path it reports is the settled
// one; until the child takes its pty it reports none, which rejects as
// PaneCwdUnavailableError rather than standing in for a path.
// [LAW:no-silent-failure] A reply that is not exactly one line throws.
export async function paneCwd(
  client: TmuxConnection,
  paneId: number,
): Promise<string> {
  await requireTmuxVersion(
    client,
    "paneCwd (#{pane_current_path} after spawn)",
    PANE_CWD_MIN_VERSION,
  );
  const command = displayMessagePaneCwd(paneId);
  const response = await client.execute(command);
  const cwd = parsePaneCwdReply(response.output);
  if (cwd === null) {
    throw new TmuxReplyFormatError(command, response.output);
  }
  if (cwd === "") throw new PaneCwdUnavailableError(paneId);
  return cwd;
}

// [LAW:types-are-the-program] The encoder returns null for empty keys
// (no valid wire form exists). A null-keyed send is a no-op — resolved
// immediately with a synthetic success so callers never see a branch.
// [LAW:one-source-of-truth] The synthetic response is built by the canonical
// emptyKeysResponse(); this function does not mint its own.
export function sendKeys(
  client: TmuxConnection,
  target: string,
  keys: string,
): Promise<CommandResponse> {
  const cmd = encodeSendKeys(target, keys);
  if (cmd === null) return Promise.resolve(emptyKeysResponse());
  return client.execute(cmd);
}

export function splitWindow(
  client: TmuxConnection,
  options?: SplitOptions,
): Promise<CommandResponse> {
  return client.execute(encodeSplitWindow(options));
}

/**
 * Set the overall client size, mapping to `refresh-client -C <width>x<height>`
 * (the encoder is `refreshClientSize` in `../protocol/encoder.ts`). This is the
 * first of the three `-C` forms tmux accepts; the per-window forms
 * (`refresh-client -C @<id>:<w>x<h>` and the per-window clear `... @<id>:`) have
 * no typed wrapper — issue them via `client.execute("refresh-client -C @<id>:...")`.
 */
export function setSize(
  client: TmuxConnection,
  width: number,
  height: number,
): Promise<CommandResponse> {
  return client.execute(refreshClientSize(width, height));
}

export function setPaneAction(
  client: TmuxConnection,
  paneId: number,
  action: PaneAction,
): Promise<CommandResponse> {
  return client.execute(refreshClientPaneAction(paneId, action));
}

export function subscribeRaw(
  client: TmuxConnection,
  name: string,
  what: string,
  format: string,
): Promise<CommandResponse> {
  return client.execute(refreshClientSubscribe(name, what, format));
}

export function unsubscribe(
  client: TmuxConnection,
  name: string,
): Promise<CommandResponse> {
  return client.execute(refreshClientUnsubscribe(name));
}

export function setFlags(
  client: TmuxConnection,
  flags: readonly string[],
): Promise<CommandResponse> {
  return client.execute(refreshClientSetFlags(flags));
}

export function clearFlags(
  client: TmuxConnection,
  flags: readonly string[],
): Promise<CommandResponse> {
  return client.execute(refreshClientClearFlags(flags));
}

/**
 * Probe the running tmux server's version over the live control-mode
 * connection (`display-message -p "#{version}"`).
 *
 * [LAW:effects-at-boundaries] The pure comparison helpers live in
 * tmux-compat.ts; this is the single effectful wrapper that turns a live
 * connection into a known version. Works against any transport (spawn,
 * websocket, electron) because the probe travels the control-mode channel to
 * the real tmux server, not a local `tmux -V` spawn.
 *
 * [LAW:no-silent-failure] Rejects loudly rather than guessing a floor: a reply
 * that is not exactly one line is a TmuxReplyFormatError; one line that is
 * not a bare tmux version is an UnrecognizedTmuxVersionError.
 */
export async function queryTmuxVersion(
  client: TmuxConnection,
): Promise<TmuxVersion> {
  const response = await client.execute(displayMessageVersion());
  if (response.output.length !== 1) {
    throw new TmuxReplyFormatError(displayMessageVersion(), response.output);
  }
  const version = parseTmuxVersionValue(response.output[0]);
  if (version === null) {
    throw new UnrecognizedTmuxVersionError(response.output);
  }
  return version;
}

/**
 * The tmux client this connection is. tmux counts a control client like any
 * other — in `#{session_attached}`, in `list-clients`, and as the subject of
 * `%client-session-changed` / `%client-detached` — so a consumer watching a
 * server filters itself out of what it observes by this `name`. `flags` is
 * tmux's own `#{client_flags}` list: tmux silently ignores a client flag it
 * does not know, so this is the one place to confirm `watchServerArgs`' flags
 * took effect on the running server.
 */
export interface OwnClient {
  readonly name: string;
  readonly pid: number;
  readonly flags: readonly string[];
}

const OWN_CLIENT_LINE = /^(\d+) (\S+) (.+)$/;

// [LAW:parse-dont-validate] The reply either becomes an OwnClient or throws;
// no partially-filled identity reaches a caller.
export function parseOwnClientLine(lines: readonly string[]): OwnClient {
  const match = lines.length === 1 ? OWN_CLIENT_LINE.exec(lines[0]) : null;
  if (match === null) {
    throw new TmuxReplyFormatError(displayMessageOwnClient(), lines);
  }
  return {
    pid: Number(match[1]),
    flags: match[2].split(","),
    name: match[3],
  };
}

/** Identify this connection's own tmux client (see {@link OwnClient}). */
export async function getOwnClient(client: TmuxConnection): Promise<OwnClient> {
  const response = await client.execute(displayMessageOwnClient());
  return parseOwnClientLine(response.output);
}

// [LAW:single-enforcer] The one probe-then-reject for commands newer than the
// library's 3.2 floor: the live version is checked before the command is sent,
// so a caller on old tmux gets a typed, version-named precondition failure
// instead of whatever that tmux does with the command.
async function requireTmuxVersion(
  client: TmuxConnection,
  feature: string,
  required: TmuxVersion,
): Promise<void> {
  const version = await queryTmuxVersion(client);
  if (!meetsTmuxVersion(version, required)) {
    throw new UnsupportedTmuxVersionError(feature, required, version);
  }
}

// `-r` was added in tmux 3.5; on 3.2-3.4 tmux would answer with a raw
// "unknown flag" %error.
export async function requestReport(
  client: TmuxConnection,
  paneId: number,
  report: string,
): Promise<CommandResponse> {
  await requireTmuxVersion(
    client,
    "requestReport (refresh-client -r)",
    REQUEST_REPORT_MIN_VERSION,
  );
  return client.execute(refreshClientReport(paneId, report));
}

// On tmux 3.2, `refresh-client -l` makes the control client exit, so ungated
// it would kill the whole connection rather than fail one command.
export async function queryClipboard(
  client: TmuxConnection,
): Promise<CommandResponse> {
  await requireTmuxVersion(
    client,
    "queryClipboard (refresh-client -l)",
    QUERY_CLIPBOARD_MIN_VERSION,
  );
  return client.execute(refreshClientQueryClipboard());
}
