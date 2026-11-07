// src/connectors/websocket/duration.ts
// A duration a JS timer honors as written, and the heartbeat's off switch.
//
// [LAW:parse-dont-validate] The checkpoint for a ms option the bridge or
// client hands to setTimeout/setInterval. The output types are the proof:
// a `DurationMs` or `HeartbeatInterval` can only come from this module, so
// the units that own the timers (Heartbeat) demand them in their signatures
// and never check again. Without the stamp, a `0` timeout arms a deadline that
// fires on the next macrotask — before any pong, which is always asynchronous
// — and every peer is closed for "silence" that was a configuration error.
// [LAW:single-enforcer] Both borders use it: consumer options (BridgeError
// BRIDGE_INVALID_ARG) and the wire's welcome limits (BridgeProtocolError,
// composed from the same shape text in protocol.ts).

import { BridgeError } from "../errors.js";

declare const durationMs: unique symbol;

/** A delay a timer honors as written: an integer in [1, 2^31-1]. Timers
 *  truncate a fractional delay (so 0.5 is 0 in a browser, 1 in Node), and
 *  both clamp a delay outside the signed 32-bit range to 1 ms. */
export type DurationMs = number & { readonly [durationMs]: true };

/** Ping period; `0` is the off switch — no probe runs, and no liveness bound
 *  exists. [LAW:types-are-the-program] The switch is a literal in the type, not
 *  a `<= 0` range check a reader has to know about. */
export type HeartbeatInterval = 0 | DurationMs;

/** The largest delay setTimeout/setInterval honor (signed 32-bit ms). */
export const DURATION_MAX_MS = 2_147_483_647;

/** The accept shapes in words, for an error that names a value outside them. */
const DURATION_MS_SHAPE = `an integer number of ms in [1, ${DURATION_MAX_MS}]`;
export const HEARTBEAT_INTERVAL_SHAPE = `0 (heartbeat off) or ${DURATION_MS_SHAPE}`;

function isDurationMs(value: number): value is DurationMs {
  return Number.isInteger(value) && value >= 1 && value <= DURATION_MAX_MS;
}

export function isHeartbeatInterval(value: number): value is HeartbeatInterval {
  return value === 0 || isDurationMs(value);
}

// [LAW:one-type-per-behavior] One parser shape; the accept predicate and its
// wording are the values that differ.
function parser<T extends number>(
  accept: (value: number) => value is T,
  shape: string,
): (name: string, value: number) => T {
  return (name, value) => {
    if (!accept(value)) {
      throw new BridgeError(
        "BRIDGE_INVALID_ARG",
        `${name} (${value}) must be ${shape}`,
      );
    }
    return value;
  };
}

/** Parse a consumer's ms option; throws `BRIDGE_INVALID_ARG` naming the
 *  option and the value it was given. */
export const parseDurationMs: (name: string, value: number) => DurationMs =
  parser(isDurationMs, DURATION_MS_SHAPE);

export const parseHeartbeatInterval: (
  name: string,
  value: number,
) => HeartbeatInterval = parser(isHeartbeatInterval, HEARTBEAT_INTERVAL_SHAPE);
