// src/protocol/types.ts
// Pure TypeScript types for tmux control mode server-to-client messages.
// No runtime dependencies. Works in browser, Deno, Bun, Node.

// ---------------------------------------------------------------------------
// Guards (command response framing)
// ---------------------------------------------------------------------------

/**
 * `flags` on the three guards of a block for a command of a line this client
 * wrote on its stdin. Every other block tmux writes to the client carries 0:
 * the commands of the command line tmux was started with, of a hook a command
 * set off, of an `if-shell -b` or `run-shell -b -C` (SPEC.md §5.5). Same in
 * tmux 3.2 and later:
 * `cmd-queue.c` `cmdq_fire_command` writes whether the command's state has
 * `CMDQ_STATE_CONTROL`, which only `control.c` `control_read_callback` sets.
 */
export const CONTROL_FLAGS = 1;

export interface BeginMessage {
  readonly type: "begin";
  readonly timestamp: number;
  readonly commandNumber: number;
  readonly flags: number;
}

export interface EndMessage {
  readonly type: "end";
  readonly timestamp: number;
  readonly commandNumber: number;
  readonly flags: number;
}

export interface ErrorMessage {
  readonly type: "error";
  readonly timestamp: number;
  readonly commandNumber: number;
  readonly flags: number;
}

// ---------------------------------------------------------------------------
// Pane Output
// ---------------------------------------------------------------------------

/**
 * Parsed `%output` notification. The `data` field is a `Uint8Array` carrying
 * the *decoded* bytes — not the raw octal-escaped wire string tmux emits. The
 * library decodes (and tolerates transport noise: literal control bytes,
 * mid-escape `\r`, malformed escapes) on the way through `decodeOctalEscapes`,
 * so consumers receive ready-to-render bytes.
 */
export interface OutputMessage {
  readonly type: "output";
  readonly paneId: number;
  readonly data: Uint8Array;
}

/**
 * Parsed `%extended-output` notification (sent instead of `%output` when the
 * `pause-after` flag is set; `age` is the milliseconds tmux buffered the output
 * before sending). `data` carries decoded bytes under the same contract as
 * {@link OutputMessage.data}.
 */
export interface ExtendedOutputMessage {
  readonly type: "extended-output";
  readonly paneId: number;
  readonly age: number;
  readonly data: Uint8Array;
}

/**
 * The type `isPaneOutput` narrows to. A `PaneOutputMessage` is *exactly*
 * a TmuxMessage whose discriminator says it carries pane bytes + a paneId;
 * the type system makes it impossible to construct one with any other shape.
 *
 * [LAW:one-source-of-truth] This is the canonical pane-output type. Connector
 * layers (electron, websocket) re-export it but never re-declare it — see
 * `src/connectors/websocket/protocol.ts`.
 */
export type PaneOutputMessage = OutputMessage | ExtendedOutputMessage;

// ---------------------------------------------------------------------------
// Pane Flow Control
// ---------------------------------------------------------------------------

export interface PauseMessage {
  readonly type: "pause";
  readonly paneId: number;
}

export interface ContinueMessage {
  readonly type: "continue";
  readonly paneId: number;
}

// ---------------------------------------------------------------------------
// Pane Mode
// ---------------------------------------------------------------------------

export interface PaneModeChangedMessage {
  readonly type: "pane-mode-changed";
  readonly paneId: number;
}

// ---------------------------------------------------------------------------
// Window Events
// ---------------------------------------------------------------------------

export interface WindowAddMessage {
  readonly type: "window-add";
  readonly windowId: number;
}

export interface WindowCloseMessage {
  readonly type: "window-close";
  readonly windowId: number;
}

export interface WindowRenamedMessage {
  readonly type: "window-renamed";
  readonly windowId: number;
  readonly name: string;
}

export interface WindowPaneChangedMessage {
  readonly type: "window-pane-changed";
  readonly windowId: number;
  readonly paneId: number;
}

export interface UnlinkedWindowAddMessage {
  readonly type: "unlinked-window-add";
  readonly windowId: number;
}

export interface UnlinkedWindowCloseMessage {
  readonly type: "unlinked-window-close";
  readonly windowId: number;
}

export interface UnlinkedWindowRenamedMessage {
  readonly type: "unlinked-window-renamed";
  readonly windowId: number;
  readonly name: string;
}

// ---------------------------------------------------------------------------
// Layout Events
// ---------------------------------------------------------------------------

/** One pane's cell in a window layout, in character cells. */
export interface PaneGeometry {
  readonly paneId: number;
  readonly width: number;
  readonly height: number;
  readonly x: number;
  readonly y: number;
}

/**
 * A layout string parsed into pane geometry: every tiled pane, in layout
 * order — or, when the string breaks tmux's layout grammar or checksum, the
 * reason. Floating panes (tmux 3.8+) are not in the layout string, so a
 * window of only floating panes parses to an empty list.
 */
export type WindowLayout =
  | { readonly kind: "parsed"; readonly panes: readonly PaneGeometry[] }
  | { readonly kind: "malformed"; readonly reason: string };

/**
 * A window's layout as tmux reports it, shared by every message that carries
 * one. Build it with `windowLayoutFields` (protocol/layout.ts).
 */
export interface WindowLayoutFields {
  /** Raw `#{window_layout}`: every tiled pane, at its pre-zoom size when zoomed. */
  readonly windowLayout: string;
  /** Raw `#{window_visible_layout}`: only the zoomed pane when zoomed. */
  readonly windowVisibleLayout: string;
  readonly windowFlags: string;
  // [LAW:one-source-of-truth] Derived from the raw strings above by
  // `windowLayoutFields` only; serializers emit the raw strings.
  readonly layout: WindowLayout;
  readonly visibleLayout: WindowLayout;
}

export interface LayoutChangeMessage extends WindowLayoutFields {
  readonly type: "layout-change";
  readonly windowId: number;
}

// ---------------------------------------------------------------------------
// Session Events
// ---------------------------------------------------------------------------

export interface SessionChangedMessage {
  readonly type: "session-changed";
  readonly sessionId: number;
  readonly name: string;
}

export interface SessionRenamedMessage {
  readonly type: "session-renamed";
  readonly sessionId: number;
  readonly name: string;
}

export interface SessionsChangedMessage {
  readonly type: "sessions-changed";
}

export interface SessionWindowChangedMessage {
  readonly type: "session-window-changed";
  readonly sessionId: number;
  readonly windowId: number;
}

// ---------------------------------------------------------------------------
// Client Events
// ---------------------------------------------------------------------------

export interface ClientSessionChangedMessage {
  readonly type: "client-session-changed";
  readonly clientName: string;
  readonly sessionId: number;
  readonly name: string;
}

export interface ClientDetachedMessage {
  readonly type: "client-detached";
  readonly clientName: string;
}

// ---------------------------------------------------------------------------
// Paste Buffer Events
// ---------------------------------------------------------------------------

export interface PasteBufferChangedMessage {
  readonly type: "paste-buffer-changed";
  readonly name: string;
}

export interface PasteBufferDeletedMessage {
  readonly type: "paste-buffer-deleted";
  readonly name: string;
}

// ---------------------------------------------------------------------------
// Subscription Events
// ---------------------------------------------------------------------------

export interface SubscriptionChangedMessage {
  readonly type: "subscription-changed";
  readonly name: string;
  /** Raw integer from protocol. -1 when not applicable (wire format: "-"). */
  readonly sessionId: number;
  /** Raw integer from protocol. -1 when not applicable (wire format: "-"). */
  readonly windowId: number;
  /** Raw integer from protocol. -1 when not applicable (wire format: "-"). */
  readonly windowIndex: number;
  /** Raw integer from protocol. -1 when not applicable (wire format: "-"). */
  readonly paneId: number;
  readonly value: string;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export interface MessageMessage {
  readonly type: "message";
  readonly message: string;
}

// ---------------------------------------------------------------------------
// Config Errors
// ---------------------------------------------------------------------------

export interface ConfigErrorMessage {
  readonly type: "config-error";
  readonly error: string;
}

// ---------------------------------------------------------------------------
// Exit
// ---------------------------------------------------------------------------

export interface ExitMessage {
  readonly type: "exit";
  readonly reason?: string;
}

// ---------------------------------------------------------------------------
// Protocol errors (parser-synthesized, not sent by tmux)
// ---------------------------------------------------------------------------

/**
 * Synthesized by `TmuxParser` for a line of a known `%` type that it cannot
 * read: too few fields (SPEC.md §5), or a number field that is not an
 * unsigned decimal integer. `kind` says what the line was, which decides what
 * the parse failure costs:
 *
 * - `terminator` — the `%end`/`%error` of the open response block. The parser
 *   closes the block anyway, and `TmuxClient` rejects the command it answered
 *   with `TmuxProtocolError` (errors.ts).
 * - `begin` — a `%begin`. Its flags say whose block it opens (a caller's
 *   command or a reply no caller sent), so once they cannot be read no reply
 *   can be matched to its command. The parser loses synchronization and
 *   reads no further line until `reset()`; `TmuxClient` ends the connection.
 * - `line` — any other line: a notification, or a terminator outside any
 *   block. It is dropped.
 *
 * tmux never sends this message, and unlike every `TmuxMessage` variant it
 * cannot round-trip through a standalone `serializeMessage`/parse cycle —
 * whether a terminator closes a block depends on parser state, not on the
 * line alone. That is why it is deliberately NOT a member of the `TmuxMessage`
 * union: that union's contract (see `serializer.ts`, `conformance/samples.ts`)
 * is "real wire message, reproducible from one line," which this is not. It
 * is delivered via `TmuxParser.onProtocolError` and joins the emitter's
 * synthetic arm (`EmitterMessage`) the same way `ConnectionStateMessage` does.
 *
 * [LAW:types-are-the-program] Only a `terminator` carries a command number:
 * it is the one kind whose block was open, with its owner in flight.
 */
export type ProtocolErrorMessage =
  | {
      readonly type: "protocol-error";
      readonly kind: "terminator";
      /** The command number of the block that was force-closed. */
      readonly commandNumber: number;
      /** The unreadable line, verbatim. */
      readonly line: string;
    }
  | {
      readonly type: "protocol-error";
      readonly kind: "begin" | "line";
      /** The unreadable line, verbatim. */
      readonly line: string;
    };

// ---------------------------------------------------------------------------
// Discriminated Union — every server-to-client message type
// ---------------------------------------------------------------------------

// [LAW:one-source-of-truth] Single union is the authoritative set of message types.
export type TmuxMessage =
  | BeginMessage
  | EndMessage
  | ErrorMessage
  | OutputMessage
  | ExtendedOutputMessage
  | PauseMessage
  | ContinueMessage
  | PaneModeChangedMessage
  | WindowAddMessage
  | WindowCloseMessage
  | WindowRenamedMessage
  | WindowPaneChangedMessage
  | UnlinkedWindowAddMessage
  | UnlinkedWindowCloseMessage
  | UnlinkedWindowRenamedMessage
  | LayoutChangeMessage
  | SessionChangedMessage
  | SessionRenamedMessage
  | SessionsChangedMessage
  | SessionWindowChangedMessage
  | ClientSessionChangedMessage
  | ClientDetachedMessage
  | PasteBufferChangedMessage
  | PasteBufferDeletedMessage
  | SubscriptionChangedMessage
  | MessageMessage
  | ConfigErrorMessage
  | ExitMessage;

// ---------------------------------------------------------------------------
// Supporting types
// ---------------------------------------------------------------------------

export interface CommandResponse {
  readonly commandNumber: number;
  readonly timestamp: number;
  /**
   * Lines between the `%begin` and `%end`/`%error` guard pair.
   *
   * **Encoding:** Each string is a latin1-container byte-faithful string:
   * byte-containers, not decoded Unicode. ASCII-only output is transparent;
   * non-ASCII output (window names, session names, paths) requires explicit
   * decode:
   *
   * ```ts
   * import { latin1ToBytes } from "@promptctl/tmux-control-mode-js";
   * const text = new TextDecoder().decode(latin1ToBytes(response.output[0]));
   * ```
   *
   * **CRLF transports:** `TmuxParser.feed()` does not strip a trailing `\r`
   * from response-block lines (needed so a `capture-pane -p` row's real
   * trailing `\r` survives) — so on a transport that introduces CRLF, *any*
   * command's last output line, not just `capture-pane`'s, may carry one.
   * Exact-match comparisons against a single-line, non-tab-delimited reply
   * should account for this (e.g. `response.output[0].replace(/\r$/, "")`).
   */
  readonly output: readonly string[];
  readonly success: boolean;
}

/**
 * tmux's reply to a command this client did not write (a block whose guards
 * do not carry {@link CONTROL_FLAGS}), one event per command: the command
 * line tmux was started with, a hook a command set off, an `if-shell -b` or
 * `run-shell -b -C`. `TmuxClient` builds it from the whole block, so like
 * {@link ProtocolErrorMessage} it is not a `TmuxMessage`.
 *
 * A failed one (`response.success` false) does not by itself end the
 * connection. When the first command tmux was started with fails, its text is
 * also the `exit` event's `reason`. Any other failure appears in this event
 * only: a hook's, or a later startup command's, whether the connection lives
 * on or tmux then exits a client that list left unattached.
 */
export interface UnsolicitedResponseMessage {
  readonly type: "unsolicited-response";
  readonly response: CommandResponse;
}

/**
 * One window from `listWindows()` — a structured record so consumers never
 * parse `-F` output themselves (the forbidden path a raw `CommandResponse`
 * would otherwise force). `sessionName`/`windowName` are already decoded to
 * real Unicode text; the latin1-container boundary stops at the parser that
 * builds this record.
 */
export interface WindowRecord {
  readonly sessionId: number;
  readonly sessionName: string;
  readonly windowId: number;
  readonly windowName: string;
  readonly width: number;
  readonly height: number;
}

/**
 * One pane from `listPanes()` — a structured record, decoded the same way as
 * {@link WindowRecord}. `cwd`, `startCommand`, `currentCommand` are already
 * decoded to real Unicode text.
 */
export interface PaneRecord {
  readonly sessionId: number;
  readonly sessionName: string;
  readonly windowId: number;
  readonly windowName: string;
  readonly paneId: number;
  readonly cwd: string;
  readonly pid: number;
  readonly startCommand: string;
  readonly currentCommand: string;
  readonly width: number;
  readonly height: number;
}

/**
 * One session from `listSessions()` — a structured record, decoded the same
 * way as {@link WindowRecord}/{@link PaneRecord}. `sessionName` is already
 * decoded to real Unicode text. `attached` is derived from
 * `#{session_attached}`, tmux's count of attached clients, not a flag — any
 * non-zero count is "attached".
 */
export interface SessionRecord {
  readonly sessionId: number;
  readonly sessionName: string;
  readonly windowCount: number;
  readonly attached: boolean;
}

/**
 * One pane's full history from `capturePane()` — `capture-pane -p -e -J -S -`
 * for one pane. `bytes` are the raw captured bytes (escape sequences
 * included, soft-wrapped lines rejoined, lines separated by `\n`) — the
 * same latin1-container boundary as {@link CommandResponse.output}, already
 * unwrapped via `latin1ToBytes`. A caller that needs text decodes further,
 * e.g. `new TextDecoder().decode(bytes)`.
 *
 * `lineCount` is the authoritative captured-line count (tmux's own
 * `response.output.length`), not a value re-derivable from `bytes`: a
 * zero-line capture joins to an empty byte string, and decoding and
 * splitting that on `"\n"` yields one empty line, not zero — so `lineCount`
 * and "lines in `bytes`" agree for every non-empty capture but diverge at
 * the empty one. `bytes` is a join of the same lines `lineCount` counts,
 * not an independent value.
 */
export interface PaneCapture {
  readonly bytes: Uint8Array;
  readonly lineCount: number;
}

/**
 * The window and pane `newWindow()` or `newEmptyWindow()` created: `@N` and
 * `%N` as numbers, the
 * same id form {@link PaneRecord} and `capturePane(paneId)` use, so the
 * result feeds straight into them.
 */
export interface NewWindowResult {
  readonly windowId: number;
  readonly paneId: number;
}

// [LAW:one-source-of-truth] The canonical synthetic response for any operation
// that resolves without issuing a correlated tmux command: an empty `sendKeys`
// input, or a bridge refcounted no-op (a subscribe/unsubscribe that only bumps
// a refcount and never reaches tmux). commandNumber -1 marks "no command was
// correlated" — there is no FIFO entry because nothing was sent. Every such
// path builds its response here rather than minting its own.
export function emptyKeysResponse(): CommandResponse {
  return {
    commandNumber: -1,
    timestamp: Date.now(),
    output: [],
    success: true,
  };
}

// [LAW:one-type-per-behavior] Single enum for all pane actions — instances differ by value, not type.
export enum PaneAction {
  On = "on",
  Off = "off",
  Continue = "continue",
  Pause = "pause",
}

/**
 * Type predicate for pane-output messages.
 *
 * [LAW:single-enforcer] The discriminator literal "output"|"extended-output"
 * appears in this file ONLY. Every connector consumer (electron main /
 * renderer / WS server) routes the question through here so the test cannot
 * drift between sites.
 *
 * The generic parameter preserves the caller's input type so the else
 * branch narrows correctly for any union containing `PaneOutputMessage`:
 *   - `TmuxMessage` input → else is `EmitterTmuxMessage` (emitter accepts it)
 *   - `EmitterMessage | PaneOutputMessage` input (the IPC wire boundary)
 *     → else is `EmitterMessage`
 *
 * The return type uses `Extract<M, PaneOutputMessage>` rather than
 * `M & PaneOutputMessage` so the predicate is sound: a caller passing a
 * union that does NOT contain `PaneOutputMessage` (e.g. `EmitterMessage`,
 * or an object literal `{ type: "output" }` that is structurally
 * incompatible with the real message shape) narrows to `never` in the
 * true branch. That correctly reports the if-branch as unreachable
 * instead of fabricating a `PaneOutputMessage` from a value that does
 * not carry `paneId`/`data`.
 */
export function isPaneOutput<M extends { readonly type: string }>(
  msg: M,
): msg is Extract<M, PaneOutputMessage> {
  return msg.type === "output" || msg.type === "extended-output";
}
