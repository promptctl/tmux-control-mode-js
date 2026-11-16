// tests/unit/websocket-pane-output-codec.test.ts
// The pane-output binary frame codec (`encodePaneOutput` / `decodePaneOutput`).
//
// What the contract promises:
//   - The encoder and decoder accept exactly the same frame set: every chunk
//     the encoder writes decodes back to the same paneId and bytes, and every
//     frame the encoder cannot write is rejected with BridgeProtocolError.
//
// [LAW:one-source-of-truth] The round trip proves every frame the encoder
//   writes is read back; the flags-byte sweep proves the decoder reads nothing
//   more. A decoder variant with no encoder fails the sweep.

import { describe, expect, it } from "vitest";

import {
  BridgeProtocolError,
  decodePaneOutput,
  encodePaneOutput,
} from "../../src/connectors/websocket/index.js";

describe("pane-output frame codec", () => {
  it.each([
    { name: "typical bytes", paneId: 42, data: [0x00, 0x7f, 0x80, 0xff] },
    { name: "empty data", paneId: 1, data: [] },
    { name: "paneId 0", paneId: 0, data: [0x61] },
    { name: "max uint32 paneId", paneId: 0xffffffff, data: [0x61] },
  ])("round-trips $name", ({ paneId, data }) => {
    const decoded = decodePaneOutput(
      encodePaneOutput({ paneId, data: new Uint8Array(data) }),
    );
    expect(decoded).toEqual({
      type: "output",
      paneId,
      data: new Uint8Array(data),
    });
  });

  it("rejects every nonzero flags byte, including the former extended layout", () => {
    const frame = encodePaneOutput({
      paneId: 1,
      data: new Uint8Array([0, 0, 0, 100, 0x61]),
    });
    for (let flags = 1; flags <= 0xff; flags++) {
      frame[1] = flags;
      expect(() => decodePaneOutput(frame)).toThrow(BridgeProtocolError);
    }
  });

  it("rejects a frame shorter than its header", () => {
    const frame = encodePaneOutput({ paneId: 1, data: new Uint8Array() });
    expect(() => decodePaneOutput(frame.subarray(0, 5))).toThrow(
      BridgeProtocolError,
    );
  });

  it("rejects a frame with the wrong magic byte", () => {
    const frame = encodePaneOutput({ paneId: 1, data: new Uint8Array() });
    frame[0] = 0x7e;
    expect(() => decodePaneOutput(frame)).toThrow(BridgeProtocolError);
  });
});
