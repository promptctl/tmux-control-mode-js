// tests/unit/connectors-errors.test.ts
// Contract tests for the shared bridge-error module
// (src/connectors/errors.ts).
//
// These tests freeze the cross-transport behavior the Electron and WebSocket
// connectors rely on: payload round-tripping with code preservation,
// `[CODE]` prefix on Error.message, instance identity. If a future refactor
// re-declares `BridgeError` in either connector, the import-equality test
// fails immediately rather than silently shadowing the canonical class.

import { describe, expect, it } from "vitest";

import {
  BridgeError,
  BridgeProtocolError,
  type BridgeErrorPayload,
} from "../../src/connectors/errors.js";

describe("connectors/errors — BridgeError shape", () => {
  it("Error.message carries the [CODE] prefix for ad-hoc logging", () => {
    const e = new BridgeError("BRIDGE_TIMEOUT", "deadline reached");
    expect(e.code).toBe("BRIDGE_TIMEOUT");
    expect(e.message).toBe("[BRIDGE_TIMEOUT] deadline reached");
    expect(e.name).toBe("BridgeError");
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(BridgeError);
  });

  it("toPayload strips the prefix so wire messages stay code-free", () => {
    const e = new BridgeError("BRIDGE_INVALID_ARG", "bad arg");
    const p = e.toPayload();
    expect(p).toEqual({ code: "BRIDGE_INVALID_ARG", message: "bad arg" });
  });

  it("fromPayload reconstructs a typed BridgeError with the original code", () => {
    const p: BridgeErrorPayload = {
      code: "BRIDGE_AUTH_DENIED",
      message: "token rejected",
    };
    const e = BridgeError.fromPayload(p);
    expect(e).toBeInstanceOf(BridgeError);
    expect(e.code).toBe("BRIDGE_AUTH_DENIED");
    expect(e.message).toBe("[BRIDGE_AUTH_DENIED] token rejected");
  });

  it("payload round-trip is idempotent — no double-prefixing through fromPayload(toPayload)", () => {
    // Regression: if `toPayload` left the prefix in `message`, then
    // `fromPayload` would re-prepend it, producing
    // `[CODE] [CODE] reason` after a single round trip.
    const original = new BridgeError("BRIDGE_CLOSED", "client is closed");
    const restored = BridgeError.fromPayload(original.toPayload());
    expect(restored.message).toBe(original.message);
    expect(restored.code).toBe(original.code);
  });
});

describe("connectors/errors — BridgeProtocolError", () => {
  it("is a BridgeError with code BRIDGE_PROTOCOL_ERROR", () => {
    const e = new BridgeProtocolError("malformed frame");
    expect(e).toBeInstanceOf(BridgeError);
    expect(e).toBeInstanceOf(BridgeProtocolError);
    expect(e.code).toBe("BRIDGE_PROTOCOL_ERROR");
    expect(e.name).toBe("BridgeProtocolError");
  });
});

describe("connectors/errors — single source of truth", () => {
  it("electron and websocket modules re-export the SAME BridgeError class", async () => {
    // [LAW:one-source-of-truth] If either side reintroduces a parallel
    // class declaration, this check fails because the constructor identity
    // diverges. The WeakSet of `instanceof` checks downstream depends on
    // class identity — drift would silently break consumer
    // `e instanceof BridgeError && e.code === "X"` tests in production.
    const electronTypes = await import(
      "../../src/connectors/electron/types.js"
    );
    const websocketProtocol = await import(
      "../../src/connectors/websocket/protocol.js"
    );

    expect(electronTypes.BridgeError).toBe(BridgeError);
    expect(websocketProtocol.BridgeError).toBe(BridgeError);
    expect(websocketProtocol.BridgeProtocolError).toBe(BridgeProtocolError);
  });
});
