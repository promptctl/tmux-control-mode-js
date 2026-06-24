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
import type { CommandResponse } from "../protocol/types.js";
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
  sendKeys as encodeSendKeys,
  splitWindow as encodeSplitWindow,
} from "../protocol/encoder.js";
import {
  type TmuxVersion,
  REQUEST_REPORT_MIN_VERSION,
  parseTmuxVersion,
  meetsTmuxVersion,
} from "../tmux-compat.js";
import { UnsupportedTmuxVersionError } from "../errors.js";

export { PaneAction };
export type { SplitOptions };

export function listWindows(client: TmuxConnection): Promise<CommandResponse> {
  return client.execute("list-windows");
}

export function listPanes(client: TmuxConnection): Promise<CommandResponse> {
  return client.execute("list-panes");
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
    throw new Error(
      `could not determine tmux version from reply: ${JSON.stringify(response.output)}`,
    );
  }
  return version;
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
