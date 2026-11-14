// src/protocol/parser.ts
// Streaming, line-oriented, push-based parser for the tmux control mode protocol.
// Pure TypeScript — no Node.js dependencies. Works in browser, Deno, Bun.

import type { ProtocolErrorMessage, TmuxMessage } from "./types.js";
import { decodeOctalEscapes } from "./decode.js";
import { windowLayoutFields } from "./layout.js";
import { parseUint } from "./uint.js";

// ---------------------------------------------------------------------------
// Field readers — one per field convention
// [LAW:one-source-of-truth] Canonical ID and number reading lives here only.
// ---------------------------------------------------------------------------

/**
 * Thrown by a per-type parser only, for a line it cannot read: too few fields
 * or a number field that is not one. `processLine` turns it into the
 * `protocol-error` report.
 *
 * [LAW:single-enforcer] The one way a per-type parser says "malformed".
 */
class MalformedLine extends Error {}

function malformed(): never {
  throw new MalformedLine();
}

/** Read an unsigned decimal field, or the line is malformed. */
function readUint(raw: string): number {
  return parseUint(raw) ?? malformed();
}

/** Read `<prefix>N` (`%N`, `@N`, `$N`) → N, or the line is malformed. */
function readPrefixedId(prefix: "%" | "@" | "$", raw: string): number {
  return raw.startsWith(prefix) ? readUint(raw.slice(1)) : malformed();
}

function parsePaneId(raw: string): number {
  return readPrefixedId("%", raw);
}

function parseWindowId(raw: string): number {
  return readPrefixedId("@", raw);
}

function parseSessionId(raw: string): number {
  return readPrefixedId("$", raw);
}

/** Parse an optional-ID field: `-` → -1, otherwise delegate to `parse`. */
function parseOptionalId(raw: string, parse: (s: string) => number): number {
  return raw === "-" ? -1 : parse(raw);
}

/** Parse an optional integer field: `-` → -1, otherwise an unsigned decimal. */
function parseOptionalInt(raw: string): number {
  return raw === "-" ? -1 : readUint(raw);
}

// ---------------------------------------------------------------------------
// Per-type line parsers
// [LAW:one-type-per-behavior] Guard messages share one parser (parseGuard).
// [LAW:one-source-of-truth] The dispatch table is the single mapping from
// wire type-string to parser function.
// ---------------------------------------------------------------------------

// A per-type parser returns its message or throws `MalformedLine`.
type LineParseFn = (args: string) => TmuxMessage;

function parseGuard(
  type: "begin" | "end" | "error",
  args: string,
): TmuxMessage {
  const parts = args.split(" ");
  if (parts.length < 3) malformed();
  return {
    type,
    timestamp: readUint(parts[0]),
    commandNumber: readUint(parts[1]),
    flags: readUint(parts[2]),
  };
}

function parseOutput(args: string): TmuxMessage {
  const spaceIdx = args.indexOf(" ");
  if (spaceIdx === -1) malformed();
  const paneRaw = args.slice(0, spaceIdx);
  const value = args.slice(spaceIdx + 1);
  return {
    type: "output",
    paneId: parsePaneId(paneRaw),
    data: decodeOctalEscapes(value),
  };
}

function parseExtendedOutput(args: string): TmuxMessage {
  // Format: %<paneId> <age> [reserved...] : <value>
  const colonIdx = args.indexOf(" : ");
  if (colonIdx === -1) malformed();
  const head = args.slice(0, colonIdx);
  const value = args.slice(colonIdx + 3);
  const parts = head.split(" ");
  if (parts.length < 2) malformed();
  return {
    type: "extended-output",
    paneId: parsePaneId(parts[0]),
    age: readUint(parts[1]),
    data: decodeOctalEscapes(value),
  };
}

function parsePaneIdOnly(
  type: "pause" | "continue" | "pane-mode-changed",
): LineParseFn {
  return (args: string): TmuxMessage => {
    const paneRaw = args.split(" ")[0];
    if (!paneRaw) malformed();
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
  return (args: string): TmuxMessage => {
    const winRaw = args.split(" ")[0];
    if (!winRaw) malformed();
    return { type, windowId: parseWindowId(winRaw) } as TmuxMessage;
  };
}

function parseWindowRenamed(
  type: "window-renamed" | "unlinked-window-renamed",
): LineParseFn {
  return (args: string): TmuxMessage => {
    const spaceIdx = args.indexOf(" ");
    if (spaceIdx === -1) malformed();
    return {
      type,
      windowId: parseWindowId(args.slice(0, spaceIdx)),
      name: args.slice(spaceIdx + 1),
    } as TmuxMessage;
  };
}

function parseWindowPaneChanged(args: string): TmuxMessage {
  const parts = args.split(" ");
  if (parts.length < 2) malformed();
  return {
    type: "window-pane-changed",
    windowId: parseWindowId(parts[0]),
    paneId: parsePaneId(parts[1]),
  };
}

function parseLayoutChange(args: string): TmuxMessage {
  const parts = args.split(" ");
  if (parts.length < 4) malformed();
  return {
    type: "layout-change",
    windowId: parseWindowId(parts[0]),
    ...windowLayoutFields(parts[1], parts[2], parts[3]),
  };
}

function parseSessionWithName(
  type: "session-changed" | "session-renamed",
): LineParseFn {
  return (args: string): TmuxMessage => {
    const spaceIdx = args.indexOf(" ");
    if (spaceIdx === -1) malformed();
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

function parseSessionWindowChanged(args: string): TmuxMessage {
  const parts = args.split(" ");
  if (parts.length < 2) malformed();
  return {
    type: "session-window-changed",
    sessionId: parseSessionId(parts[0]),
    windowId: parseWindowId(parts[1]),
  };
}

function parseClientSessionChanged(args: string): TmuxMessage {
  const spaceIdx = args.indexOf(" ");
  if (spaceIdx === -1) malformed();
  const rest = args.slice(spaceIdx + 1);
  const spaceIdx2 = rest.indexOf(" ");
  if (spaceIdx2 === -1) malformed();
  return {
    type: "client-session-changed",
    clientName: args.slice(0, spaceIdx),
    sessionId: parseSessionId(rest.slice(0, spaceIdx2)),
    name: rest.slice(spaceIdx2 + 1),
  };
}

function parseClientDetached(args: string): TmuxMessage {
  const clientName = args.split(" ")[0];
  if (!clientName) malformed();
  return { type: "client-detached", clientName };
}

function parseNameOnly(
  type: "paste-buffer-changed" | "paste-buffer-deleted",
): LineParseFn {
  return (args: string): TmuxMessage => {
    const name = args.split(" ")[0];
    if (!name) malformed();
    return { type, name } as TmuxMessage;
  };
}

function parseSubscriptionChanged(args: string): TmuxMessage {
  // Format: <name> <session-id> <window-id> <window-index> <pane-id> [reserved...] : <value>
  const colonIdx = args.indexOf(" : ");
  if (colonIdx === -1) malformed();
  const head = args.slice(0, colonIdx);
  const value = args.slice(colonIdx + 3);
  const parts = head.split(" ");
  if (parts.length < 5) malformed();
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

/**
 * Every SPEC §23 server→client wire type the parser recognises, derived from
 * the one dispatch table above. This is the runtime enumeration of the §23
 * catalogue — the conformance gate reconciles it against SPEC.md §23 and its
 * own coverage table so the doc, the parser, and the tests cannot drift apart.
 *
 * [LAW:one-source-of-truth] Adding a `%name` to `PARSERS` adds it here with no
 * second edit; there is no hand-maintained parallel list to fall out of sync.
 */
export const WIRE_MESSAGE_TYPES: ReadonlySet<string> = new Set(PARSERS.keys());

// [LAW:types-are-the-program] Where the stream stands: between response
// blocks, inside the block a %begin opened, or past a %begin the parser could
// not read. That block's lines cannot be tied to a command, nor told apart
// from what follows it, so synchronization is lost until `reset()`.
type StreamPosition =
  | { readonly at: "between-blocks" }
  | { readonly at: "in-block"; readonly commandNumber: number }
  | { readonly at: "lost-sync" };

const BETWEEN_BLOCKS: StreamPosition = { at: "between-blocks" };
const LOST_SYNC: StreamPosition = { at: "lost-sync" };

// What `tmux -CC` writes before any protocol output (SPEC.md §12).
const DCS_INTRODUCER = "\x1bP1000p";

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
 * Response block tracking: every non-terminator line that arrives while a
 * `%begin` is active — regardless of leading byte — is a command output line
 * (see SPEC_MANIFEST §4 Invariant 4.1, Block Purity). These are forwarded via
 * the optional `onOutputLine` callback with the associated command number,
 * allowing the client layer to aggregate them into `CommandResponse` objects.
 */
export class TmuxParser {
  // [LAW:single-enforcer] Response-block state is tracked exclusively here.
  private readonly emit: (msg: TmuxMessage) => void;
  private readonly reportProtocolError: (error: ProtocolErrorMessage) => void;
  private buffer = "";
  private position: StreamPosition = BETWEEN_BLOCKS;

  /**
   * Optional callback for command output lines — every non-terminator line
   * that arrives between %begin and %end/%error, including ones that happen
   * to begin with %. The client layer sets this to aggregate output into
   * CommandResponse objects.
   */
  onOutputLine: ((commandNumber: number, line: string) => void) | null = null;

  /**
   * Optional callback for a non-`%` line outside any response block, its
   * trailing `\r` run stripped. tmux writes one in place of a guard block
   * when it cannot parse the command it was started with (`command
   * attach-session: unknown flag -Z`), and after a block for what
   * `run-shell` printed; the two look the same here, so the receiver tells
   * them apart by when the line came.
   */
  onUnguardedLine: ((line: string) => void) | null = null;

  /**
   * `onProtocolError` receives every line of a known `%` type that the parser
   * cannot read, its `kind` saying what the line was (see
   * `ProtocolErrorMessage`). Distinct from `onMessage` because this is not a
   * `TmuxMessage` — see `ProtocolErrorMessage`'s doc for why.
   * [LAW:types-are-the-program] Required, not an optional field like the
   * others: after a `begin` report the parser reads no further line, so a
   * parser that could not hear it would fall silent with no signal.
   */
  constructor(
    onMessage: (msg: TmuxMessage) => void,
    onProtocolError: (error: ProtocolErrorMessage) => void,
  ) {
    this.emit = onMessage;
    this.reportProtocolError = onProtocolError;
  }

  /**
   * Push a chunk of data into the parser. The chunk may contain zero, one,
   * or many complete lines, and may end mid-line. The parser buffers partial
   * lines and processes complete ones immediately.
   *
   * CRLF tolerance: this parser sits on tmux's *output* side, the opposite of
   * the input side tmux itself reads with `EVBUFFER_EOL_LF` (LF-terminated, no
   * CR stripping). `feed()` itself only splits on `\n` and hands the raw line
   * (any trailing `\r` run still attached) to `processLine()` — see that
   * method's doc comment for why the `\r`-handling decision lives there
   * instead of here, as a single point rather than two independently-derived
   * ones. [LAW:single-enforcer]
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

  /**
   * Reset all internal state: the line buffer and the stream position,
   * including a lost synchronization (see `ProtocolErrorMessage`'s `begin`).
   */
  reset(): void {
    this.buffer = "";
    this.position = BETWEEN_BLOCKS;
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  /**
   * `line` is exactly what arrived between two `\n`s — any trailing `\r` run
   * a CRLF transport left on it is still attached. [LAW:single-enforcer]:
   * this is the one place that decides what a trailing `\r` means, rather
   * than feed() pre-judging it before classification exists.
   *
   * SPEC_MANIFEST §4 Invariant 4.1 (Block Purity): tmux never interleaves an
   * asynchronous notification into a response block. Between %begin and
   * %end/%error, every line is either the block terminator itself or command
   * output produced by the running command — even if that output happens to
   * begin with `%`, e.g. `%5` from `list-panes -F '#{pane_id}'`. The parser
   * routes by position (in-block + not-terminator → output), not by content.
   *
   * Classification (is this a notification? which type? is it the block
   * terminator?) always uses `cleanLine`, with any trailing `\r` run
   * stripped — those fields are fixed protocol tokens or tmux-generated
   * numeric values, never user data, so a trailing `\r` there is always
   * transport noise. This also fixes a real wedge: a malformed, space-less
   * terminator (`%end\r`, or `%end\r\r` from a doubled-up CRLF) must still
   * compare equal to `"end"`, or the malformed-guard-terminator recovery
   * below never fires, the block never closes, and every line
   * for the rest of the connection — notifications included — misroutes as
   * output for a command that will never settle.
   *
   * The output *payload* forwarded via `onOutputLine` and the line surfaced
   * to `onProtocolError` both use the raw, un-stripped `line` instead:
   * SPEC.md §5.4 documents response-block output (e.g. `capture-pane -p`) as
   * delivered via `control_write()`, a path with no octal-escaping guarantee
   * (SPEC.md §10 is scoped to %output/%extended-output only), so a captured
   * row may legitimately end in a real `\r` byte right before the block's
   * terminating `\n`. Stripping it there would silently corrupt
   * `CommandResponse.output`'s documented raw-byte-fidelity guarantee — one
   * byte pipe, no lossy decode, even for the line that happened to also be
   * the (malformed) terminator.
   *
   * The one thing dropped from `raw` first: the DCS introducer `-CC` writes
   * in front of its first line (SPEC.md §12), which would otherwise hide that
   * line's `%`. It is dropped from any line outside a response block, not
   * only the stream's first: a PTY can deliver a login banner before it.
   */
  private processLine(raw: string): void {
    const position = this.position;
    // [LAW:no-silent-failure] The 'begin' report that lost synchronization
    // already said every later line is unreadable; none is guessed at.
    if (position.at === "lost-sync") return;
    const inResponseBlock = position.at === "in-block";
    const line =
      !inResponseBlock && raw.startsWith(DCS_INTRODUCER)
        ? raw.slice(DCS_INTRODUCER.length)
        : raw;
    let cleanEnd = line.length;
    while (cleanEnd > 0 && line.charCodeAt(cleanEnd - 1) === 0x0d) cleanEnd--;
    const cleanLine = cleanEnd === line.length ? line : line.slice(0, cleanEnd);

    const isNotification = cleanLine.charCodeAt(0) === 0x25; // '%'

    // Extract the notification type up front so the response-block routing
    // decision below can be data-driven rather than a nested branch tree.
    const spaceIdx = isNotification ? cleanLine.indexOf(" ", 1) : -1;
    const typeStr = !isNotification
      ? ""
      : spaceIdx === -1
        ? cleanLine.slice(1)
        : cleanLine.slice(1, spaceIdx);
    const argsStr =
      !isNotification || spaceIdx === -1 ? "" : cleanLine.slice(spaceIdx + 1);

    // Treating in-block `%5`-style lines as unknown notifications was the
    // bug the example used to paper over with an `id=` prefix; the parser
    // now follows the spec invariant directly.
    const isBlockTerminator = typeStr === "end" || typeStr === "error";
    const treatAsOutput = inResponseBlock && !isBlockTerminator;

    // [LAW:dataflow-not-control-flow] Output routing is determined by the
    // (inResponseBlock, isBlockTerminator) tuple — the same `processLine`
    // operation runs every call; only the data decides which side effect.
    if (treatAsOutput) {
      // Command-response lines pass through raw (Latin-1 byte-faithful). The
      // library never re-interprets bytes as UTF-8 — capture-pane content is
      // terminal data the renderer decodes, and other command output (list-*,
      // display-message) is ASCII or consumer-decoded. One byte pipe, no lossy
      // decode.
      this.onOutputLine?.(position.commandNumber, line);
      return;
    }

    // Outside a response block, a non-% line is no protocol message.
    if (!isNotification) {
      this.onUnguardedLine?.(cleanLine);
      return;
    }

    const parser = PARSERS.get(typeStr);
    if (parser === undefined) {
      // Unknown notification type — skip silently. The protocol may evolve
      // and we must not crash on unrecognized messages. (Cannot reach this
      // branch inside a response block — `treatAsOutput` already routed.)
      return;
    }

    let msg: TmuxMessage;
    try {
      msg = parser(argsStr);
    } catch (err) {
      if (!(err instanceof MalformedLine)) throw err;
      // [LAW:no-silent-failure] Every unreadable known-type line is reported.
      // One that was positionally the open block's terminator must not leave
      // the block open — that is the wedge (see this method's doc comment on
      // malformed-guard-terminator tolerance) — so the block closes first. A
      // %begin here is never inside a block: there it is output.
      const [report, next]: readonly [ProtocolErrorMessage, StreamPosition] =
        inResponseBlock && isBlockTerminator
          ? [
              {
                type: "protocol-error",
                kind: "terminator",
                commandNumber: position.commandNumber,
                line,
              },
              BETWEEN_BLOCKS,
            ]
          : typeStr === "begin"
            ? [{ type: "protocol-error", kind: "begin", line }, LOST_SYNC]
            : [{ type: "protocol-error", kind: "line", line }, position];
      this.position = next;
      this.reportProtocolError(report);
      return;
    }

    // Update the stream position.
    // [LAW:single-enforcer] Begin/end/error state transitions happen here only.
    if (msg.type === "begin") {
      this.position = { at: "in-block", commandNumber: msg.commandNumber };
    } else if (msg.type === "end" || msg.type === "error") {
      this.position = BETWEEN_BLOCKS;
    }

    this.emit(msg);
  }
}
