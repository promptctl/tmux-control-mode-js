// tests/unit/bridge-cross-session-layout.test.ts
// The bridge's per-peer cross-session layout coverage: the shared client holds
// one relay reference per enabled peer, and event routing follows that set.

import { describe, it, expect, vi } from "vitest";

import { TmuxClient } from "../../src/client.js";
import type { TmuxTransport } from "../../src/transport/types.js";
import { createBridgeConnection } from "../../src/connectors/bridge-connection.js";
import { dispatchBridgeRequest } from "../../src/connectors/bridge-dispatch.js";
import { parseRpcRequest, RpcError } from "../../src/connectors/rpc.js";
import type { CrossSessionLayoutChangeMessage } from "../../src/cross-session-layout.js";
import type { EmitterMessage } from "../../src/emitter.js";

function makeBridge() {
  const transport: TmuxTransport = {
    send: () => ({ ok: true }),
    onData() {},
    onClose() {},
    close() {},
  };
  const client = new TmuxClient(transport);
  const enable = vi
    .spyOn(client, "enableCrossSessionLayoutChange")
    .mockResolvedValue(undefined);
  const disable = vi
    .spyOn(client, "disableCrossSessionLayoutChange")
    .mockResolvedValue(undefined);
  const bridge = createBridgeConnection({
    client,
    reportResumeFailure: () => undefined,
  });
  return { client, bridge, enable, disable };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

const change: CrossSessionLayoutChangeMessage = {
  type: "cross-session-layout-change",
  sessionId: 1,
  windowId: 7,
  windowLayout: "b25d,80x24,0,0,0",
  windowVisibleLayout: "b25d,80x24,0,0,0",
  windowFlags: "*",
};

const relayFrame: EmitterMessage = {
  type: "subscription-changed",
  name: "ttcmjs-cross-session-layout",
  sessionId: 1,
  windowId: 0,
  windowIndex: 0,
  paneId: 0,
  value: "1:@7,",
} as EmitterMessage;

describe("BridgeConnection — cross-session layout coverage", () => {
  it("holds one client reference per enabled peer, however often it enables", async () => {
    const { bridge, enable, disable } = makeBridge();
    const a = bridge.registerPeer();
    const b = bridge.registerPeer();
    await bridge.enableCrossSessionLayoutForPeer(a);
    await bridge.enableCrossSessionLayoutForPeer(a);
    await bridge.enableCrossSessionLayoutForPeer(b);
    expect(enable).toHaveBeenCalledTimes(2);

    await bridge.disableCrossSessionLayoutForPeer(a);
    await bridge.disableCrossSessionLayoutForPeer(a);
    expect(disable).toHaveBeenCalledTimes(1);
  });

  it("gives a removed peer's reference back, including one still enabling", async () => {
    const { bridge, enable, disable } = makeBridge();
    let resolveEnable!: () => void;
    enable.mockReturnValueOnce(
      new Promise<void>((r) => {
        resolveEnable = r;
      }),
    );
    const peer = bridge.registerPeer();
    void bridge.enableCrossSessionLayoutForPeer(peer);
    bridge.removePeer(peer);
    await flush();
    expect(disable).not.toHaveBeenCalled();
    resolveEnable();
    await flush();
    expect(disable).toHaveBeenCalledTimes(1);
  });

  it("a rejected enable leaves the peer holding nothing", async () => {
    const { bridge, enable, disable } = makeBridge();
    enable.mockRejectedValueOnce(new Error("tmux said no"));
    const peer = bridge.registerPeer();
    await expect(bridge.enableCrossSessionLayoutForPeer(peer)).rejects.toThrow(
      "tmux said no",
    );
    expect(bridge.deliversEvent(peer, change)).toBe(false);
    bridge.removePeer(peer);
    await flush();
    expect(disable).not.toHaveBeenCalled();
  });

  it("routes decoded events only to enabled peers and the relay's raw frames to none", async () => {
    const { bridge } = makeBridge();
    const on = bridge.registerPeer();
    const off = bridge.registerPeer();
    await bridge.enableCrossSessionLayoutForPeer(on);

    expect(bridge.deliversEvent(on, change)).toBe(true);
    expect(bridge.deliversEvent(off, change)).toBe(false);
    expect(bridge.deliversEvent(on, relayFrame)).toBe(false);
    expect(bridge.deliversEvent(off, relayFrame)).toBe(false);
    const ordinary = { ...relayFrame, name: "mine" } as EmitterMessage;
    expect(bridge.deliversEvent(off, ordinary)).toBe(true);

    await bridge.disableCrossSessionLayoutForPeer(on);
    expect(bridge.deliversEvent(on, change)).toBe(false);
  });

  it("enable/disable over RPC route through the peer's ledger and answer null", async () => {
    const { client, bridge, enable, disable } = makeBridge();
    const peer = bridge.registerPeer();
    const call = (method: string) =>
      dispatchBridgeRequest(
        bridge,
        client,
        peer,
        parseRpcRequest({ method, args: [] }),
      );
    expect(await call("enableCrossSessionLayoutChange")).toEqual({
      kind: "ok",
      response: null,
    });
    expect(bridge.deliversEvent(peer, change)).toBe(true);
    expect(await call("disableCrossSessionLayoutChange")).toEqual({
      kind: "ok",
      response: null,
    });
    expect(enable).toHaveBeenCalledTimes(1);
    expect(disable).toHaveBeenCalledTimes(1);
  });

  it("a peer cannot subscribe or unsubscribe the relay's reserved name", () => {
    for (const req of [
      {
        method: "subscribeRaw",
        args: ["ttcmjs-cross-session-layout", "", "#{x}"],
      },
      { method: "unsubscribe", args: ["ttcmjs-cross-session-layout"] },
    ]) {
      expect(() => parseRpcRequest(req)).toThrow(RpcError);
      expect(() => parseRpcRequest(req)).toThrow(/reserved/);
    }
  });

  it("refuses an enable for a removed peer, so no reference leaks past teardown", async () => {
    const { bridge, enable } = makeBridge();
    const peer = bridge.registerPeer();
    bridge.removePeer(peer);
    await expect(
      bridge.enableCrossSessionLayoutForPeer(peer),
    ).rejects.toMatchObject({ code: "BRIDGE_INTERNAL" });
    expect(enable).not.toHaveBeenCalled();
  });

  it("keeps delivering until the disable settles, then counts the peer disabled even if tmux refused", async () => {
    const { bridge, disable } = makeBridge();
    let refuse!: (e: Error) => void;
    disable.mockReturnValue(new Promise<void>((_, rej) => (refuse = rej)));
    const peer = bridge.registerPeer();
    await bridge.enableCrossSessionLayoutForPeer(peer);

    const disabling = bridge.disableCrossSessionLayoutForPeer(peer);
    await flush();
    expect(bridge.deliversEvent(peer, change)).toBe(true);

    refuse(new Error("tmux refused"));
    await expect(disabling).rejects.toThrow("tmux refused");
    expect(bridge.deliversEvent(peer, change)).toBe(false);
    // The relay already has the reference back: a retry gives nothing back twice.
    await bridge.disableCrossSessionLayoutForPeer(peer);
    expect(disable).toHaveBeenCalledTimes(1);
  });
});
