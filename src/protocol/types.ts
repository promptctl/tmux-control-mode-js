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

export interface OutputMessage {
  readonly type: "output";
  readonly paneId: number;
  readonly data: Uint8Array;
}

export interface ExtendedOutputMessage {
  readonly type: "extended-output";
  readonly paneId: number;
  readonly age: number;
  readonly data: Uint8Array;
}

/**
 * Receipt type produced by `asPaneOutput`. A `PaneOutputMessage` is *exactly*
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
// Discriminated Union — all 28 server-to-client message types
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
  readonly output: readonly string[];
  readonly success: boolean;
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
 * drift between sites. As a TypeScript predicate it also narrows the
 * **else** branch to `Exclude<TmuxMessage, PaneOutputMessage>`, which is
 * what the WS server's onTmuxEvent needs to feed into the JSON-event path.
 */
export function isPaneOutput(msg: TmuxMessage): msg is PaneOutputMessage {
  return msg.type === "output" || msg.type === "extended-output";
}

/**
 * Receipt-style sibling of `isPaneOutput`. Returns the same value typed as
 * `PaneOutputMessage` when the discriminator matches, or `null` otherwise.
 * Use this when the consumer's natural shape is `out === null ? skip : use`
 * (e.g. ack accounting); use `isPaneOutput` when you also need the
 * else-branch narrowing.
 */
export function asPaneOutput(msg: TmuxMessage): PaneOutputMessage | null {
  return isPaneOutput(msg) ? msg : null;
}
