// tests/unit/byte-codec.test.ts
// Unit tests for the portable byte-faithful codec.
// [LAW:behavior-not-structure] Tests assert the 1:1 byte↔code-unit contract,
//   not implementation details.

import { bytesToLatin1, latin1ToBytes } from "../../src/protocol/byte-codec.js";

describe("bytesToLatin1", () => {
  it("empty → empty string", () => {
    expect(bytesToLatin1(new Uint8Array([]))).toBe("");
  });

  it("ASCII bytes are preserved as-is", () => {
    const bytes = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
    expect(bytesToLatin1(bytes)).toBe("Hello");
  });

  it("each byte 0x00-0xFF maps to code unit of same value", () => {
    const all256 = new Uint8Array(256);
    for (let i = 0; i < 256; i++) all256[i] = i;
    const s = bytesToLatin1(all256);
    expect(s.length).toBe(256);
    for (let i = 0; i < 256; i++) {
      expect(s.charCodeAt(i)).toBe(i);
    }
  });

  it("high bytes (0x80-0xFF) are preserved without windows-1252 remapping", () => {
    // These are the bytes TextDecoder('latin1') silently mangles in browsers.
    const highBytes = new Uint8Array([0x80, 0x81, 0x8d, 0x8f, 0x9d, 0x9f]);
    const s = bytesToLatin1(highBytes);
    expect(s.length).toBe(6);
    for (let i = 0; i < highBytes.length; i++) {
      expect(s.charCodeAt(i)).toBe(highBytes[i]);
    }
  });

  it("round-trips through latin1ToBytes", () => {
    const original = new Uint8Array(256);
    for (let i = 0; i < 256; i++) original[i] = i;
    expect(latin1ToBytes(bytesToLatin1(original))).toEqual(original);
  });

  it("handles large input without stack overflow (>8192 bytes)", () => {
    const large = new Uint8Array(20000);
    for (let i = 0; i < large.length; i++) large[i] = i & 0xff;
    const s = bytesToLatin1(large);
    expect(s.length).toBe(20000);
    expect(s.charCodeAt(0)).toBe(0);
    expect(s.charCodeAt(255)).toBe(255);
    expect(s.charCodeAt(256)).toBe(0); // wraps
  });
});

describe("latin1ToBytes", () => {
  it("empty string → empty Uint8Array", () => {
    expect(latin1ToBytes("")).toEqual(new Uint8Array([]));
  });

  it("ASCII string is preserved as byte values", () => {
    const bytes = latin1ToBytes("Hello");
    expect(bytes).toEqual(new Uint8Array([72, 101, 108, 108, 111]));
  });

  it("each code unit 0x00-0xFF maps to byte of same value", () => {
    let s = "";
    for (let i = 0; i < 256; i++) s += String.fromCharCode(i);
    const bytes = latin1ToBytes(s);
    expect(bytes.length).toBe(256);
    for (let i = 0; i < 256; i++) {
      expect(bytes[i]).toBe(i);
    }
  });

  it("code units above 0xFF are masked to low 8 bits", () => {
    // U+0100 → 0x00, U+01FF → 0xFF — truncation is documented contract.
    const s = String.fromCharCode(0x100, 0x1ff);
    const bytes = latin1ToBytes(s);
    expect(bytes[0]).toBe(0x00);
    expect(bytes[1]).toBe(0xff);
  });

  it("round-trips through bytesToLatin1", () => {
    let s = "";
    for (let i = 0; i < 256; i++) s += String.fromCharCode(i);
    expect(bytesToLatin1(latin1ToBytes(s))).toBe(s);
  });
});
