// packages/pane-terminal/tests/unit/g5-non-utf8-fidelity.test.ts
//
// GATE 5 — Non-UTF8 bytes round-trip byte-identical through the live path.
//
// Mouse reports (`\x1b[<0;42;13M`), raw 8-bit codes (0x80–0xFF), and CSI
// binary parameters must reach the sink as the exact same Uint8Array bytes
// the FakeTmuxClient injected. Any TextDecoder('utf-8') in the pipeline
// would replace high-bytes with U+FFFD (`0xEF 0xBF 0xBD`) and corrupt mouse
// input — this gate ensures O3 ("zero decoding in pipeline") is honoured.
//
// Status: GREEN as of 8w9.4. PaneStream forwards `OutputMessage.data` to
// `TerminalSink.write` without copy or decode; the inline `CapturingSink`
// below records each call's `Uint8Array` reference and asserts byte-identity.

import { describe, it, expect, beforeEach } from "vitest";
import { FakeTmuxClient } from "../../src/bench/index.js";
import { PaneStream } from "../../src/stream/index.js";
import type { PaneStreamClient, TerminalSink } from "../../src/stream/index.js";
import type { SeedCursor } from "../../src/sink/index.js";

// Minimal collector — gate 5's contract is "what arrived at the sink",
// nothing else. BufferingSink (8w9.5) will replace this in tests that need
// scrollback semantics; gate 5 needs only the byte capture.
class CapturingSink implements TerminalSink {
  readonly writes: Uint8Array[] = [];
  seed(_text: string, _cursor: SeedCursor | null): void {
    /* no-op for this gate */
  }
  write(bytes: Uint8Array): void {
    this.writes.push(bytes);
  }
  resize(_cols: number, _rows: number): void {
    /* no-op */
  }
  dispose(): void {
    /* no-op */
  }
}

const PANE_ID = 1;

function attachLiveStream(
  client: FakeTmuxClient,
  sink: CapturingSink,
): PaneStream {
  // Empty capture-pane response so seed completes immediately. After
  // attach, the stream flushes the buffer and flips to live; subsequent
  // injectOutput chunks land in sink.write directly.
  client.setCapturePaneResponse(() => "");
  const stream = new PaneStream({
    client: client as unknown as PaneStreamClient,
    paneId: PANE_ID,
  });
  stream.attach(sink);
  return stream;
}

async function flushSeed(): Promise<void> {
  // FakeTmuxClient.execute resolves on next macrotask; await two ticks so
  // both Promise.all branches settle and PaneStream's seed() resumes.
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

describe("Gate 5 — non-UTF8 byte fidelity", () => {
  let client: FakeTmuxClient;
  let sink: CapturingSink;
  let stream: PaneStream;

  beforeEach(async () => {
    client = new FakeTmuxClient();
    sink = new CapturingSink();
    stream = attachLiveStream(client, sink);
    await flushSeed();
  });

  it("mouse-report bytes arrive at the sink byte-identical", () => {
    const mouseReport = new Uint8Array([
      0x1b, 0x5b, 0x3c, 0x30, 0x3b, 0x34, 0x32, 0x3b, 0x31, 0x33, 0x4d,
    ]);

    client.injectOutput(PANE_ID, mouseReport);

    expect(sink.writes).toHaveLength(1);
    expect(sink.writes[0]).toEqual(mouseReport);
    // Identity check too: PaneStream must forward by reference, not copy
    // (O3 — zero allocation in the live path).
    expect(sink.writes[0]).toBe(mouseReport);

    stream.dispose();
  });

  it("raw 8-bit bytes (0x80..0xFF) round-trip without U+FFFD substitution", () => {
    const highBytes = new Uint8Array(128);
    for (let i = 0; i < 128; i++) highBytes[i] = 0x80 + i;

    client.injectOutput(PANE_ID, highBytes);

    expect(sink.writes).toHaveLength(1);
    // Byte-identity is the load-bearing assertion: any TextDecoder('utf-8')
    // in the pipeline would replace lone continuation bytes (e.g. 0x80
    // without a leader) with 0xEF 0xBF 0xBD (U+FFFD), and the output array
    // would no longer equal the input. toEqual checks every byte index.
    expect(sink.writes[0]).toEqual(highBytes);
    expect(sink.writes[0].byteLength).toBe(highBytes.byteLength);

    stream.dispose();
  });

  it("CSI binary parameter bytes pass through without being interpreted", () => {
    // CSI ? 0x80 0xFF h — a private-use sequence with raw 8-bit params.
    // This isn't valid UTF-8 anywhere; if the pipeline decodes it we'll
    // see U+FFFD substitutions corrupting the binary params.
    const csiBinary = new Uint8Array([0x1b, 0x5b, 0x3f, 0x80, 0xff, 0x68]);

    client.injectOutput(PANE_ID, csiBinary);

    expect(sink.writes).toHaveLength(1);
    expect(sink.writes[0]).toEqual(csiBinary);

    stream.dispose();
  });

  it("multi-chunk dispatch preserves chunk boundaries", () => {
    const chunks = [
      new Uint8Array([0x1b, 0x5b]),
      new Uint8Array([0x33, 0x31, 0x6d]),
      new Uint8Array([0xff, 0x80, 0xc2]),
    ];

    for (const c of chunks) client.injectOutput(PANE_ID, c);

    expect(sink.writes).toHaveLength(chunks.length);
    for (let i = 0; i < chunks.length; i++) {
      expect(sink.writes[i]).toBe(chunks[i]);
    }

    stream.dispose();
  });

  it("output for other panes does NOT reach this sink", () => {
    const other = new Uint8Array([0x41, 0x42, 0x43]);
    client.injectOutput(PANE_ID + 1, other);
    expect(sink.writes).toHaveLength(0);
    stream.dispose();
  });
});
