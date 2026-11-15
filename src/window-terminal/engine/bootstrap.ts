// src/window-terminal/engine/bootstrap.ts
//
// The tmux reads that put a window's facts together on arrival, and the
// grammar of the two subscriptions that keep them current. Command strings in,
// parsed values out; the engine executes.
//
// [LAW:one-source-of-truth] Each format string lives here once, beside the
//   parser of what it produces.
// [LAW:parse-dont-validate] A reply that does not parse throws
//   `TmuxReplyFormatError` carrying the command and the reply; nothing returns
//   a guessed or partial snapshot.

import type { PaneRecord } from "../../browser.js";
import { TmuxReplyFormatError } from "../../browser.js";
import { latin1ToText } from "../../protocol/byte-codec.js";
import { tmuxEscape, windowLayoutFields } from "../../protocol/index.js";
import { paneIdOf, windowNumber, type PaneId, type WindowId } from "../ids.js";
import type { PaneMeta, WindowFlags, WindowSnapshot } from "./window-model.js";

/** The windows of the session this control client is attached to. */
export const ATTACHED_WINDOWS_COMMAND = "list-windows -F '#{window_id}'";
/** Every window on the server. */
export const ALL_WINDOWS_COMMAND = "list-windows -a -F '#{window_id}'";

/**
 * Where the window stands for this connection. tmux reports a window's layout
 * only to clients attached to a session holding it (`%layout-change` is
 * session-filtered), so a window elsewhere on the server cannot be followed.
 */
export type Membership = "attached" | "window-unreachable" | "window-closed";

function parseWindowIds(
  command: string,
  output: readonly string[],
): ReadonlySet<string> {
  for (const line of output) {
    if (!/^@\d+$/.test(line)) throw new TmuxReplyFormatError(command, output);
  }
  return new Set(output);
}

export function parseMembership(
  id: WindowId,
  attached: readonly string[],
  all: readonly string[],
): Membership {
  if (parseWindowIds(ATTACHED_WINDOWS_COMMAND, attached).has(id)) {
    return "attached";
  }
  return parseWindowIds(ALL_WINDOWS_COMMAND, all).has(id)
    ? "window-unreachable"
    : "window-closed";
}

/** `window_bell_flag`, `window_activity_flag`, `window_silence_flag`, each 0 or 1. */
export const FLAGS_FORMAT =
  "#{window_bell_flag}#{window_activity_flag}#{window_silence_flag}";

export function parseFlags(value: string): WindowFlags | null {
  const m = /^([01])([01])([01])$/.exec(value);
  return m === null
    ? null
    : { bell: m[1] === "1", activity: m[2] === "1", silence: m[3] === "1" };
}

// A process names itself (Linux reads its argv[0]), and tmux writes a
// subscription value into the control stream raw, so a newline in the name
// would end the `%subscription-changed` line and the rest would read as
// protocol. Its control bytes read `?`, as ps(1) prints them, in both places
// a command reaches the view. A range of the two end bytes, since a newline
// cannot appear in a command line and `[[:cntrl:]]`'s colons end tmux's
// modifier.
const CONTROL_BYTES = "[\x01-\x1f\x7f]";
const controlBytes = new RegExp(CONTROL_BYTES, "g");
const printableCommand = (name: string): string =>
  name.replace(controlBytes, "?");

/**
 * A pane's title, then its current command. tmux refuses a title holding a
 * control character, and the command's are replaced, so the one tab is the
 * separator.
 */
export const PANE_META_FORMAT = `#{pane_title}\t#{s/${CONTROL_BYTES}/?/:pane_current_command}`;

export function parsePaneMeta(value: string): PaneMeta | null {
  const tab = value.indexOf("\t");
  return tab === -1
    ? null
    : {
        title: latin1ToText(value.slice(0, tab)),
        command: latin1ToText(value.slice(tab + 1)),
      };
}

const SNAPSHOT_FORMAT = [
  "#{window_layout}",
  "#{window_visible_layout}",
  "#{window_raw_flags}",
  "#{window_name}",
  "#{pane_id}",
  FLAGS_FORMAT,
].join("\t");

export function snapshotCommand(id: WindowId): string {
  return `display-message -p -t ${id} ${tmuxEscape(SNAPSHOT_FORMAT)}`;
}

function metaOf(p: PaneRecord): PaneMeta {
  return {
    title: p.title,
    command:
      p.process.state === "running"
        ? printableCommand(p.process.currentCommand)
        : "",
  };
}

/**
 * The window's snapshot from `snapshotCommand`'s reply and `listPanes()`'s
 * records. A window name cannot hold a tab (tmux refuses one), so the reply
 * splits into exactly six fields.
 */
export function parseSnapshot(
  id: WindowId,
  output: readonly string[],
  panes: readonly PaneRecord[],
): WindowSnapshot {
  const fail = (): never => {
    throw new TmuxReplyFormatError(snapshotCommand(id), output);
  };
  const fields = output.length === 1 ? output[0].split("\t") : [];
  if (fields.length !== 6) return fail();
  const [layout, visible, rawFlags, name, pane, flagBits] = fields;
  const active = /^%(\d+)$/.exec(pane);
  const flags = parseFlags(flagBits);
  if (active === null || flags === null) return fail();
  const n = windowNumber(id);
  const meta = new Map<PaneId, PaneMeta>(
    panes
      .filter((p) => p.windowId === n)
      .map((p) => [paneIdOf(p.paneId), metaOf(p)]),
  );
  return {
    id,
    name: latin1ToText(name),
    active: paneIdOf(Number(active[1])),
    flags,
    layout: windowLayoutFields(layout, visible, rawFlags),
    meta,
  };
}
