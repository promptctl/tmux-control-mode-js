// tests/unit/text-stream-sink.test.ts
// Behavior-level tests for createTextStreamSink — the streaming UTF-8
// decoder sink. Tests assert the contract: chunk-boundary multi-byte
// sequences decode correctly, each factory call produces an independent
// decoder, and end() flushes any held tail.
//
// [LAW:behavior-not-structure] These tests assert what the contract
// promises (correct streaming decode, per-instance state isolation,
// terminal flush behavior), not how the decoder is wired internally.

import { describe, expect, it } from "vitest";

import { createTextStreamSink } from "../../src/sinks/text-stream.js";
import type { PaneOutputMessage } from "../../src/protocol/types.js";

function msg(data: Uint8Array, paneId = 0): PaneOutputMessage {
  return { type: "output", paneId, data };
}

describe("createTextStreamSink", () => {
  it("decodes a multi-byte UTF-8 sequence split across chunks", () => {
    // 'é' is U+00E9 → UTF-8 [0xC3, 0xA9]. A non-streaming decoder per
    // chunk emits '�' for each half; the streaming decoder carries
    // the leading byte across the call and resolves on the second.
    const emissions: string[] = [];
    const sink = createTextStreamSink((text) => emissions.push(text));

    sink.write(msg(new Uint8Array([0xc3])));
    sink.write(msg(new Uint8Array([0xa9])));

    expect(emissions).toEqual(["", "é"]);
  });

  it("treats each factory call as an independent decoder", () => {
    // Each sink gets one half of what would be a valid multi-byte
    // sequence if they shared a decoder. With independent decoders,
    // sink A holds [0xC3] in stream state and sink B sees [0xA9] as
    // an orphan continuation byte — replacement character immediately.
    const a: string[] = [];
    const b: string[] = [];
    const sinkA = createTextStreamSink((text) => a.push(text));
    const sinkB = createTextStreamSink((text) => b.push(text));

    sinkA.write(msg(new Uint8Array([0xc3])));
    sinkB.write(msg(new Uint8Array([0xa9])));

    expect(a).toEqual([""]);
    expect(b).toEqual(["�"]);

    sinkA.end?.();
    sinkB.end?.();

    expect(a).toEqual(["", "�"]);
    expect(b).toEqual(["�", ""]);
  });

  it("flushes a trailing partial multi-byte sequence on end()", () => {
    const emissions: string[] = [];
    const sink = createTextStreamSink((text) => emissions.push(text));

    sink.write(msg(new Uint8Array([0xc3]))); // leading byte of 'é', no completion
    sink.end?.();

    expect(emissions).toEqual(["", "�"]);
  });
});
