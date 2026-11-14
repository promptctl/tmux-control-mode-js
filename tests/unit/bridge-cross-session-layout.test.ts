// tests/unit/bridge-cross-session-layout.test.ts
// The bridge's per-peer cross-session layout coverage: the shared client holds
// one relay reference per enabled peer, and event routing follows that set.

import { describe, it, expect, vi } from "vitest";

import { TmuxClient } from "../../src/client.js";
import { TmuxCommandError, TransportClosedError } from "../../src/errors.js";
import type { BridgeError } from "../../src/connectors/errors.js";
import type { TmuxTransport } from "../../src/transport/types.js";
import {
  createBridgeConnection,
  type BridgeConnection,
} from "../../src/connectors/bridge-connection.js";
import type { Peer } from "../../src/connectors/bridge-peer.js";
import { dispatchBridgeRequest } from "../../src/connectors/bridge-dispatch.js";
import { parseRpcRequest, RpcError } from "../../src/connectors/rpc.js";
import type { CrossSessionLayoutChangeMessage } from "../../src/cross-session-layout.js";
import type { EmitterMessage } from "../../src/emitter.js";
import { windowLayoutFields } from "../../src/protocol/layout.js";

function makeBridge(forwardsLifecycle = false) {
  const releaseFailures: BridgeError[] = [];
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
    forwardsLifecycle,
    reportResumeFailure: () => undefined,
    reportCoverageReleaseFailure: (e) => releaseFailures.push(e),
  });
  return { client, bridge, enable, disable, releaseFailures };
}

function delivers(
  bridge: BridgeConnection,
  peer: Peer,
  msg: EmitterMessage,
): boolean {
  return bridge.deliversTo(peer, bridge.routeEvent(msg));
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

const change: CrossSessionLayoutChangeMessage = {
  type: "cross-session-layout-change",
  sessionId: 1,
  windowId: 7,
  ...windowLayoutFields("b25d,80x24,0,0,0", "b25d,80x24,0,0,0", "*"),
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
  it("holds one client reference per peer with enables outstanding, counted per call", async () => {
    const { bridge, enable, disable } = makeBridge();
    const a = bridge.registerPeer();
    const b = bridge.registerPeer();
    await bridge.enableCrossSessionLayoutForPeer(a);
    await bridge.enableCrossSessionLayoutForPeer(a);
    await bridge.enableCrossSessionLayoutForPeer(b);
    expect(enable).toHaveBeenCalledTimes(2);

    // Like TmuxClient: two enables need two disables.
    await bridge.disableCrossSessionLayoutForPeer(a);
    expect(disable).not.toHaveBeenCalled();
    expect(delivers(bridge, a, change)).toBe(true);
    await bridge.disableCrossSessionLayoutForPeer(a);
    expect(disable).toHaveBeenCalledTimes(1);
    expect(delivers(bridge, a, change)).toBe(false);
    // A surplus disable is a no-op.
    await bridge.disableCrossSessionLayoutForPeer(a);
    expect(disable).toHaveBeenCalledTimes(1);
  });

  it("the peer's last call wins however enable and disable interleave", async () => {
    const { bridge, enable, disable } = makeBridge();
    const gates: (() => void)[] = [];
    const gated = (): Promise<void> => new Promise<void>((r) => gates.push(r));
    enable.mockImplementation(gated);
    disable.mockImplementation(gated);
    const peer = bridge.registerPeer();
    const calls = [
      bridge.enableCrossSessionLayoutForPeer(peer),
      bridge.disableCrossSessionLayoutForPeer(peer),
      bridge.enableCrossSessionLayoutForPeer(peer),
      bridge.disableCrossSessionLayoutForPeer(peer),
    ];
    for (let i = 0; i < 20; i++) {
      await flush();
      gates.shift()?.();
    }
    await Promise.all(calls);
    expect(delivers(bridge, peer, change)).toBe(false);
    expect(enable.mock.calls.length).toBe(disable.mock.calls.length);
  });

  it("routes lifecycle events only on transports that forward them, reply-stream reports on every transport, and topology-error nowhere", () => {
    const lifecycle = [
      { type: "reconnected" },
      { type: "connection-state", state: { status: "ready" } },
    ] as EmitterMessage[];
    const replyStream = [
      {
        type: "protocol-error",
        kind: "terminator",
        commandNumber: 3,
        line: "%end 1",
      },
      {
        type: "unsolicited-response",
        response: { commandNumber: 4, timestamp: 1, output: [], success: true },
      },
    ] as EmitterMessage[];
    const topology = { type: "topology-error" } as EmitterMessage;
    for (const forwards of [false, true]) {
      const { bridge } = makeBridge(forwards);
      const peer = bridge.registerPeer();
      for (const msg of lifecycle)
        expect(delivers(bridge, peer, msg)).toBe(forwards);
      for (const msg of replyStream)
        expect(delivers(bridge, peer, msg)).toBe(true);
      expect(delivers(bridge, peer, topology)).toBe(false);
    }
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
    await flush();
    expect(enable).toHaveBeenCalledTimes(1);
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
    expect(delivers(bridge, peer, change)).toBe(false);
    bridge.removePeer(peer);
    await flush();
    expect(disable).not.toHaveBeenCalled();
  });

  it("routes decoded events only to enabled peers and the relay's raw frames to none", async () => {
    const { bridge } = makeBridge();
    const on = bridge.registerPeer();
    const off = bridge.registerPeer();
    await bridge.enableCrossSessionLayoutForPeer(on);

    expect(delivers(bridge, on, change)).toBe(true);
    expect(delivers(bridge, off, change)).toBe(false);
    expect(delivers(bridge, on, relayFrame)).toBe(false);
    expect(delivers(bridge, off, relayFrame)).toBe(false);
    const ordinary = { ...relayFrame, name: "mine" } as EmitterMessage;
    expect(delivers(bridge, off, ordinary)).toBe(true);

    await bridge.disableCrossSessionLayoutForPeer(on);
    expect(delivers(bridge, on, change)).toBe(false);
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
    expect(delivers(bridge, peer, change)).toBe(true);
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

  it("stops delivering at the disable, and reports a refused cleanup without leaving the peer enabled", async () => {
    const { bridge, disable } = makeBridge();
    let refuse!: (e: Error) => void;
    disable.mockReturnValue(new Promise<void>((_, rej) => (refuse = rej)));
    const peer = bridge.registerPeer();
    await bridge.enableCrossSessionLayoutForPeer(peer);

    const disabling = bridge.disableCrossSessionLayoutForPeer(peer);
    expect(delivers(bridge, peer, change)).toBe(false);

    refuse(new Error("tmux refused"));
    await expect(disabling).rejects.toThrow("tmux refused");
    // The relay already has the reference back: a retry gives nothing back twice.
    await bridge.disableCrossSessionLayoutForPeer(peer);
    expect(disable).toHaveBeenCalledTimes(1);
  });

  it("reports a departed peer's release that a live tmux refused, and stays quiet when the connection is gone", async () => {
    const { bridge, disable, releaseFailures } = makeBridge();
    const refused = bridge.registerPeer();
    const gone = bridge.registerPeer();
    await bridge.enableCrossSessionLayoutForPeer(refused);
    await bridge.enableCrossSessionLayoutForPeer(gone);

    disable.mockRejectedValueOnce(
      new TmuxCommandError({
        success: false,
        output: ["no such hook"],
      } as never),
    );
    bridge.removePeer(refused);
    await flush();
    disable.mockRejectedValueOnce(new TransportClosedError("closed"));
    bridge.removePeer(gone);
    await flush();

    expect(releaseFailures.map((e) => e.code)).toEqual(["TMUX_ERROR"]);
  });
});
