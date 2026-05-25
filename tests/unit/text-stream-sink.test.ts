// tests/unit/text-stream-sink.test.ts
// Behavior-level tests for createTextStreamSink — the streaming UTF-8
// decoder sink. Tests assert the contract published in
// src/sinks/text-stream.ts: chunk-boundary multi-byte sequences decode
// correctly, each factory call produces an independent decoder, and
// end() flushes any held tail.
//
// [LAW:behavior-not-structure] These tests assert what the contract
// promises (correct streaming decode, per-instance state isolation,
// terminal flush behavior), not how the decoder is wired internally.

import { describe, expect, it } from "vitest";

import { createTextStreamSink } from "../../src/sinks/text-stream.js";

describe("createTextStreamSink", () => {
  it("decodes a multi-byte UTF-8 sequence split across chunks", () => {
    // 'é' is U+00E9 → UTF-8 [0xC3, 0xA9]. A non-streaming decoder per
    // chunk emits '�' for each half; the streaming decoder carries
    // the leading byte across the call and resolves on the second.
    const emissions: string[] = [];
    const sink = createTextStreamSink((text) => emissions.push(text));

    sink.write(new Uint8Array([0xc3]));
    sink.write(new Uint8Array([0xa9]));

    expect(emissions).toEqual(["", "é"]);
  });

  it("treats each factory call as an independent decoder", () => {
    // Each sink gets one half of what would be a valid multi-byte
    // sequence *if they shared a decoder*. With independent decoders
    // (the contract), sink A holds [0xC3] in stream state and sink B
    // sees [0xA9] as an orphan continuation byte — surfaced
    // immediately as the replacement character. Neither sequence
    // completes; cross-contamination is structurally impossible
    // because the decoders cannot meet.
    const a: string[] = [];
    const b: string[] = [];
    const sinkA = createTextStreamSink((text) => a.push(text));
    const sinkB = createTextStreamSink((text) => b.push(text));

    sinkA.write(new Uint8Array([0xc3]));
    sinkB.write(new Uint8Array([0xa9]));

    expect(a).toEqual([""]);
    expect(b).toEqual(["�"]);

    // Flushing surfaces sink A's held tail as the replacement
    // character; sink B has nothing held, so its flush yields "".
    sinkA.end?.();
    sinkB.end?.();

    expect(a).toEqual(["", "�"]);
    expect(b).toEqual(["�", ""]);
  });

  it("flushes a trailing partial multi-byte sequence on end()", () => {
    // Standard TextDecoder behavior: terminating the stream with a
    // held partial sequence surfaces it as '�'. The sink forwards
    // that final string to the handler like any other decode result.
    const emissions: string[] = [];
    const sink = createTextStreamSink((text) => emissions.push(text));

    sink.write(new Uint8Array([0xc3])); // leading byte of 'é', no completion
    sink.end?.();

    expect(emissions).toEqual(["", "�"]);
  });
});
