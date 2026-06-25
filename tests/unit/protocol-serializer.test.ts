// tests/unit/protocol-serializer.test.ts
// serializeMessage is the parser run backwards. The contract is the round trip:
// for every TmuxMessage variant, parse(serialize(m)) reproduces m, and the
// octal encoder is the exact inverse of the decoder for ALL bytes.
//
// [LAW:behavior-not-structure] These assert the meaning (the inverse relation),
// not the exact string shape — so a wire-format refactor that keeps the pair in
// sync stays green, while any drift between the two directions fails loudly.

import { describe, it, expect } from "vitest";
import { TmuxParser } from "../../src/protocol/parser.js";
import { serializeMessage } from "../../src/protocol/serializer.js";
import {
  encodeOctalEscapes,
  decodeOctalEscapes,
} from "../../src/protocol/decode.js";
import type { TmuxMessage } from "../../src/protocol/types.js";
// [LAW:one-source-of-truth] The one-of-each-variant catalogue lives in the
// conformance module and is consumed here — there is no second twin list to
// drift. The Record<TmuxMessage["type"], …> type still enforces coverage at the
// source.
import { MESSAGE_SAMPLES } from "../../src/conformance/samples.js";

// Parse a single wire line standalone (outside any response block) back into the
// one message it encodes. The serializer omits the trailing newline; the parser
// is line-driven, so we add it here.
function parseOne(line: string): TmuxMessage {
  const out: TmuxMessage[] = [];
  const parser = new TmuxParser((m) => out.push(m));
  parser.feed(line + "\n");
  expect(out).toHaveLength(1);
  return out[0];
}

function roundTrip(msg: TmuxMessage): TmuxMessage {
  return parseOne(serializeMessage(msg));
}

// [LAW:one-source-of-truth] The canonical one-of-each-variant catalogue is
// MESSAGE_SAMPLES (imported above); the Record<TmuxMessage["type"], …> type
// there keeps coverage a compile-time guarantee. This test consumes it.
const SAMPLES = MESSAGE_SAMPLES;

// Edge-case fixtures that share a variant with SAMPLES but exercise a different
// path through the serializer (optional ids, absent reason, control bytes).
const EDGE_CASES: readonly TmuxMessage[] = [
  // subscription-changed with every optional id absent (-1 → "-" on the wire).
  {
    type: "subscription-changed",
    name: "global",
    sessionId: -1,
    windowId: -1,
    windowIndex: -1,
    paneId: -1,
    value: "v",
  },
  // exit with no reason — serializes to a bare `%exit`.
  { type: "exit", reason: undefined },
  // output whose bytes need octal escaping: NUL, ESC, CR, backslash, high byte.
  {
    type: "output",
    paneId: 3,
    data: new Uint8Array([0x00, 0x1b, 0x0d, 0x5c, 0xff, 0x41]),
  },
  // empty output payload — serializes to a trailing-space-then-empty line.
  { type: "output", paneId: 3, data: new Uint8Array([]) },
];

describe("serializeMessage ↔ TmuxParser round trip", () => {
  for (const [type, sample] of Object.entries(SAMPLES)) {
    it(`round-trips ${type}`, () => {
      expect(roundTrip(sample)).toEqual(sample);
    });
  }

  for (const [i, sample] of EDGE_CASES.entries()) {
    it(`round-trips edge case #${i} (${sample.type})`, () => {
      expect(roundTrip(sample)).toEqual(sample);
    });
  }

  it("covers every TmuxMessage variant (compile-time enforced by the Record)", () => {
    // The Record<TmuxMessage["type"], …> type above is the real guarantee; this
    // runtime assertion documents the count so an accidental key drop is loud.
    expect(Object.keys(SAMPLES).length).toBeGreaterThanOrEqual(28);
  });
});

describe("encodeOctalEscapes is the exact inverse of decodeOctalEscapes", () => {
  it("round-trips every single byte value 0x00–0xFF", () => {
    const all = new Uint8Array(256);
    for (let b = 0; b < 256; b++) all[b] = b;
    expect(decodeOctalEscapes(encodeOctalEscapes(all))).toEqual(all);
  });

  it("escapes control bytes and backslash as three-digit octal, passes the rest literally", () => {
    expect(encodeOctalEscapes(new Uint8Array([0x00]))).toBe("\\000");
    expect(encodeOctalEscapes(new Uint8Array([0x1b]))).toBe("\\033");
    expect(encodeOctalEscapes(new Uint8Array([0x5c]))).toBe("\\134");
    expect(encodeOctalEscapes(new Uint8Array([0x41, 0x42]))).toBe("AB");
    // 0xFF passes through as a single Latin-1 code unit (not escaped).
    expect(encodeOctalEscapes(new Uint8Array([0xff]))).toBe("ÿ");
  });

  it("round-trips a random-ish payload of mixed printable and control bytes", () => {
    const bytes = new Uint8Array([
      0x48, 0x69, 0x0a, 0x1b, 0x5b, 0x33, 0x31, 0x6d, 0x5c, 0x00, 0xc3, 0xa9,
    ]);
    expect(decodeOctalEscapes(encodeOctalEscapes(bytes))).toEqual(bytes);
  });
});
