// tests/unit/ws-close-reason.test.ts
// closeReason: the longest prefix of a message that fits a close frame's
// 123-byte UTF-8 reason, cut on a code-point boundary.

import { describe, expect, it } from "vitest";

import { closeReason } from "../../src/connectors/websocket/protocol.js";

const bytes = (s: string): number => new TextEncoder().encode(s).length;

describe("closeReason", () => {
  it.each([
    ["under the limit", "a".repeat(10), "a".repeat(10)],
    ["at the limit", "a".repeat(123), "a".repeat(123)],
    ["over the limit", "a".repeat(200), "a".repeat(123)],
    ["empty", "", ""],
  ])("ASCII %s keeps the longest prefix within 123 bytes", (_l, msg, out) => {
    expect(closeReason(msg)).toBe(out);
  });

  it("a 2-byte code point straddling byte 123 is left out whole", () => {
    // 122 ASCII bytes, then "é" (2 bytes) would end at byte 124.
    const msg = "a".repeat(122) + "é" + "tail";
    expect(closeReason(msg)).toBe("a".repeat(122));
  });

  it("an astral code point straddling byte 123 is left out whole, surrogates together", () => {
    // 120 ASCII bytes, then "😀" (4 bytes, 2 UTF-16 units) would end at 124.
    const msg = "a".repeat(120) + "😀" + "tail";
    const out = closeReason(msg);
    expect(out).toBe("a".repeat(120));
    expect(bytes(out)).toBeLessThanOrEqual(123);
  });

  it("a multibyte message is a prefix of the input and fits", () => {
    const msg = "ünïcödé ".repeat(30);
    const out = closeReason(msg);
    expect(msg.startsWith(out)).toBe(true);
    expect(bytes(out)).toBeLessThanOrEqual(123);
    expect(bytes(msg.slice(0, out.length + 1))).toBeGreaterThan(123);
  });
});
