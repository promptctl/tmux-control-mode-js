// tests/unit/ws-duration.test.ts
// The parser for a ms option the bridge or client hands to a timer, and the
// heartbeat's off switch. Each row of the accept/reject table is a case; the
// thrown message names the option and the value it was given. A timer
// truncates a fractional delay (0.5 → 0 in a browser, 1 in Node), so a
// fraction is a value no timer honors as written and is rejected like any
// other.
import { describe, it, expect } from "vitest";
import { BridgeError } from "../../src/connectors/errors.js";
import { DURATION_MAX_MS } from "../../src/connectors/websocket/duration.js";
import {
  parseDurationMs,
  parseHeartbeatInterval,
} from "../../src/connectors/websocket/protocol.js";

const REJECTED = [
  ["negative", -1],
  ["NaN", Number.NaN],
  ["+Infinity", Number.POSITIVE_INFINITY],
  ["-Infinity", Number.NEGATIVE_INFINITY],
  ["the smallest positive", Number.MIN_VALUE],
  ["a fraction below one", 0.5],
  ["a fraction above one", 1.5],
  ["above the timer clamp", DURATION_MAX_MS + 1],
] as const;

const ACCEPTED = [
  ["one", 1],
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
      expect(fn).toThrow(`[1, ${DURATION_MAX_MS}]`);
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
