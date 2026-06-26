// tests/unit/ws-handshake.test.ts
// Unit tests for the Handshake collaborator extracted from Connection.
import { describe, it, expect, vi, afterEach } from "vitest";
import { Handshake } from "../../src/connectors/websocket/handshake.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("Handshake — hello timeout", () => {
  it("fires onTimeout when hello is not received in time", () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const hs = new Handshake(100, undefined, undefined);
    hs.arm(onTimeout);
    vi.advanceTimersByTime(100);
    expect(onTimeout).toHaveBeenCalledOnce();
  });

  it("clear() prevents onTimeout from firing", () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const hs = new Handshake(100, undefined, undefined);
    hs.arm(onTimeout);
    hs.clear();
    vi.advanceTimersByTime(100);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("clear() before arm() is a no-op (does not throw)", () => {
    const hs = new Handshake(100, undefined, undefined);
    expect(() => hs.clear()).not.toThrow();
  });
});

describe("Handshake — authenticate()", () => {
  it("returns ok:true when no auth hook is configured", async () => {
    const hs = new Handshake(100, undefined, undefined);
    const result = await hs.authenticate();
    expect(result).toEqual({ ok: true, identity: undefined });
  });

  it("passes the result from the auth hook through", async () => {
    const hook = vi.fn().mockResolvedValue({ ok: true, identity: "user-42" });
    const hs = new Handshake(100, { headers: { authorization: "Bearer t" } }, hook);
    const result = await hs.authenticate();
    expect(result).toEqual({ ok: true, identity: "user-42" });
    expect(hook).toHaveBeenCalledWith({ headers: { authorization: "Bearer t" } });
  });

  it("supplies empty request to hook when no request is provided", async () => {
    const hook = vi.fn().mockResolvedValue({ ok: true, identity: undefined });
    const hs = new Handshake(100, undefined, hook);
    await hs.authenticate();
    expect(hook).toHaveBeenCalledWith({ headers: {} });
  });

  it("maps an auth hook that returns ok:false straight through", async () => {
    const hook = vi.fn().mockResolvedValue({ ok: false, reason: "token expired" });
    const hs = new Handshake(100, undefined, hook);
    const result = await hs.authenticate();
    expect(result).toEqual({ ok: false, reason: "token expired" });
  });

  it("wraps a thrown error from the hook into ok:false", async () => {
    const hook = vi.fn().mockRejectedValue(new Error("db down"));
    const hs = new Handshake(100, undefined, hook);
    const result = await hs.authenticate();
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("db down") });
  });

  it("wraps a non-Error throw into ok:false", async () => {
    const hook = vi.fn().mockRejectedValue("string throw");
    const hs = new Handshake(100, undefined, hook);
    const result = await hs.authenticate();
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("string throw") });
  });
});
