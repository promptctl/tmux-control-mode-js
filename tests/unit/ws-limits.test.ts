// tests/unit/ws-limits.test.ts
// The parsers for the limits a consumer configures and a welcome advertises:
// a ms option the bridge or client hands to a timer, the heartbeat's off
// switch, and a count a limiter compares against. Each row of the
// accept/reject table is a case; the thrown message names the option and the
// value it was given. A timer truncates a fractional delay (0.5 → 0 in a
// browser, 1 in Node), so a fraction is a value no timer honors as written
// and is rejected like any other.
import { describe, it, expect } from "vitest";
import { BridgeError } from "../../src/connectors/errors.js";
import {
  DURATION_MAX_MS,
  durationMsParser,
  minDurationMs,
} from "../../src/connectors/websocket/limits.js";
import {
  BridgeProtocolError,
  parseDurationMs,
  parseHeartbeatInterval,
  parsePositiveInt,
} from "../../src/connectors/websocket/protocol.js";

const NOT_A_DURATION = [
  ["negative", -1],
  ["NaN", Number.NaN],
  ["+Infinity", Number.POSITIVE_INFINITY],
  ["-Infinity", Number.NEGATIVE_INFINITY],
  ["the smallest positive", Number.MIN_VALUE],
  ["a fraction below one", 0.5],
  ["a fraction above one", 1.5],
  ["above the timer clamp", DURATION_MAX_MS + 1],
  ["a numeric string", "1000"],
  ["undefined", undefined],
] as const;

const DURATIONS = [
  ["one", 1],
  ["the timer clamp itself", DURATION_MAX_MS],
] as const;

describe("parseDurationMs", () => {
  it.each(DURATIONS)("accepts %s and returns the value unchanged", (_, v) => {
    expect(parseDurationMs("heartbeatTimeoutMs", v)).toBe(v);
  });

  it.each([["zero", 0] as const, ...NOT_A_DURATION])(
    "rejects %s with BRIDGE_INVALID_ARG naming the option and value",
    (_, v) => {
      const fn = (): unknown => parseDurationMs("heartbeatTimeoutMs", v);
      expect(fn).toThrow(BridgeError);
      expect(fn).toThrow(/BRIDGE_INVALID_ARG/);
      expect(fn).toThrow(`heartbeatTimeoutMs (${String(v)}) must be`);
      expect(fn).toThrow(`[1, ${DURATION_MAX_MS}]`);
    },
  );
});

describe("parseHeartbeatInterval", () => {
  it("accepts 0 as the off switch", () => {
    expect(parseHeartbeatInterval("heartbeatIntervalMs", 0)).toBe(0);
  });

  it.each(DURATIONS)("accepts %s and returns the value unchanged", (_, v) => {
    expect(parseHeartbeatInterval("heartbeatIntervalMs", v)).toBe(v);
  });

  it.each(NOT_A_DURATION)(
    "rejects %s with BRIDGE_INVALID_ARG naming the option, the value, and the off switch",
    (_, v) => {
      const fn = (): unknown =>
        parseHeartbeatInterval("heartbeatIntervalMs", v);
      expect(fn).toThrow(BridgeError);
      expect(fn).toThrow(/BRIDGE_INVALID_ARG/);
      expect(fn).toThrow(
        `heartbeatIntervalMs (${String(v)}) must be 0 (heartbeat off) or`,
      );
    },
  );
});

describe("parsePositiveInt", () => {
  it.each([
    ["one", 1],
    ["a large count", 1_000_000],
    ["a count past the timer clamp", DURATION_MAX_MS + 1],
  ] as const)("accepts %s and returns the value unchanged", (_, v) => {
    expect(parsePositiveInt("maxInflight", v)).toBe(v);
  });

  it.each([
    ["zero", 0],
    ["negative", -1],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["a fraction", 1.5],
    ["a numeric string", "4"],
  ] as const)(
    "rejects %s with BRIDGE_INVALID_ARG naming the option and value",
    (_, v) => {
      const fn = (): unknown => parsePositiveInt("maxInflight", v);
      expect(fn).toThrow(BridgeError);
      expect(fn).toThrow(/BRIDGE_INVALID_ARG/);
      expect(fn).toThrow(`maxInflight (${String(v)}) must be an integer >= 1`);
    },
  );
});

describe("a parser maker renders one message through the failure it is given", () => {
  it("the wire border's parser throws the protocol error with the same text", () => {
    const wire = durationMsParser((m) => new BridgeProtocolError(m));
    const fn = (): unknown => wire("welcome.limits.requestTimeoutMs", 0);
    expect(fn).toThrow(BridgeProtocolError);
    expect(fn).not.toThrow(/BRIDGE_INVALID_ARG/);
    expect(fn).toThrow(
      `welcome.limits.requestTimeoutMs (0) must be an integer number of ms in [1, ${DURATION_MAX_MS}]`,
    );
    expect(wire("welcome.limits.requestTimeoutMs", 5_000)).toBe(5_000);
  });
});

describe("minDurationMs", () => {
  it("returns the stricter of two bounds", () => {
    const a = parseDurationMs("a", 10);
    const b = parseDurationMs("b", 20);
    expect(minDurationMs(a, b)).toBe(10);
    expect(minDurationMs(b, a)).toBe(10);
    expect(minDurationMs(a, a)).toBe(10);
  });
});
