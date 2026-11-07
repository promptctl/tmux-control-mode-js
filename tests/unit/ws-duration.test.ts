// tests/unit/ws-duration.test.ts
// The one parser for every ms option the bridge and client hand to a timer,
// and the heartbeat's off switch. Each row of the accept/reject table is a
// case; the thrown message names the option and the value it was given.
import { describe, it, expect } from "vitest";
import { BridgeError } from "../../src/connectors/errors.js";
import {
  DURATION_MAX_MS,
  parseDurationMs,
  parseHeartbeatInterval,
} from "../../src/connectors/websocket/duration.js";

const REJECTED = [
  ["negative", -1],
  ["NaN", Number.NaN],
  ["+Infinity", Number.POSITIVE_INFINITY],
  ["-Infinity", Number.NEGATIVE_INFINITY],
  ["above the timer clamp", DURATION_MAX_MS + 1],
] as const;

const ACCEPTED = [
  ["the smallest positive", Number.MIN_VALUE],
  ["one", 1],
  ["fractional", 0.5],
  ["the timer clamp itself", DURATION_MAX_MS],
] as const;

describe("parseDurationMs", () => {
  it.each(ACCEPTED)("accepts %s and returns the value unchanged", (_, v) => {
    expect(parseDurationMs("heartbeatTimeoutMs", v)).toBe(v);
  });

  it.each([["zero", 0] as const, ...REJECTED])(
    "rejects %s with BRIDGE_INVALID_ARG naming the option and value",
    (_, v) => {
      const fn = (): unknown => parseDurationMs("heartbeatTimeoutMs", v);
      expect(fn).toThrow(BridgeError);
      expect(fn).toThrow(/BRIDGE_INVALID_ARG/);
      expect(fn).toThrow(`heartbeatTimeoutMs (${v}) must be`);
      expect(fn).toThrow(`(0, ${DURATION_MAX_MS}]`);
    },
  );
});

describe("parseHeartbeatInterval", () => {
  it("accepts 0 as the off switch", () => {
    expect(parseHeartbeatInterval("heartbeatIntervalMs", 0)).toBe(0);
  });

  it.each(ACCEPTED)("accepts %s and returns the value unchanged", (_, v) => {
    expect(parseHeartbeatInterval("heartbeatIntervalMs", v)).toBe(v);
  });

  it.each(REJECTED)(
    "rejects %s with BRIDGE_INVALID_ARG naming the option, the value, and the off switch",
    (_, v) => {
      const fn = (): unknown =>
        parseHeartbeatInterval("heartbeatIntervalMs", v);
      expect(fn).toThrow(BridgeError);
      expect(fn).toThrow(/BRIDGE_INVALID_ARG/);
      expect(fn).toThrow(
        `heartbeatIntervalMs (${v}) must be 0 (heartbeat off) or`,
      );
    },
  );
});
