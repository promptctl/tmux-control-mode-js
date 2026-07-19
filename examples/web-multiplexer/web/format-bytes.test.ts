// examples/web-multiplexer/web/format-bytes.test.ts
//
// Isolation tests for the single byte-escape enforcer. escapeByte owns the
// control-character escape table; prettyBytes iterates bytes through it and
// adds truncation. Pinning both keeps the inspector's key-escaper (which
// also routes through escapeByte) from drifting. [LAW:single-enforcer]

import { describe, it, expect } from "vitest";
import { escapeByte, prettyBytes } from "./format-bytes.ts";

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("escapeByte", () => {
  it("names the common control codes", () => {
    expect(escapeByte(0x1b)).toBe("\\x1b");
    expect(escapeByte(0x0a)).toBe("\\n");
    expect(escapeByte(0x0d)).toBe("\\r");
    expect(escapeByte(0x09)).toBe("\\t");
  });

  it("passes printable ASCII through and hex-escapes everything else", () => {
    expect(escapeByte(0x41)).toBe("A");
    expect(escapeByte(0x20)).toBe(" ");
    expect(escapeByte(0x7e)).toBe("~");
    expect(escapeByte(0x00)).toBe("\\x00");
    expect(escapeByte(0xff)).toBe("\\xff");
  });
});

describe("prettyBytes", () => {
  it("renders printable bytes verbatim", () => {
    expect(prettyBytes(bytes("hello"))).toBe("hello");
  });

  it("escapes control bytes via the shared escaper", () => {
    expect(prettyBytes(bytes("a\r\nb"))).toBe("a\\r\\nb");
  });

  it("truncates at max and appends the total byte count", () => {
    const out = prettyBytes(bytes("x".repeat(100)), 10);
    expect(out.startsWith("xxxxxxxxxx")).toBe(true);
    expect(out).toContain("… (100 bytes)");
  });
});
