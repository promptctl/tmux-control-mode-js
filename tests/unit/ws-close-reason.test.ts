// tests/unit/ws-close-reason.test.ts
// truncateCloseReason is the one home of the WebSocket close-reason limit: 123
// bytes of UTF-8 (RFC 6455 §5.5 control payload minus the 2-byte code). The
// contract is what close() accepts: at most 123 bytes, a prefix of the input,
// never a split character.
import { describe, expect, it } from "vitest";
import { truncateCloseReason } from "../../src/connectors/websocket/protocol.js";

const bytes = (s: string): number => new TextEncoder().encode(s).length;

describe("truncateCloseReason", () => {
  it("leaves a reason that fits unchanged", () => {
    expect(truncateCloseReason("heartbeat timeout")).toBe("heartbeat timeout");
    expect(truncateCloseReason("")).toBe("");
  });

  it("cuts a long ASCII reason to exactly 123 bytes", () => {
    const out = truncateCloseReason("x".repeat(500));
    expect(out).toBe("x".repeat(123));
  });

  it.each([
    ["two-byte", "é"],
    ["three-byte", "€"],
    ["four-byte (a surrogate pair)", "😀"],
  ])("cuts a %s reason at a character boundary within 123 bytes", (_, ch) => {
    const reason = "a" + ch.repeat(100);
    const out = truncateCloseReason(reason);
    expect(bytes(out)).toBeLessThanOrEqual(123);
    // The longest prefix that fits: one more character would not.
    expect(bytes(out) + bytes(ch)).toBeGreaterThan(123);
    expect(reason.startsWith(out)).toBe(true);
    expect(out.endsWith(ch)).toBe(true);
  });
});
