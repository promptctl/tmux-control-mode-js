// tests/unit/decoder.test.ts
// Unit tests for decodeOctalEscapes

import { decodeOctalEscapes } from "../../src/protocol/decode.js";

describe("decodeOctalEscapes", () => {
  it("empty string → empty Uint8Array", () => {
    expect(decodeOctalEscapes("")).toEqual(new Uint8Array([]));
  });

  it("no escapes → bytes equal to char codes", () => {
    expect(decodeOctalEscapes("hello")).toEqual(
      new Uint8Array([104, 101, 108, 108, 111])
    );
  });

  it("\\000 → [0] (null byte)", () => {
    expect(decodeOctalEscapes("\\000")).toEqual(new Uint8Array([0]));
  });

  it("\\012 → [10] (newline)", () => {
    expect(decodeOctalEscapes("\\012")).toEqual(new Uint8Array([10]));
  });

  it("\\015 → [13] (carriage return)", () => {
    expect(decodeOctalEscapes("\\015")).toEqual(new Uint8Array([13]));
  });

  it("\\033 → [27] (ESC)", () => {
    expect(decodeOctalEscapes("\\033")).toEqual(new Uint8Array([27]));
  });

  it("\\134 → [0x5c] (backslash)", () => {
    expect(decodeOctalEscapes("\\134")).toEqual(new Uint8Array([0x5c]));
  });

  it("\\377 → [0xff]", () => {
    expect(decodeOctalEscapes("\\377")).toEqual(new Uint8Array([0xff]));
  });

  it("multiple escapes in sequence: \\000\\377 → [0, 255]", () => {
    expect(decodeOctalEscapes("\\000\\377")).toEqual(new Uint8Array([0, 255]));
  });

  it("mixed: 'hello\\012world' → hello bytes + 10 + world bytes", () => {
    expect(decodeOctalEscapes("hello\\012world")).toEqual(
      new Uint8Array([104, 101, 108, 108, 111, 10, 119, 111, 114, 108, 100])
    );
  });

  it("escape at very start: \\012abc → [10, ...abc bytes]", () => {
    expect(decodeOctalEscapes("\\012abc")).toEqual(
      new Uint8Array([10, 97, 98, 99])
    );
  });

  it("escape at very end: abc\\012 → [...abc bytes, 10]", () => {
    expect(decodeOctalEscapes("abc\\012")).toEqual(
      new Uint8Array([97, 98, 99, 10])
    );
  });

  it("all-escape string: \\001\\002\\003 → [1, 2, 3]", () => {
    expect(decodeOctalEscapes("\\001\\002\\003")).toEqual(
      new Uint8Array([1, 2, 3])
    );
  });

  it("non-octal backslash: \\xyz → '?' then x,y,z (matches reference)", () => {
    // 'x' is not an octal digit. Per the canonical decoder, a malformed
    // escape becomes '?' and the non-digit byte is reconsidered as input.
    const result = decodeOctalEscapes("\\xyz");
    expect(result).toEqual(new Uint8Array([0x3f, 0x78, 0x79, 0x7a]));
  });

  it("incomplete escape at end: \\13 → '?' (digits consumed by the attempt)", () => {
    // An escape that runs off the end yields '?', matching the reference.
    // Cannot occur on real data: the parser buffers whole lines, so a
    // %output value's escapes are always complete.
    expect(decodeOctalEscapes("\\13")).toEqual(new Uint8Array([0x3f]));
  });

  it("incomplete at end: abc\\13 → abc + '?'", () => {
    expect(decodeOctalEscapes("abc\\13")).toEqual(
      new Uint8Array([97, 98, 99, 0x3f]),
    );
  });

  it("literal control bytes are dropped (tmux escapes real ones as octal)", () => {
    // A raw \r / \x01 in the payload is line-driver noise, not pane data.
    expect(decodeOctalEscapes("a\rb")).toEqual(new Uint8Array([0x61, 0x62]));
    expect(decodeOctalEscapes("a\x01b")).toEqual(new Uint8Array([0x61, 0x62]));
  });

  it("escaped control bytes are KEPT (only literal ones drop)", () => {
    // \015 (escaped CR) survives; a literal trailing \r is dropped.
    expect(decodeOctalEscapes("a\\015\r")).toEqual(
      new Uint8Array([0x61, 0x0d]),
    );
  });

  it("\\r interleaved inside an octal escape is skipped", () => {
    // The line driver may sprinkle \r between the digits; the reference
    // skips them. "\<CR>012" decodes to a single 0x0a.
    expect(decodeOctalEscapes("\\\r012")).toEqual(new Uint8Array([0x0a]));
  });

  it("ANSI escape sequence: \\033[1;32m → correct bytes", () => {
    const result = decodeOctalEscapes("\\033[1;32m");
    expect(result[0]).toBe(27); // ESC
    expect(result[1]).toBe(0x5b); // '['
  });

  it("tmux line terminator pattern: hello\\012 → hello + newline", () => {
    expect(decodeOctalEscapes("hello\\012")).toEqual(
      new Uint8Array([104, 101, 108, 108, 111, 10])
    );
  });

  it("CR+LF: \\015\\012 → [13, 10]", () => {
    expect(decodeOctalEscapes("\\015\\012")).toEqual(new Uint8Array([13, 10]));
  });

  it("all control bytes 0-9: \\001\\002\\003\\004\\005\\006\\007\\010\\011\\012", () => {
    const result = decodeOctalEscapes(
      "\\001\\002\\003\\004\\005\\006\\007\\010\\011\\012"
    );
    expect(result).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
  });
});
