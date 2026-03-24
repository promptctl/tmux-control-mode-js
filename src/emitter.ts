// src/emitter.ts
// Minimal typed event emitter for TmuxClient.
// No Node.js dependencies — works in any JS environment.

// [LAW:one-source-of-truth] TmuxEventMap is derived from the TmuxMessage union.
// [LAW:one-type-per-behavior] Single emitter type parameterized by the event map.

import type {
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
} from "./protocol/types.js";

/**
 * Maps each tmux notification type string to its corresponding message interface.
 * Finite and known at compile time — gives autocomplete on event names and
 * type-safe handler argument types.
 */
export interface TmuxEventMap {
  begin: BeginMessage;
  end: EndMessage;
  error: ErrorMessage;
  output: OutputMessage;
  "extended-output": ExtendedOutputMessage;
  pause: PauseMessage;
  continue: ContinueMessage;
  "pane-mode-changed": PaneModeChangedMessage;
  "window-add": WindowAddMessage;
  "window-close": WindowCloseMessage;
  "window-renamed": WindowRenamedMessage;
  "window-pane-changed": WindowPaneChangedMessage;
  "unlinked-window-add": UnlinkedWindowAddMessage;
  "unlinked-window-close": UnlinkedWindowCloseMessage;
  "unlinked-window-renamed": UnlinkedWindowRenamedMessage;
  "layout-change": LayoutChangeMessage;
  "session-changed": SessionChangedMessage;
  "session-renamed": SessionRenamedMessage;
  "sessions-changed": SessionsChangedMessage;
  "session-window-changed": SessionWindowChangedMessage;
  "client-session-changed": ClientSessionChangedMessage;
  "client-detached": ClientDetachedMessage;
  "paste-buffer-changed": PasteBufferChangedMessage;
  "paste-buffer-deleted": PasteBufferDeletedMessage;
  "subscription-changed": SubscriptionChangedMessage;
  message: MessageMessage;
  "config-error": ConfigErrorMessage;
  exit: ExitMessage;
}

// Internal handler type — erases the event payload for storage.
// Public API preserves full type safety via overloads.
type AnyHandler = (event: never) => void;

/**
 * Minimal typed event emitter. NOT Node.js EventEmitter.
 *
 * Type-safe: `on("window-add", handler)` gives autocomplete on event names
 * and infers the handler argument type. Wildcard `"*"` listeners receive
 * all events as the `TmuxMessage` union.
 */
export class TypedEmitter {
  private readonly handlers = new Map<string, Set<AnyHandler>>();
  private readonly wildcardHandlers = new Set<AnyHandler>();

  on<K extends keyof TmuxEventMap>(
    event: K,
    handler: (event: TmuxEventMap[K]) => void,
  ): void;
  on(event: "*", handler: (event: TmuxMessage) => void): void;
  on(event: string, handler: AnyHandler): void {
    if (event === "*") {
      this.wildcardHandlers.add(handler);
      return;
    }
    let set = this.handlers.get(event);
    if (set === undefined) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler);
  }

  off<K extends keyof TmuxEventMap>(
    event: K,
    handler: (event: TmuxEventMap[K]) => void,
  ): void;
  off(event: "*", handler: (event: TmuxMessage) => void): void;
  off(event: string, handler: AnyHandler): void {
    if (event === "*") {
      this.wildcardHandlers.delete(handler);
      return;
    }
    const set = this.handlers.get(event);
    if (set === undefined) return;
    set.delete(handler);
    if (set.size === 0) {
      this.handlers.delete(event);
    }
  }

  emit(event: TmuxMessage): void {
    const set = this.handlers.get(event.type);
    if (set !== undefined) {
      for (const handler of set) {
        (handler as (event: TmuxMessage) => void)(event);
      }
    }
    for (const handler of this.wildcardHandlers) {
      (handler as (event: TmuxMessage) => void)(event);
    }
  }
}
