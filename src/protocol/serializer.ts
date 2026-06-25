// src/protocol/serializer.ts
// Serializes a TmuxMessage back to its control-mode wire line — the exact
// inverse of TmuxParser. Pure TypeScript, no Node.js dependencies. Works in
// browser, Deno, Bun.
//
// [LAW:types-are-the-program] The serializer is the parser run backwards: for
// every variant V, `parse(serializeMessage(V))` reproduces V. The exhaustive
// switch makes the inverse total — a new TmuxMessage variant fails to compile
// here until its wire form is declared, so the two directions cannot drift.
// [LAW:one-source-of-truth] The wire grammar lives in exactly two mirrored
// places: PARSERS (wire → message) in parser.ts and this switch (message →
// wire). The round-trip test against TmuxParser is the contract binding them.

import type { TmuxMessage } from "./types.js";
import { encodeOctalEscapes } from "./decode.js";

// ---------------------------------------------------------------------------
// ID formatting — the inverse of parser.ts's parsePaneId/parseWindowId/etc.
// [LAW:one-source-of-truth] Prefix conventions ($session, @window, %pane) are
// written here once, mirroring the slice(1) parsers.
// ---------------------------------------------------------------------------

/** `-1` → `-` (the "not applicable" wire token), else `prefix + n`. */
function optionalId(n: number, prefix: string): string {
  return n === -1 ? "-" : prefix + n;
}

/** `-1` → `-`, else the integer's decimal text. */
function optionalInt(n: number): string {
  return n === -1 ? "-" : String(n);
}

/**
 * Serialize one server-to-client message to its wire line (no trailing
 * newline — the transport adds it, matching the encoder.ts convention for the
 * outbound direction).
 *
 * Round-trip domain: holds for every value the parser can produce. The two
 * degenerate inputs a hand-built message could carry that the parser never
 * emits — an `exit` with `reason: ""` and a `name`/text field containing a
 * literal newline — are out of the protocol's domain (a wire line is, by
 * definition, newline-free); callers building messages for replay stay within
 * the parser's output domain.
 */
export function serializeMessage(msg: TmuxMessage): string {
  switch (msg.type) {
    case "begin":
    case "end":
    case "error":
      return `%${msg.type} ${msg.timestamp} ${msg.commandNumber} ${msg.flags}`;

    case "output":
      return `%output %${msg.paneId} ${encodeOctalEscapes(msg.data)}`;

    case "extended-output":
      return `%extended-output %${msg.paneId} ${msg.age} : ${encodeOctalEscapes(msg.data)}`;

    case "pause":
      return `%pause %${msg.paneId}`;
    case "continue":
      return `%continue %${msg.paneId}`;
    case "pane-mode-changed":
      return `%pane-mode-changed %${msg.paneId}`;

    case "window-add":
      return `%window-add @${msg.windowId}`;
    case "window-close":
      return `%window-close @${msg.windowId}`;
    case "unlinked-window-add":
      return `%unlinked-window-add @${msg.windowId}`;
    case "unlinked-window-close":
      return `%unlinked-window-close @${msg.windowId}`;

    case "window-renamed":
      return `%window-renamed @${msg.windowId} ${msg.name}`;
    case "unlinked-window-renamed":
      return `%unlinked-window-renamed @${msg.windowId} ${msg.name}`;

    case "window-pane-changed":
      return `%window-pane-changed @${msg.windowId} %${msg.paneId}`;

    case "layout-change":
      return `%layout-change @${msg.windowId} ${msg.windowLayout} ${msg.windowVisibleLayout} ${msg.windowFlags}`;

    case "session-changed":
      return `%session-changed $${msg.sessionId} ${msg.name}`;
    case "session-renamed":
      return `%session-renamed $${msg.sessionId} ${msg.name}`;
    case "sessions-changed":
      return `%sessions-changed`;
    case "session-window-changed":
      return `%session-window-changed $${msg.sessionId} @${msg.windowId}`;

    case "client-session-changed":
      return `%client-session-changed ${msg.clientName} $${msg.sessionId} ${msg.name}`;
    case "client-detached":
      return `%client-detached ${msg.clientName}`;

    case "paste-buffer-changed":
      return `%paste-buffer-changed ${msg.name}`;
    case "paste-buffer-deleted":
      return `%paste-buffer-deleted ${msg.name}`;

    case "subscription-changed":
      return `%subscription-changed ${msg.name} ${optionalId(msg.sessionId, "$")} ${optionalId(msg.windowId, "@")} ${optionalInt(msg.windowIndex)} ${optionalId(msg.paneId, "%")} : ${msg.value}`;

    case "message":
      return `%message ${msg.message}`;
    case "config-error":
      return `%config-error ${msg.error}`;

    case "exit":
      // [LAW:dataflow-not-control-flow] variability is in the value (reason
      // present or absent), producing one line either way.
      return msg.reason === undefined ? `%exit` : `%exit ${msg.reason}`;

    default:
      return assertNever(msg);
  }
}

// [LAW:types-are-the-program] If a TmuxMessage variant is added without a case
// above, `msg` is no longer `never` here and this fails to compile — the
// inverse stays total by construction, not by reviewer vigilance.
function assertNever(msg: never): never {
  throw new Error(
    `serializeMessage: unhandled message variant ${JSON.stringify(msg)}`,
  );
}
