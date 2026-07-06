// src/protocol/types.ts
// Pure TypeScript types for tmux control mode server-to-client messages.
// No runtime dependencies. Works in browser, Deno, Bun, Node.

// ---------------------------------------------------------------------------
// Guards (command response framing)
// ---------------------------------------------------------------------------

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

export interface LayoutChangeMessage {
  readonly type: "layout-change";
  readonly windowId: number;
  readonly windowLayout: string;
  readonly windowVisibleLayout: string;
  readonly windowFlags: string;
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
 * Synthesized by `TmuxParser` when a `%end`/`%error` guard terminator fails
 * to parse (fewer than the three required fields — SPEC.md §5) while a
 * response block is open. tmux never sends this message, and unlike every
 * `TmuxMessage` variant it cannot round-trip through a standalone
 * `serializeMessage`/parse cycle — its meaning depends on parser state (a
 * block being open), not on the line's content alone. That is why it is
 * deliberately NOT a member of the `TmuxMessage` union: that union's contract
 * (see `serializer.ts`, `conformance/samples.ts`) is "real wire message,
 * reproducible from one line," which this is not. It is delivered via
 * `TmuxParser.onProtocolError`, a dedicated callback alongside `onOutputLine`,
 * and joins the emitter's synthetic arm (`EmitterMessage`) the same way
 * `ConnectionStateMessage` does. See `TmuxParser`'s class doc for the recovery
 * this signals, and `TmuxProtocolError` (errors.ts) for the client-side
 * rejection it produces.
 */
export interface ProtocolErrorMessage {
  readonly type: "protocol-error";
  /** The command number of the block that was force-closed. */
  readonly commandNumber: number;
  /** The malformed terminator line, verbatim. */
  readonly line: string;
}

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
   */
  readonly output: readonly string[];
  readonly success: boolean;
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

/**
 * TmuxMessage discriminants that can appear in serialized event frames.
 * Excludes output/extended-output — those travel as binary frames.
 */
type SerializedEventType = Exclude<
  TmuxMessage["type"],
  "output" | "extended-output"
>;

/**
 * Compile-time exhaustive map of serialized event discriminants. The
 * `satisfies Record<SerializedEventType, true>` clause is the load-bearing
 * check: if a new TmuxMessage variant is added (and it's not output-shaped),
 * TypeScript errors here until it's listed.
 *
 * [LAW:one-source-of-truth] Single map, derivable from the TmuxMessage union.
 * The runtime Set below is just a key projection of this object.
 */
const SERIALIZED_EVENT_TYPE_MAP = {
  begin: true,
  end: true,
  error: true,
  pause: true,
  continue: true,
  "pane-mode-changed": true,
  "window-add": true,
  "window-close": true,
  "window-renamed": true,
  "window-pane-changed": true,
  "unlinked-window-add": true,
  "unlinked-window-close": true,
  "unlinked-window-renamed": true,
  "layout-change": true,
  "session-changed": true,
  "session-renamed": true,
  "sessions-changed": true,
  "session-window-changed": true,
  "client-session-changed": true,
  "client-detached": true,
  "paste-buffer-changed": true,
  "paste-buffer-deleted": true,
  "subscription-changed": true,
  message: true,
  "config-error": true,
  exit: true,
} as const satisfies Record<SerializedEventType, true>;

/**
 * Runtime set used by the WS parseEvent trust boundary to reject unknown
 * event types. Derived from SERIALIZED_EVENT_TYPE_MAP.
 */
export const SERIALIZED_EVENT_TYPES: ReadonlySet<string> = new Set(
  Object.keys(SERIALIZED_EVENT_TYPE_MAP),
);
