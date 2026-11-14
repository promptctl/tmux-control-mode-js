// src/emitter.ts
// Minimal typed event emitter for TmuxClient.
// No Node.js dependencies — works in any JS environment.

// [LAW:types-are-the-program] The strongest true theorem about what the
// emitter carries is "state events, never bytes." Pane bytes flow exclusively
// through SinkRegistry (`attachBytesSink`); they
// are not deliverable through any emitter overload. `EmitterTmuxMessage`
// encodes that constraint by `Exclude`-ing `PaneOutputMessage` from the
// `TmuxMessage` union, and `TypedEmitter.emit`'s parameter is `EmitterMessage`
// so attempting to emit a pane-byte message is a compile error at every
// callsite. The wildcard `'*'` listener's argument type is `EmitterMessage`
// for the same reason — narrowing on `msg.type === 'output'` produces `never`,
// making the consumer's byte-handling branch structurally unreachable.
//
// [LAW:one-source-of-truth] `TmuxEventMap`'s wire arm is mechanically derived
// from `EmitterTmuxMessage`; its synthetic arm from `SyntheticEmitterMessage`.
// [LAW:one-type-per-behavior] Single emitter type parameterized by the event map.

import type {
  PaneOutputMessage,
  ProtocolErrorMessage,
  TmuxMessage,
  UnsolicitedResponseMessage,
} from "./protocol/types.js";
import type {
  ConnectionStateMessage,
  ReconnectedMessage,
  TopologyErrorMessage,
} from "./connection-state.js";
import type { CrossSessionLayoutMessage } from "./cross-session-layout.js";

/**
 * The subset of `TmuxMessage` that flows through the emitter. Pane-byte
 * messages (`OutputMessage` / `ExtendedOutputMessage`) are excluded because
 * they belong to the sink channel — see `SinkRegistry` in
 * `src/pane-output.ts` and `TmuxClient.attachBytesSink`.
 *
 * [LAW:one-source-of-truth] Derived from `TmuxMessage` via `Exclude`; adding
 * a non-byte variant to `protocol/types.ts` propagates here automatically.
 * The exclusion is the type-level encoding of "bytes are a separate channel"
 * — there is nowhere else this rule lives.
 */
export type EmitterTmuxMessage = Exclude<TmuxMessage, PaneOutputMessage>;

/**
 * Events client/parser classes synthesize themselves — never parsed from
 * tmux output. This is the one place that union is named; everything that
 * needs to distinguish synthetic events from wire messages (`EmitterMessage`,
 * `TmuxEventMap`'s synthetic arm, `isTmuxMessage`) derives from it instead of
 * re-listing the three variants.
 *
 * [LAW:one-source-of-truth] Adding a synthetic event type only means adding
 * it to this union — `SYNTHETIC_EVENT_SUBJECTS` below fails to compile until
 * it says what the event is about, and `TmuxEventMap`'s synthetic arm picks
 * it up automatically via mapped type.
 */
export type SyntheticEmitterMessage =
  | ConnectionStateMessage
  | ReconnectedMessage
  | ProtocolErrorMessage
  | UnsolicitedResponseMessage
  | TopologyErrorMessage
  | CrossSessionLayoutMessage;

/**
 * Every event the emitter can carry. State-shaped `TmuxMessage` variants
 * (parsed from tmux output) plus the synthetic events. This is the type
 * seen by `'*'` wildcard listeners.
 *
 * [LAW:one-source-of-truth] Wildcard listeners read this union; per-event
 * listeners read `TmuxEventMap`. Both are derived in this file only.
 */
export type EmitterMessage = EmitterTmuxMessage | SyntheticEmitterMessage;

/**
 * What each synthetic event is a fact about:
 * - `lifecycle` — this client's connection (`connection-state`, `reconnected`);
 * - `reply-stream` — tmux's reply blocks no caller took: one tmux wrote for a
 *   command no caller sent, or one whose terminator is malformed;
 * - `pane-table` — this client's own pane routing table;
 * - `cross-session-layout` — the relay's reports on other sessions' windows.
 *
 * [LAW:one-source-of-truth] The one answer to "what is this event about";
 * `isTmuxMessage`, the bridges' routing and the stream projections all derive
 * from it. `satisfies Record` makes a synthetic type added to (or removed
 * from) `SyntheticEmitterMessage` a compile error until it is listed here.
 */
const SYNTHETIC_EVENT_SUBJECTS = {
  "connection-state": "lifecycle",
  reconnected: "lifecycle",
  "protocol-error": "reply-stream",
  "unsolicited-response": "reply-stream",
  "topology-error": "pane-table",
  "cross-session-layout-change": "cross-session-layout",
  "cross-session-layout-decode-error": "cross-session-layout",
  "cross-session-layout-overrun": "cross-session-layout",
  "cross-session-layout-fetch-failed": "cross-session-layout",
  "cross-session-layout-hook-restored": "cross-session-layout",
  "cross-session-layout-repair-failed": "cross-session-layout",
  "cross-session-layout-uncovered": "cross-session-layout",
} as const satisfies Record<SyntheticEmitterMessage["type"], string>;

type SyntheticSubjects = typeof SYNTHETIC_EVENT_SUBJECTS;

/** What an emitter event is a fact about; `tmux` for a parsed tmux message. */
export type EventSubject = "tmux" | SyntheticSubjects[keyof SyntheticSubjects];

/** The emitter events about `S`. */
export type MessageAbout<S extends EventSubject> =
  | (S extends "tmux" ? EmitterTmuxMessage : never)
  | Extract<
      SyntheticEmitterMessage,
      {
        readonly type: {
          [T in keyof SyntheticSubjects]: SyntheticSubjects[T] extends S
            ? T
            : never;
        }[keyof SyntheticSubjects];
      }
    >;

export function eventSubject(ev: EmitterMessage): EventSubject {
  return Object.hasOwn(SYNTHETIC_EVENT_SUBJECTS, ev.type)
    ? SYNTHETIC_EVENT_SUBJECTS[ev.type as keyof SyntheticSubjects]
    : "tmux";
}

/**
 * Type guard separating parsed tmux messages from synthetic events.
 * [LAW:single-enforcer] Derived from `eventSubject`, the one classification.
 */
export function isTmuxMessage(ev: EmitterMessage): ev is EmitterTmuxMessage {
  return eventSubject(ev) === "tmux";
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
 * The synthetic arm projects `SyntheticEmitterMessage` the same way — adding
 * a variant there produces the right entry here with no second edit.
 *
 * [LAW:one-source-of-truth] Each arm derives from its own single source: the
 * non-byte wire union for parsed events, `SyntheticEmitterMessage` for
 * synthetic ones. The split is visible here rather than hidden, mirroring
 * `EmitterMessage`.
 */
export type TmuxEventMap = {
  [M in EmitterTmuxMessage as M["type"]]: M;
} & {
  [M in SyntheticEmitterMessage as M["type"]]: M;
};

// Internal handler type — erases the event payload for storage.
// Public API preserves full type safety via overloads.
type AnyHandler = (event: never) => void;

/**
 * Minimal typed event emitter. NOT Node.js EventEmitter.
 *
 * Type-safe: `on("window-add", handler)` gives autocomplete on event names
 * and infers the handler argument type. Wildcard `"*"` listeners receive
 * the `EmitterMessage` union — every non-byte tmux message plus the
 * synthetic lifecycle events (`connection-state`, `reconnected`). Pane-
 * byte messages (`OutputMessage` / `ExtendedOutputMessage`) are NOT
 * deliverable through any emitter overload; they flow through
 * `attachBytesSink` on `TmuxClient`.
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
