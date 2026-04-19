// src/protocol/parser.ts
// Streaming, line-oriented, push-based parser for the tmux control mode protocol.
// Pure TypeScript — no Node.js dependencies. Works in browser, Deno, Bun.

import type { TmuxMessage } from "./types.js";
import { decodeOctalEscapes } from "./decode.js";

// ---------------------------------------------------------------------------
// ID helpers — one parser per prefix convention
// [LAW:one-source-of-truth] Canonical ID parsing lives here only.
// ---------------------------------------------------------------------------

/** Parse `%N` → number. */
function parsePaneId(raw: string): number {
  return parseInt(raw.slice(1), 10);
}

/** Parse `@N` → number. */
function parseWindowId(raw: string): number {
  return parseInt(raw.slice(1), 10);
}

/** Parse `$N` → number. */
function parseSessionId(raw: string): number {
  return parseInt(raw.slice(1), 10);
}

/** Parse an optional-ID field: `-` → -1, otherwise delegate to `parse`. */
function parseOptionalId(raw: string, parse: (s: string) => number): number {
  return raw === "-" ? -1 : parse(raw);
}

/** Parse an optional integer field: `-` → -1, otherwise parseInt. */
function parseOptionalInt(raw: string): number {
  return raw === "-" ? -1 : parseInt(raw, 10);
}

// ---------------------------------------------------------------------------
// Per-type line parsers
// [LAW:one-type-per-behavior] Guard messages share one parser (parseGuard).
// [LAW:one-source-of-truth] The dispatch table is the single mapping from
// wire type-string to parser function.
// ---------------------------------------------------------------------------

type LineParseFn = (args: string) => TmuxMessage | null;

function parseGuard(
  type: "begin" | "end" | "error",
  args: string,
): TmuxMessage | null {
  const parts = args.split(" ");
  if (parts.length < 3) return null;
  return {
    type,
    timestamp: parseInt(parts[0], 10),
    commandNumber: parseInt(parts[1], 10),
    flags: parseInt(parts[2], 10),
  };
}

function parseOutput(args: string): TmuxMessage | null {
  const spaceIdx = args.indexOf(" ");
  if (spaceIdx === -1) return null;
  const paneRaw = args.slice(0, spaceIdx);
  const value = args.slice(spaceIdx + 1);
  return {
    type: "output",
    paneId: parsePaneId(paneRaw),
    data: decodeOctalEscapes(value),
  };
}

function parseExtendedOutput(args: string): TmuxMessage | null {
  // Format: %<paneId> <age> [reserved...] : <value>
  const colonIdx = args.indexOf(" : ");
  if (colonIdx === -1) return null;
  const head = args.slice(0, colonIdx);
  const value = args.slice(colonIdx + 3);
  const parts = head.split(" ");
  if (parts.length < 2) return null;
  return {
    type: "extended-output",
    paneId: parsePaneId(parts[0]),
    age: parseInt(parts[1], 10),
    data: decodeOctalEscapes(value),
  };
}

function parsePaneIdOnly(
  type: "pause" | "continue" | "pane-mode-changed",
): LineParseFn {
  return (args: string): TmuxMessage | null => {
    const paneRaw = args.split(" ")[0];
    if (!paneRaw) return null;
    return { type, paneId: parsePaneId(paneRaw) } as TmuxMessage;
  };
}

function parseWindowIdOnly(
  type:
    | "window-add"
    | "window-close"
    | "unlinked-window-add"
    | "unlinked-window-close",
): LineParseFn {
  return (args: string): TmuxMessage | null => {
    const winRaw = args.split(" ")[0];
    if (!winRaw) return null;
    return { type, windowId: parseWindowId(winRaw) } as TmuxMessage;
  };
}

function parseWindowRenamed(
  type: "window-renamed" | "unlinked-window-renamed",
): LineParseFn {
  return (args: string): TmuxMessage | null => {
    const spaceIdx = args.indexOf(" ");
    if (spaceIdx === -1) return null;
    return {
      type,
      windowId: parseWindowId(args.slice(0, spaceIdx)),
      name: args.slice(spaceIdx + 1),
    } as TmuxMessage;
  };
}

function parseWindowPaneChanged(args: string): TmuxMessage | null {
  const parts = args.split(" ");
  if (parts.length < 2) return null;
  return {
    type: "window-pane-changed",
    windowId: parseWindowId(parts[0]),
    paneId: parsePaneId(parts[1]),
  };
}

function parseLayoutChange(args: string): TmuxMessage | null {
  const parts = args.split(" ");
  if (parts.length < 4) return null;
  return {
    type: "layout-change",
    windowId: parseWindowId(parts[0]),
    windowLayout: parts[1],
    windowVisibleLayout: parts[2],
    windowFlags: parts[3],
  };
}

function parseSessionWithName(
  type: "session-changed" | "session-renamed",
): LineParseFn {
  return (args: string): TmuxMessage | null => {
    const spaceIdx = args.indexOf(" ");
    if (spaceIdx === -1) return null;
    return {
      type,
      sessionId: parseSessionId(args.slice(0, spaceIdx)),
      name: args.slice(spaceIdx + 1),
    } as TmuxMessage;
  };
}

function parseSessionsChanged(_args: string): TmuxMessage {
  return { type: "sessions-changed" };
}

function parseSessionWindowChanged(args: string): TmuxMessage | null {
  const parts = args.split(" ");
  if (parts.length < 2) return null;
  return {
    type: "session-window-changed",
    sessionId: parseSessionId(parts[0]),
    windowId: parseWindowId(parts[1]),
  };
}

function parseClientSessionChanged(args: string): TmuxMessage | null {
  const spaceIdx = args.indexOf(" ");
  if (spaceIdx === -1) return null;
  const rest = args.slice(spaceIdx + 1);
  const spaceIdx2 = rest.indexOf(" ");
  if (spaceIdx2 === -1) return null;
  return {
    type: "client-session-changed",
    clientName: args.slice(0, spaceIdx),
    sessionId: parseSessionId(rest.slice(0, spaceIdx2)),
    name: rest.slice(spaceIdx2 + 1),
  };
}

function parseClientDetached(args: string): TmuxMessage | null {
  const clientName = args.split(" ")[0];
  if (!clientName) return null;
  return { type: "client-detached", clientName };
}

function parseNameOnly(
  type: "paste-buffer-changed" | "paste-buffer-deleted",
): LineParseFn {
  return (args: string): TmuxMessage | null => {
    const name = args.split(" ")[0];
    if (!name) return null;
    return { type, name } as TmuxMessage;
  };
}

function parseSubscriptionChanged(args: string): TmuxMessage | null {
  // Format: <name> <session-id> <window-id> <window-index> <pane-id> [reserved...] : <value>
  const colonIdx = args.indexOf(" : ");
  if (colonIdx === -1) return null;
  const head = args.slice(0, colonIdx);
  const value = args.slice(colonIdx + 3);
  const parts = head.split(" ");
  if (parts.length < 5) return null;
  return {
    type: "subscription-changed",
    name: parts[0],
    sessionId: parseOptionalId(parts[1], parseSessionId),
    windowId: parseOptionalId(parts[2], parseWindowId),
    windowIndex: parseOptionalInt(parts[3]),
    paneId: parseOptionalId(parts[4], parsePaneId),
    value,
  };
}

function parseMessageMsg(args: string): TmuxMessage {
  return { type: "message", message: args };
}

function parseConfigError(args: string): TmuxMessage {
  return { type: "config-error", error: args };
}

function parseExit(args: string): TmuxMessage {
  const reason = args.length > 0 ? args : undefined;
  // [LAW:dataflow-not-control-flow] Both paths produce the same type; variability
  // is in the value (undefined vs string), not in whether we construct the object.
  return { type: "exit", reason };
}

// ---------------------------------------------------------------------------
// Dispatch table
// [LAW:one-source-of-truth] Single mapping from wire type to parser.
// [LAW:dataflow-not-control-flow] Lookup replaces a chain of if/else branches.
// ---------------------------------------------------------------------------

const PARSERS: ReadonlyMap<string, LineParseFn> = new Map<string, LineParseFn>([
  ["begin", (args) => parseGuard("begin", args)],
  ["end", (args) => parseGuard("end", args)],
  ["error", (args) => parseGuard("error", args)],
  ["output", parseOutput],
  ["extended-output", parseExtendedOutput],
  ["pause", parsePaneIdOnly("pause")],
  ["continue", parsePaneIdOnly("continue")],
  ["pane-mode-changed", parsePaneIdOnly("pane-mode-changed")],
  ["window-add", parseWindowIdOnly("window-add")],
  ["window-close", parseWindowIdOnly("window-close")],
  ["window-renamed", parseWindowRenamed("window-renamed")],
  ["window-pane-changed", parseWindowPaneChanged],
  ["unlinked-window-add", parseWindowIdOnly("unlinked-window-add")],
  ["unlinked-window-close", parseWindowIdOnly("unlinked-window-close")],
  ["unlinked-window-renamed", parseWindowRenamed("unlinked-window-renamed")],
  ["layout-change", parseLayoutChange],
  ["session-changed", parseSessionWithName("session-changed")],
  ["session-renamed", parseSessionWithName("session-renamed")],
  ["sessions-changed", parseSessionsChanged],
  ["session-window-changed", parseSessionWindowChanged],
  ["client-session-changed", parseClientSessionChanged],
  ["client-detached", parseClientDetached],
  ["paste-buffer-changed", parseNameOnly("paste-buffer-changed")],
  ["paste-buffer-deleted", parseNameOnly("paste-buffer-deleted")],
  ["subscription-changed", parseSubscriptionChanged],
  ["message", parseMessageMsg],
  ["config-error", parseConfigError],
  ["exit", parseExit],
]);

// ---------------------------------------------------------------------------
// TmuxParser
// ---------------------------------------------------------------------------

/**
 * Streaming, push-based parser for the tmux control mode protocol.
 *
 * Accepts arbitrary text chunks via `feed()` and emits parsed `TmuxMessage`
 * objects through the `onMessage` callback. Handles line buffering for chunks
 * that split across line boundaries.
 *
 * Response block tracking: lines between `%begin` and `%end`/`%error` that do
 * not start with `%` are command output lines. These are forwarded via the
 * optional `onOutputLine` callback with the associated command number, allowing
 * the client layer to aggregate them into `CommandResponse` objects.
 */
export class TmuxParser {
  // [LAW:single-enforcer] Response-block state is tracked exclusively here.
  private readonly emit: (msg: TmuxMessage) => void;
  private buffer = "";
  private activeCommandNumber = -1;

  /**
   * Optional callback for command output lines (lines between %begin and
   * %end/%error that do not start with %). The client layer sets this to
   * aggregate output into CommandResponse objects.
   */
  onOutputLine: ((commandNumber: number, line: string) => void) | null = null;

  constructor(onMessage: (msg: TmuxMessage) => void) {
    this.emit = onMessage;
  }

  /**
   * Push a chunk of data into the parser. The chunk may contain zero, one,
   * or many complete lines, and may end mid-line. The parser buffers partial
   * lines and processes complete ones immediately.
   */
  feed(chunk: string): void {
    this.buffer += chunk;

    // [LAW:dataflow-not-control-flow] The loop processes every complete line
    // unconditionally; variability lives in the line content, not in whether
    // the processing step runs.
    let newlineIdx = this.buffer.indexOf("\n");
    while (newlineIdx !== -1) {
      const line = this.buffer.slice(0, newlineIdx);
      this.buffer = this.buffer.slice(newlineIdx + 1);
      this.processLine(line);
      newlineIdx = this.buffer.indexOf("\n");
    }
  }

  /** Reset all internal state (line buffer and response-block tracking). */
  reset(): void {
    this.buffer = "";
    this.activeCommandNumber = -1;
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private processLine(line: string): void {
    const inResponseBlock = this.activeCommandNumber !== -1;
    const isNotification = line.charCodeAt(0) === 0x25; // '%'

    // Inside a response block, non-% lines are command output.
    // [LAW:dataflow-not-control-flow] Both branches produce a side effect
    // (emit message or emit output line); the data (isNotification) decides which.
    if (inResponseBlock && !isNotification) {
      this.onOutputLine?.(this.activeCommandNumber, line);
      return;
    }

    // Lines that don't start with % outside a response block are ignored
    // (shouldn't happen in a well-formed stream, but be robust).
    if (!isNotification) {
      return;
    }

    // Extract type and args from `%<type> <args...>` or `%<type>`
    const spaceIdx = line.indexOf(" ", 1);
    const typeStr = spaceIdx === -1 ? line.slice(1) : line.slice(1, spaceIdx);
    const args = spaceIdx === -1 ? "" : line.slice(spaceIdx + 1);

    const parser = PARSERS.get(typeStr);
    if (parser === undefined) {
      // Unknown notification type — skip silently. The protocol may evolve
      // and we must not crash on unrecognized messages.
      return;
    }

    const msg = parser(args);
    if (msg === null) {
      // Malformed line for a known type — skip.
      return;
    }

    // Update response-block tracking state.
    // [LAW:single-enforcer] Begin/end/error state transitions happen here only.
    if (msg.type === "begin") {
      this.activeCommandNumber = msg.commandNumber;
    } else if (msg.type === "end" || msg.type === "error") {
      this.activeCommandNumber = -1;
    }

    this.emit(msg);
  }
}
