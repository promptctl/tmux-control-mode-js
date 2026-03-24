// src/protocol/index.ts
// Barrel export for the protocol layer.
// Zero Node.js dependencies — operates on strings and Uint8Array only.
// Usable in browser, Deno, Bun, Node.

// [LAW:one-source-of-truth] Re-exports only; no logic lives here.

export type {
  BeginMessage,
  EndMessage,
  ErrorMessage,
  OutputMessage,
  ExtendedOutputMessage,
  PauseMessage,
  ContinueMessage,
  PaneModeChangedMessage,
  WindowAddMessage,
  WindowCloseMessage,
  WindowRenamedMessage,
  WindowPaneChangedMessage,
  UnlinkedWindowAddMessage,
  UnlinkedWindowCloseMessage,
  UnlinkedWindowRenamedMessage,
  LayoutChangeMessage,
  SessionChangedMessage,
  SessionRenamedMessage,
  SessionsChangedMessage,
  SessionWindowChangedMessage,
  ClientSessionChangedMessage,
  ClientDetachedMessage,
  PasteBufferChangedMessage,
  PasteBufferDeletedMessage,
  SubscriptionChangedMessage,
  MessageMessage,
  ConfigErrorMessage,
  ExitMessage,
  TmuxMessage,
  CommandResponse,
} from "./types.js";

export { PaneAction } from "./types.js";

export { TmuxParser } from "./parser.js";

export { decodeOctalEscapes } from "./decode.js";

export {
  tmuxEscape,
  buildCommand,
  refreshClientSize,
  refreshClientPaneAction,
  refreshClientSubscribe,
  refreshClientUnsubscribe,
} from "./encoder.js";
