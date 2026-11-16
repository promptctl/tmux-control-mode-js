// tests/unit/ws-handshake.test.ts
// Unit tests for the Handshake collaborator extracted from Connection.
import { describe, it, expect, vi, afterEach } from "vitest";
import { Handshake } from "../../src/connectors/websocket/handshake.js";
import {
  BridgeError,
  parseDurationMs,
} from "../../src/connectors/websocket/protocol.js";

afterEach(() => {
  vi.useRealTimers();
});

const acceptAll = () => ({ ok: true as const, identity: undefined });

// The handshake only accepts a stamped deadline; tests go through the same
// parser the bridge does.
const ms = (n: number) => parseDurationMs("helloTimeoutMs", n);

describe("Handshake — hello timeout", () => {
  it("fires onTimeout when hello is not received in time", () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const hs = new Handshake(ms(100), undefined, acceptAll);
    hs.arm(onTimeout);
    vi.advanceTimersByTime(100);
    expect(onTimeout).toHaveBeenCalledOnce();
  });

  it("clear() prevents onTimeout from firing", () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const hs = new Handshake(ms(100), undefined, acceptAll);
    hs.arm(onTimeout);
    hs.clear();
    vi.advanceTimersByTime(100);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("clear() before arm() is a no-op (does not throw)", () => {
    const hs = new Handshake(ms(100), undefined, acceptAll);
    expect(() => hs.clear()).not.toThrow();
  });
});

describe("Handshake — authenticate()", () => {
  it("passes the result from the auth hook through", async () => {
    const hook = vi.fn().mockResolvedValue({ ok: true, identity: "user-42" });
    const hs = new Handshake(
      ms(100),
      { headers: { authorization: "Bearer t" } },
      hook,
    );
    const result = await hs.authenticate();
    expect(result).toEqual({ ok: true, identity: "user-42" });
    expect(hook).toHaveBeenCalledWith({
      headers: { authorization: "Bearer t" },
    });
  });

  it("supplies empty request to hook when no request is provided", async () => {
    const hook = vi.fn().mockResolvedValue({ ok: true, identity: undefined });
    const hs = new Handshake(ms(100), undefined, hook);
    await hs.authenticate();
    expect(hook).toHaveBeenCalledWith({ headers: {} });
  });

  it("maps an auth hook's denial naming no code to close code 4401", async () => {
    const hook = vi
      .fn()
      .mockResolvedValue({ ok: false, reason: "token expired" });
    const hs = new Handshake(ms(100), undefined, hook);
    const result = await hs.authenticate();
    expect(result).toEqual({
      ok: false,
      errorCode: "BRIDGE_AUTH_DENIED",
      closeCode: 4401,
      reason: "token expired",
    });
  });

  it("keeps a sendable close code an auth hook's denial names", async () => {
    const hook = vi
      .fn()
      .mockResolvedValue({ ok: false, reason: "policy", code: 1008 });
    const hs = new Handshake(ms(100), undefined, hook);
    const result = await hs.authenticate();
    expect(result).toEqual({
      ok: false,
      errorCode: "BRIDGE_AUTH_DENIED",
      closeCode: 1008,
      reason: "policy",
    });
  });

  it("a hook that throws is a fault, not a denial: BRIDGE_INTERNAL under 1011, which a client retries", async () => {
    const hook = vi.fn().mockRejectedValue(new Error("db down"));
    const hs = new Handshake(ms(100), undefined, hook);
    const result = await hs.authenticate();
    expect(result).toMatchObject({
      ok: false,
      errorCode: "BRIDGE_INTERNAL",
      closeCode: 1011,
      reason: expect.stringContaining("db down"),
    });
  });

  it("a denial naming a code the socket may not send closes 4401, naming the value", async () => {
    const hook = vi
      .fn()
      .mockResolvedValue({ ok: false, reason: "policy", code: 1005 });
    const hs = new Handshake(ms(100), undefined, hook);
    const result = await hs.authenticate();
    expect(result).toMatchObject({
      ok: false,
      errorCode: "BRIDGE_AUTH_DENIED",
      closeCode: 4401,
      reason: expect.stringContaining("1005"),
    });
  });

  it("a hook that throws a BridgeError is reported under BRIDGE_INTERNAL, its message carried without its own code", async () => {
    const hook = vi
      .fn()
      .mockRejectedValue(new BridgeError("BRIDGE_TIMEOUT", "auth backend"));
    const hs = new Handshake(ms(100), undefined, hook);
    const result = await hs.authenticate();
    expect(result).toMatchObject({
      ok: false,
      errorCode: "BRIDGE_INTERNAL",
      reason: "authenticate failed: auth backend",
    });
  });

  it("wraps a non-Error throw into ok:false", async () => {
    const hook = vi.fn().mockRejectedValue("string throw");
    const hs = new Handshake(ms(100), undefined, hook);
    const result = await hs.authenticate();
    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining("string throw"),
    });
  });
});
