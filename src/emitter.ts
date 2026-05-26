// src/emitter.ts
// Minimal typed event emitter for TmuxClient.
// No Node.js dependencies — works in any JS environment.

// [LAW:types-are-the-program] The strongest true theorem about what the
// emitter carries is "state events, never bytes." Pane bytes flow exclusively
// through PaneSinkRegistry (`attachPaneSink` / `attachAllPanesSink`); they
// are not deliverable through any emitter overload. `EmitterTmuxMessage`
// encodes that constraint by `Exclude`-ing `PaneOutputMessage` from the
// `TmuxMessage` union, and `TypedEmitter.emit`'s parameter is `EmitterMessage`
// so attempting to emit a pane-byte message is a compile error at every
// callsite. The wildcard `'*'` listener's argument type is `EmitterMessage`
// for the same reason — narrowing on `msg.type === 'output'` produces `never`,
// making the consumer's byte-handling branch structurally unreachable.
//
// [LAW:one-source-of-truth] `TmuxEventMap`'s wire arm is mechanically derived
// from `EmitterTmuxMessage`; its synthetic arm comes from connection-state.ts.
// [LAW:one-type-per-behavior] Single emitter type parameterized by the event map.

import type { PaneOutputMessage, TmuxMessage } from "./protocol/types.js";
import type {
  ConnectionStateMessage,
  ReconnectedMessage,
} from "./connection-state.js";

/**
 * The subset of `TmuxMessage` that flows through the emitter. Pane-byte
 * messages (`OutputMessage` / `ExtendedOutputMessage`) are excluded because
 * they belong to the sink channel — see `PaneSinkRegistry` in
 * `src/pane-sink.ts` and `TmuxClient.attachPaneSink` /
 * `TmuxClient.attachAllPanesSink`.
 *
 * [LAW:one-source-of-truth] Derived from `TmuxMessage` via `Exclude`; adding
 * a non-byte variant to `protocol/types.ts` propagates here automatically.
 * The exclusion is the type-level encoding of "bytes are a separate channel"
 * — there is nowhere else this rule lives.
 */
export type EmitterTmuxMessage = Exclude<TmuxMessage, PaneOutputMessage>;

/**
 * Every event the emitter can carry. State-shaped `TmuxMessage` variants
 * (parsed from tmux output) plus the synthetic lifecycle events client
 * classes synthesize. This is the type seen by `'*'` wildcard listeners.
 *
 * [LAW:one-source-of-truth] Wildcard listeners read this union; per-event
 * listeners read `TmuxEventMap`. Both are derived in this file only.
 */
export type EmitterMessage =
  | EmitterTmuxMessage
  | ConnectionStateMessage
  | ReconnectedMessage;

/**
 * Type guard separating parsed tmux messages from synthetic lifecycle events.
 * [LAW:single-enforcer] One discriminator check used by every emitter consumer
 * that needs to skip synthetic events (stream projections, wire forwarding).
 */
export function isTmuxMessage(ev: EmitterMessage): ev is EmitterTmuxMessage {
  return ev.type !== "connection-state" && ev.type !== "reconnected";
}

/**
 * Maps each event-type string to its corresponding message variant, giving
 * per-event listeners autocomplete on names and type-safe handler arguments.
 *
 * The wire arm projects `EmitterTmuxMessage` by its discriminator — adding a
 * non-byte variant in `protocol/types.ts` produces the right entry here with
 * no second edit. Pane-byte variants (`'output'`, `'extended-output'`) are
 * structurally absent because `EmitterTmuxMessage` excludes them; an attempt
 * to write `client.on('output', cb)` is a TS error (the key is not in the
 * map), which is what makes pane-byte misdecode impossible via the emitter.
 * The synthetic arm names the lifecycle events that client classes emit but
 * tmux never sends; their shapes live in `connection-state.ts`, so they
 * cannot be derived from the wire union.
 *
 * [LAW:one-source-of-truth] Each arm derives from its own single source: the
 * non-byte wire union for parsed events, `connection-state.ts` for synthetic
 * ones. The split is visible here rather than hidden, mirroring
 * `EmitterMessage`.
 */
export type TmuxEventMap = {
  [M in EmitterTmuxMessage as M["type"]]: M;
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

  // [LAW:types-are-the-program] `emit`'s parameter is `EmitterMessage`, which
  //   excludes `PaneOutputMessage` by construction. Attempting to emit a
  //   pane-byte message anywhere in the codebase is a compile error — the
  //   sink channel is the only path for bytes. This is the type-level fix
  //   for the misdecode footgun: there is no overload, no escape hatch.
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
