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
import { PaneAction } from "../protocol/types.js";
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
  sendKeys as encodeSendKeys,
  splitWindow as encodeSplitWindow,
} from "../protocol/encoder.js";

export { PaneAction };
export type { SplitOptions };

const SYNTHETIC_OK: CommandResponse = Object.freeze({
  commandNumber: -1,
  timestamp: 0,
  success: true as const,
  output: [] as const,
});

export function listWindows(client: TmuxConnection): Promise<CommandResponse> {
  return client.execute("list-windows");
}

export function listPanes(client: TmuxConnection): Promise<CommandResponse> {
  return client.execute("list-panes");
}

// [LAW:types-are-the-program] The encoder returns null for empty keys
// (no valid wire form exists). A null-keyed send is a no-op — resolved
// immediately with a synthetic success so callers never see a branch.
export function sendKeys(
  client: TmuxConnection,
  target: string,
  keys: string,
): Promise<CommandResponse> {
  const cmd = encodeSendKeys(target, keys);
  if (cmd === null) return Promise.resolve(SYNTHETIC_OK);
  return client.execute(cmd);
}

export function splitWindow(
  client: TmuxConnection,
  options?: SplitOptions,
): Promise<CommandResponse> {
  return client.execute(encodeSplitWindow(options));
}

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

export function requestReport(
  client: TmuxConnection,
  paneId: number,
  report: string,
): Promise<CommandResponse> {
  return client.execute(refreshClientReport(paneId, report));
}

export function queryClipboard(
  client: TmuxConnection,
): Promise<CommandResponse> {
  return client.execute(refreshClientQueryClipboard());
}
