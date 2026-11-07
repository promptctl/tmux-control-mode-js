// src/connectors/websocket/limits.ts
// The limits a consumer configures and a welcome advertises, in the shapes
// their enforcers take: a duration a JS timer honors as written, the
// heartbeat's off switch, and a count a limiter honors.
//
// [LAW:parse-dont-validate] The checkpoint for every ms option the bridge or
// client hands to setTimeout/setInterval and every count it compares against.
// The output types are the proof: a `DurationMs` or `PositiveInt` can only
// come from this module, so the units that own the timers and limits
// (Heartbeat, CallPump, Outbox, Handshake, ReconnectController) demand them
// in their signatures and never check again. Without the stamp, a `0` timeout
// arms a deadline that fires on the next macrotask — before any reply, which
// is always asynchronous — and every call fails for a "slow tmux" that was a
// configuration error.
// [LAW:single-enforcer] Both borders use it: consumer options (BridgeError
// BRIDGE_INVALID_ARG) and the wire's welcome limits (BridgeProtocolError in
// protocol.ts). [LAW:one-source-of-truth] The failure is a value the parser
// maker takes, so the message `name (value) must be shape` is rendered in one
// place for both.

import { BridgeError } from "../errors.js";

declare const durationMs: unique symbol;
declare const positiveInt: unique symbol;

/** A delay a timer honors as written: an integer in [1, 2^31-1]. Timers
 *  truncate a fractional delay (so 0.5 is 0 in a browser, 1 in Node). Out of
 *  the signed 32-bit range, Node clamps to 1 ms and a browser wraps through
 *  ToInt32 to a delay of 0 — either way a timer that fires every macrotask. */
export type DurationMs = number & { readonly [durationMs]: true };

/** Ping period; `0` is the off switch — no probe runs, and no liveness bound
 *  exists. [LAW:types-are-the-program] The switch is a literal in the type, not
 *  a `<= 0` range check a reader has to know about. */
export type HeartbeatInterval = 0 | DurationMs;

/** A count a limiter compares against: an integer >= 1. `0` would refuse the
 *  first call and `NaN` would admit every one. */
export type PositiveInt = number & { readonly [positiveInt]: true };

/** The largest delay setTimeout/setInterval honor (signed 32-bit ms). */
export const DURATION_MAX_MS = 2_147_483_647;

/** The accept shapes in words, for an error that names a value outside them. */
const DURATION_MS_SHAPE = `an integer number of ms in [1, ${DURATION_MAX_MS}]`;
const POSITIVE_INT_SHAPE = "an integer >= 1";

function isDurationMs(value: unknown): value is DurationMs {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= DURATION_MAX_MS
  );
}

function isZeroOrDurationMs(value: unknown): value is 0 | DurationMs {
  return value === 0 || isDurationMs(value);
}

function isPositiveInt(value: unknown): value is PositiveInt {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

/** Builds the error a parser throws for a value outside its shape. */
export type ParseFailure = (message: string) => Error;

/** Parses one named value; throws the failure it was made with. */
export type Parser<T> = (name: string, value: unknown) => T;

/** A parser with its predicate and wording bound, awaiting its failure. */
export type ParserMaker<T> = (fail: ParseFailure) => Parser<T>;

// [LAW:one-type-per-behavior] One parser shape; the accept predicate, its
// wording, and the error it raises are the values that differ.
export function parser<T>(
  accept: (value: unknown) => value is T,
  shape: string,
): ParserMaker<T> {
  return (fail) => (name, value) => {
    if (!accept(value)) {
      throw fail(`${name} (${String(value)}) must be ${shape}`);
    }
    return value;
  };
}

export const durationMsParser: ParserMaker<DurationMs> = parser(
  isDurationMs,
  DURATION_MS_SHAPE,
);

/** `0 | DurationMs`, with what the `0` means in the error: "heartbeat off",
 *  "no jitter". */
export function zeroOrDurationMsParser(
  zeroMeans: string,
): ParserMaker<0 | DurationMs> {
  return parser(isZeroOrDurationMs, `0 (${zeroMeans}) or ${DURATION_MS_SHAPE}`);
}

export const heartbeatIntervalParser: ParserMaker<HeartbeatInterval> =
  zeroOrDurationMsParser("heartbeat off");

export const positiveIntParser: ParserMaker<PositiveInt> = parser(
  isPositiveInt,
  POSITIVE_INT_SHAPE,
);

/** The failure for a consumer's option: `BRIDGE_INVALID_ARG` naming the
 *  option and the value it was given. */
export const invalidArg: ParseFailure = (message) =>
  new BridgeError("BRIDGE_INVALID_ARG", message);

export const parseDurationMs: Parser<DurationMs> = durationMsParser(invalidArg);

export const parseHeartbeatInterval: Parser<HeartbeatInterval> =
  heartbeatIntervalParser(invalidArg);

export const parsePositiveInt: Parser<PositiveInt> =
  positiveIntParser(invalidArg);

/** The stricter of two bounds. `Math.min` would return a bare `number`; the
 *  ternary keeps the stamp. */
export function minDurationMs(a: DurationMs, b: DurationMs): DurationMs {
  return a <= b ? a : b;
}
