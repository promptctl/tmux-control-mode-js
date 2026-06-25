// src/conformance/samples.ts
// The canonical one-of-each-variant message catalogue, plus the partition that
// says which channel each variant is observed on. This is the single source the
// conformance checks, the serializer round-trip test, and the live integration
// column all iterate — there is no second "list of every message".
//
// [LAW:one-source-of-truth] One sample per TmuxMessage variant, keyed by the
// discriminant. The `Record<TmuxMessage["type"], …>` type makes coverage a
// COMPILE-TIME guarantee: add a variant to protocol/types.ts and this object
// fails to typecheck until it gets a sample. "Exercises every documented
// notification" is therefore enforced by the type system, not by reviewer count.
// [LAW:effects-at-boundaries] Pure data + a pure classifier. No client, no mock,
// no clock — so it imports nothing but the protocol type and is browser-safe.

import type { TmuxMessage } from "../protocol/types.js";

/**
 * One canonical example per server-to-client message variant. Every value lies
 * within the parser's output domain (the round-trip domain of
 * `serializeMessage`), so `parse(serialize(sample))` reproduces it — which is
 * what lets a check use the wire form as its equality oracle.
 */
export const MESSAGE_SAMPLES: Record<TmuxMessage["type"], TmuxMessage> = {
  begin: { type: "begin", timestamp: 1363006971, commandNumber: 2, flags: 1 },
  end: { type: "end", timestamp: 1363006971, commandNumber: 2, flags: 1 },
  error: { type: "error", timestamp: 1363006971, commandNumber: 3, flags: 1 },
  output: { type: "output", paneId: 1, data: new Uint8Array([104, 105]) },
  "extended-output": {
    type: "extended-output",
    paneId: 7,
    age: 42,
    data: new Uint8Array([120]),
  },
  pause: { type: "pause", paneId: 4 },
  continue: { type: "continue", paneId: 4 },
  "pane-mode-changed": { type: "pane-mode-changed", paneId: 9 },
  "window-add": { type: "window-add", windowId: 2 },
  "window-close": { type: "window-close", windowId: 2 },
  "window-renamed": { type: "window-renamed", windowId: 2, name: "editor" },
  "window-pane-changed": {
    type: "window-pane-changed",
    windowId: 2,
    paneId: 5,
  },
  "unlinked-window-add": { type: "unlinked-window-add", windowId: 8 },
  "unlinked-window-close": { type: "unlinked-window-close", windowId: 8 },
  "unlinked-window-renamed": {
    type: "unlinked-window-renamed",
    windowId: 8,
    name: "bg",
  },
  "layout-change": {
    type: "layout-change",
    windowId: 2,
    windowLayout: "b1f2,80x24,0,0,3",
    windowVisibleLayout: "b1f2,80x24,0,0,3",
    windowFlags: "*",
  },
  "session-changed": { type: "session-changed", sessionId: 1, name: "main" },
  "session-renamed": { type: "session-renamed", sessionId: 1, name: "work" },
  "sessions-changed": { type: "sessions-changed" },
  "session-window-changed": {
    type: "session-window-changed",
    sessionId: 1,
    windowId: 2,
  },
  "client-session-changed": {
    type: "client-session-changed",
    clientName: "/dev/ttys001",
    sessionId: 1,
    name: "main",
  },
  "client-detached": { type: "client-detached", clientName: "/dev/ttys001" },
  "paste-buffer-changed": { type: "paste-buffer-changed", name: "buffer0" },
  "paste-buffer-deleted": { type: "paste-buffer-deleted", name: "buffer0" },
  "subscription-changed": {
    type: "subscription-changed",
    name: "mysub",
    sessionId: 1,
    windowId: 2,
    windowIndex: 0,
    paneId: 5,
    value: "some-format-value",
  },
  message: { type: "message", message: "hello from tmux" },
  "config-error": { type: "config-error", error: "/etc/tmux.conf:3: bad" },
  exit: { type: "exit", reason: "server exited" },
};

/**
 * The channel a consumer observes a variant on. This mirrors TmuxClient's
 * `handleMessage` dispatch exactly — the same three-way split the type system
 * already draws:
 *
 *   - `pane-output` — `OutputMessage` / `ExtendedOutputMessage` flow through the
 *     sink channel (`attachBytesSink`); they are NOT deliverable through the
 *     emitter. Observed as decoded bytes at a sink.
 *   - `command` — `%begin`/`%end`/`%error` are the correlation guard frames.
 *     Observed by `execute()` resolving (`%end`) or rejecting (`%error`), not as
 *     standalone events.
 *   - `notification` — every other variant is emitted to event listeners.
 *     Observed via `client.on(type, …)`.
 *
 * [LAW:types-are-the-program] The `satisfies Record<TmuxMessage["type"], Channel>`
 * clause makes the partition TOTAL by construction: a new variant fails to
 * compile here until it is assigned a channel. So "covers every variant" cannot
 * silently regress — the gap is a type error, not a missing test.
 * [LAW:one-source-of-truth] This partition is the conformance module's encoding
 * of TmuxClient's routing; the checks read it rather than re-deciding per case.
 */
export type ObservationChannel = "notification" | "command" | "pane-output";

export const CHANNEL_OF = {
  begin: "command",
  end: "command",
  error: "command",
  output: "pane-output",
  "extended-output": "pane-output",
  pause: "notification",
  continue: "notification",
  "pane-mode-changed": "notification",
  "window-add": "notification",
  "window-close": "notification",
  "window-renamed": "notification",
  "window-pane-changed": "notification",
  "unlinked-window-add": "notification",
  "unlinked-window-close": "notification",
  "unlinked-window-renamed": "notification",
  "layout-change": "notification",
  "session-changed": "notification",
  "session-renamed": "notification",
  "sessions-changed": "notification",
  "session-window-changed": "notification",
  "client-session-changed": "notification",
  "client-detached": "notification",
  "paste-buffer-changed": "notification",
  "paste-buffer-deleted": "notification",
  "subscription-changed": "notification",
  message: "notification",
  "config-error": "notification",
  exit: "notification",
} as const satisfies Record<TmuxMessage["type"], ObservationChannel>;
