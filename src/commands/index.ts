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
import type { SplitOptions } from "../protocol/encoder.js";
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
  listWindowsCommand,
  listPanesCommand,
  listSessionsCommand,
  sendKeys as encodeSendKeys,
  splitWindow as encodeSplitWindow,
  capturePane as encodeCapturePane,
  newWindow as encodeNewWindow,
} from "../protocol/encoder.js";
import {
  parseWindowRecordLine,
  parsePaneRecordLine,
  parseSessionRecordLine,
  parseNewWindowReply,
} from "../pane-output.js";
import { latin1ToBytes } from "../protocol/byte-codec.js";
import {
  type TmuxVersion,
  REQUEST_REPORT_MIN_VERSION,
  parseTmuxVersion,
  meetsTmuxVersion,
} from "../tmux-compat.js";
import {
  TmuxReplyFormatError,
  UnsupportedTmuxVersionError,
} from "../errors.js";

export { PaneAction };
export type { SplitOptions };

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
// the reply grammar in pane-output.ts. A missing session rejects through
// execute() as TmuxCommandError with tmux's text ("can't find session: X").
// A cwd that does not exist does NOT reject: tmux starts the pane in $HOME
// instead (verified on tmux 3.8), and the library, typed over any
// TmuxConnection, cannot stat the tmux host's filesystem. A caller that
// must not fall back checks the path on the host it controls. The ids come
// back before the pane's child has chdir'd, so a listPanes() straight after
// can still report the server's cwd: pane_current_path is the live process
// cwd, not the requested one.
// [LAW:no-silent-failure] A reply that is not exactly one `@N\t%N` line
// throws rather than inventing ids.
export async function newWindow(
  client: TmuxConnection,
  options: {
    readonly session: string;
    readonly cwd: string;
    readonly command?: string;
  },
): Promise<NewWindowResult> {
  // [LAW:no-silent-failure] Each of these would succeed somewhere the caller
  // did not ask for, so it is refused by field name: session '' ('=:') is the
  // control client's own session; a cwd that is empty or not absolute ('',
  // 'proj', '~/proj' — quoted, so tmux never expands '~') starts the pane in
  // $HOME; command '' is not "the default shell" (that is an omitted
  // command); a newline anywhere splits the command line.
  for (const field of ["session", "cwd", "command"] as const) {
    const value = options[field];
    if (value === "" || value?.includes("\n")) {
      throw new RangeError(
        `newWindow: ${field} must be non-empty and one line: ${JSON.stringify(value)}`,
      );
    }
  }
  if (!options.cwd.startsWith("/")) {
    throw new RangeError(
      `newWindow: cwd must be an absolute path: ${JSON.stringify(options.cwd)}`,
    );
  }
  const command = encodeNewWindow(
    options.session,
    options.cwd,
    options.command,
  );
  const response = await client.execute(command);
  const result = parseNewWindowReply(response.output);
  if (result === null) {
    throw new TmuxReplyFormatError(command, response.output);
  }
  return result;
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
 * [LAW:no-silent-failure] Rejects loudly if the reply carries no recognisable
 * version rather than guessing a floor.
 */
export async function queryTmuxVersion(
  client: TmuxConnection,
): Promise<TmuxVersion> {
  const response = await client.execute(displayMessageVersion());
  const version = response.output
    .map((line) => parseTmuxVersion(line))
    .find((v): v is TmuxVersion => v !== null);
  if (version === undefined) {
    throw new TmuxReplyFormatError(displayMessageVersion(), response.output);
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

// [LAW:single-enforcer] requestReport is the sole gate for the `refresh-client
// -r` version floor. `-r` was added in tmux 3.5; the library supports tmux
// 3.2+, so a caller on 3.2-3.4 would otherwise receive tmux's raw "unknown
// flag" %error. We probe the live version first and surface a clear,
// version-named precondition failure instead.
export async function requestReport(
  client: TmuxConnection,
  paneId: number,
  report: string,
): Promise<CommandResponse> {
  const version = await queryTmuxVersion(client);
  if (!meetsTmuxVersion(version, REQUEST_REPORT_MIN_VERSION)) {
    throw new UnsupportedTmuxVersionError(
      "requestReport (refresh-client -r)",
      REQUEST_REPORT_MIN_VERSION,
      version,
    );
  }
  return client.execute(refreshClientReport(paneId, report));
}

export function queryClipboard(
  client: TmuxConnection,
): Promise<CommandResponse> {
  return client.execute(refreshClientQueryClipboard());
}
