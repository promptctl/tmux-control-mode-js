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
// Status: RED (intentional). Requires:
//   - tmux-pane-terminal-8w9.4 (PaneStream — output→sink path)
//   - tmux-pane-terminal-8w9.5 (TerminalSink.write(Uint8Array) — must accept
//     bytes without decoding).

import { describe, it, expect } from "vitest";
import { FakeTmuxClient } from "../../src/bench/index.js";

describe("Gate 5 — non-UTF8 byte fidelity", () => {
  it("mouse-report bytes arrive at the sink byte-identical", () => {
    const client = new FakeTmuxClient();
    const mouseReport = new Uint8Array([
      0x1b, 0x5b, 0x3c, 0x30, 0x3b, 0x34, 0x32, 0x3b, 0x31, 0x33, 0x4d,
    ]);
    void client;
    void mouseReport;
    expect.fail(
      "gate stub: requires PaneStream + TerminalSink (8w9.4/5). " +
        "Assertion shape: capture sink.write() args, expect first call's " +
        "Uint8Array to equal the injected mouseReport byte-for-byte.",
    );
  });

  it("raw 8-bit bytes (0x80..0xFF) round-trip without U+FFFD substitution", () => {
    const client = new FakeTmuxClient();
    const highBytes = new Uint8Array(128);
    for (let i = 0; i < 128; i++) highBytes[i] = 0x80 + i;
    void client;
    void highBytes;
    expect.fail("gate stub: same shape as the mouse-report case.");
  });
});
