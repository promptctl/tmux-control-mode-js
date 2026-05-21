// src/emitter.ts
// Minimal typed event emitter for TmuxClient.
// No Node.js dependencies — works in any JS environment.

// [LAW:one-source-of-truth] TmuxEventMap's wire events are mechanically derived
// from the TmuxMessage union; its synthetic events come from connection-state.ts.
// [LAW:one-type-per-behavior] Single emitter type parameterized by the event map.

import type { TmuxMessage } from "./protocol/types.js";
import type {
  ConnectionStateMessage,
  ReconnectedMessage,
} from "./connection-state.js";

/**
 * Every event the emitter can carry. `TmuxMessage` (parsed from tmux output)
 * plus the synthetic lifecycle events that client classes synthesize. This is
 * the type seen by `'*'` wildcard listeners.
 *
 * [LAW:one-source-of-truth] Wildcard listeners read this union; per-event
 * listeners read `TmuxEventMap`. Both are derived in this file only.
 */
export type EmitterMessage =
  | TmuxMessage
  | ConnectionStateMessage
  | ReconnectedMessage;

/**
 * Type guard separating parsed tmux messages from synthetic lifecycle events.
 * [LAW:single-enforcer] One discriminator check used by every emitter consumer
 * that needs to skip synthetic events (stream projections, wire forwarding).
 */
export function isTmuxMessage(ev: EmitterMessage): ev is TmuxMessage {
  return ev.type !== "connection-state" && ev.type !== "reconnected";
}

/**
 * Maps each event-type string to its corresponding message variant, giving
 * per-event listeners autocomplete on names and type-safe handler arguments.
 *
 * The wire arm projects `TmuxMessage` by its discriminator — adding a variant
 * in `protocol/types.ts` produces the right entry here with no second edit.
 * The synthetic arm names the lifecycle events that client classes emit but
 * tmux never sends; their shapes live in `connection-state.ts`, so they cannot
 * be derived from the wire union.
 *
 * [LAW:one-source-of-truth] Each arm derives from its own single source: the
 * wire union for parsed events, `connection-state.ts` for synthetic ones. The
 * split is visible here rather than hidden, mirroring `EmitterMessage`.
 */
export type TmuxEventMap = {
  [M in TmuxMessage as M["type"]]: M;
} & {
  "connection-state": ConnectionStateMessage;
  reconnected: ReconnectedMessage;
};

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
  on(event: "*", handler: (event: EmitterMessage) => void): void;
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
  off(event: "*", handler: (event: EmitterMessage) => void): void;
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

  emit(event: EmitterMessage): void {
    const set = this.handlers.get(event.type);
    if (set !== undefined) {
      for (const handler of set) {
        (handler as (event: EmitterMessage) => void)(event);
      }
    }
    for (const handler of this.wildcardHandlers) {
      (handler as (event: EmitterMessage) => void)(event);
    }
  }
}
