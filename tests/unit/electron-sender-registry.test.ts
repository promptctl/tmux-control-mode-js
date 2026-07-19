// tests/unit/electron-sender-registry.test.ts
// Isolation tests for SenderRegistry — the per-sender lifecycle collaborator
// extracted from createMainBridge (GM3). Every dependency (bridge, client) is
// constructor-injected, so the registry is driven directly here against spies,
// with no ipcMain and no TmuxClient. The end-to-end behavior through the shell
// is covered by electron-bridge.test.ts; these assert the seam in isolation.

import { describe, expect, it, vi } from "vitest";

import type {
  BridgeConnection,
  Peer,
} from "../../src/connectors/bridge-connection.js";
import type { TmuxClient } from "../../src/client.js";
import type {
  AttachOptions,
  BytesSink,
  ChunkPayload,
} from "../../src/pane-output.js";
import type { ConnectionState } from "../../src/connection-state.js";
import { IPC } from "../../src/connectors/electron/types.js";
import { SenderRegistry } from "../../src/connectors/electron/sender-registry.js";
import { createIpcHub, type FakeRenderer } from "./_helpers/ipc-hub.js";

// ---------------------------------------------------------------------------
// Fakes — the two injected seams, typed to the exact Pick the registry needs.
// ---------------------------------------------------------------------------

type BridgeSurface = Pick<
  BridgeConnection,
  "registerPeer" | "removePeer" | "accountOutput" | "ackOutput"
>;
type ClientSurface = Pick<TmuxClient, "attachBytesSink" | "connectionState">;

function makeBridge(): BridgeSurface & {
  peers: Peer[];
} {
  let nextId = 0;
  const peers: Peer[] = [];
  return {
    peers,
    registerPeer: vi.fn((): Peer => {
      const peer: Peer = { id: nextId++ };
      peers.push(peer);
      return peer;
    }),
    removePeer: vi.fn(),
    accountOutput: vi.fn(),
    ackOutput: vi.fn(),
  };
}

interface FakeClient extends ClientSurface {
  /** The most recently attached BytesSink (set by register()). */
  lastSink: BytesSink | null;
  lastOptions: AttachOptions | undefined;
  detach: ReturnType<typeof vi.fn>;
  state: ConnectionState;
}

function makeClient(): FakeClient {
  const detach = vi.fn();
  const fake: FakeClient = {
    lastSink: null,
    lastOptions: undefined,
    detach,
    state: { status: "connecting" },
    get connectionState(): ConnectionState {
      return fake.state;
    },
    attachBytesSink: vi.fn(
      (sink: BytesSink, options?: AttachOptions): (() => void) => {
        fake.lastSink = sink;
        fake.lastOptions = options;
        return detach;
      },
    ),
  };
  return fake;
}

/** Capture every IPC.event payload a renderer receives. */
function captureEvents(renderer: FakeRenderer): unknown[] {
  const events: unknown[] = [];
  renderer.ipcRenderer.on(IPC.event, (_e, msg) => events.push(msg));
  return events;
}

describe("SenderRegistry — peer lifecycle", () => {
  it("getOrCreate registers exactly one peer per wc and is idempotent", () => {
    const bridge = makeBridge();
    const registry = new SenderRegistry({ bridge, client: makeClient() });
    const r = createIpcHub().createRenderer();

    const a = registry.getOrCreate(r.sender);
    const b = registry.getOrCreate(r.sender);

    expect(a).toBe(b);
    expect(bridge.registerPeer).toHaveBeenCalledTimes(1);
    expect(a.peer).toBe(bridge.peers[0]);
  });

  it("attaches one destroyed handler whose firing drives teardown (removePeer)", () => {
    const bridge = makeBridge();
    const registry = new SenderRegistry({ bridge, client: makeClient() });
    const r = createIpcHub().createRenderer();

    const state = registry.getOrCreate(r.sender);
    expect(r.destroyHandlerCount()).toBe(1);

    r.destroy();
    expect(bridge.removePeer).toHaveBeenCalledWith(state.peer);
    // The destroyed handler was consumed by `once` firing.
    expect(r.destroyHandlerCount()).toBe(0);
  });
});

describe("SenderRegistry — register", () => {
  it("marks subscribed, attaches the byte sink once, and sends a state snapshot", () => {
    const bridge = makeBridge();
    const client = makeClient();
    client.state = { status: "connecting" };
    const registry = new SenderRegistry({ bridge, client });
    const r = createIpcHub().createRenderer();
    const events = captureEvents(r);

    registry.register(r.sender);
    registry.register(r.sender);

    // Byte sink attached exactly once despite two register calls.
    expect(client.attachBytesSink).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual({
      type: "connection-state",
      state: { status: "connecting" },
    });
  });

  it("the per-renderer sink accounts output before forwarding, and no-ops when destroyed", () => {
    const bridge = makeBridge();
    const client = makeClient();
    const registry = new SenderRegistry({ bridge, client });
    const r = createIpcHub().createRenderer();
    const events = captureEvents(r);
    registry.register(r.sender);
    const state = registry.getOrCreate(r.sender);

    const chunk: ChunkPayload = {
      paneId: 7,
      data: new Uint8Array([1, 2, 3, 4]),
    };
    client.lastSink?.write(chunk);

    expect(bridge.accountOutput).toHaveBeenCalledWith(state.peer, 7, 4);
    expect(events).toContainEqual({
      type: "output",
      paneId: 7,
      data: new Uint8Array([1, 2, 3, 4]),
    });

    // Destroyed renderer: the second write is a no-op — no new account, no new
    // forward (accountOutput call count stays at the single earlier write).
    const before = events.length;
    r.destroy();
    client.lastSink?.write(chunk);
    expect(bridge.accountOutput).toHaveBeenCalledTimes(1);
    expect(events.length).toBe(before);
  });
});

describe("SenderRegistry — ack", () => {
  it("forwards a well-formed ack to bridge.ackOutput", () => {
    const bridge = makeBridge();
    const registry = new SenderRegistry({ bridge, client: makeClient() });
    const r = createIpcHub().createRenderer();
    const state = registry.getOrCreate(r.sender);

    registry.ack(r.sender, { paneId: 3, bytes: 128 });
    expect(bridge.ackOutput).toHaveBeenCalledWith(state.peer, 3, 128);
  });

  it("drops a malformed ack and an ack from an unknown sender", () => {
    const bridge = makeBridge();
    const registry = new SenderRegistry({ bridge, client: makeClient() });
    const known = createIpcHub().createRenderer();
    registry.getOrCreate(known.sender);

    registry.ack(known.sender, { paneId: -1, bytes: 5 }); // invalid paneId
    registry.ack(known.sender, "not-an-object");
    registry.ack(createIpcHub().createRenderer().sender, {
      paneId: 0,
      bytes: 1,
    }); // unknown sender

    expect(bridge.ackOutput).not.toHaveBeenCalled();
  });
});

describe("SenderRegistry — teardown", () => {
  it("detaches bytes, removes the destroyed listener, and removePeers exactly once", () => {
    const bridge = makeBridge();
    const client = makeClient();
    const registry = new SenderRegistry({ bridge, client });
    const r = createIpcHub().createRenderer();
    registry.register(r.sender);
    const state = registry.getOrCreate(r.sender);

    registry.teardown(r.sender);
    registry.teardown(r.sender); // idempotent

    expect(client.detach).toHaveBeenCalledTimes(1);
    expect(bridge.removePeer).toHaveBeenCalledTimes(1);
    expect(bridge.removePeer).toHaveBeenCalledWith(state.peer);
    // Listener detached from the still-alive emitter (unregister-driven path).
    expect(r.destroyHandlerCount()).toBe(0);
  });

  it("teardownAll tears down every registered sender", () => {
    const bridge = makeBridge();
    const registry = new SenderRegistry({ bridge, client: makeClient() });
    const hub = createIpcHub();
    const a = hub.createRenderer();
    const b = hub.createRenderer();
    registry.getOrCreate(a.sender);
    registry.getOrCreate(b.sender);

    registry.teardownAll();
    expect(bridge.removePeer).toHaveBeenCalledTimes(2);
  });
});

describe("SenderRegistry — broadcast", () => {
  it("delivers to subscribed senders, skips unsubscribed, and tears down destroyed ones", () => {
    const bridge = makeBridge();
    const registry = new SenderRegistry({ bridge, client: makeClient() });
    const hub = createIpcHub();
    const subscribed = hub.createRenderer();
    const unsubscribed = hub.createRenderer();
    const dead = hub.createRenderer();

    const subEvents = captureEvents(subscribed);
    const unsubEvents = captureEvents(unsubscribed);

    registry.register(subscribed.sender); // isSubscribed = true
    registry.getOrCreate(unsubscribed.sender); // never register → not subscribed
    registry.register(dead.sender);
    subEvents.length = 0; // drop the register-time connection-state snapshot

    dead.destroy();
    registry.broadcast({ type: "reconnected" });

    expect(subEvents).toContainEqual({ type: "reconnected" });
    expect(unsubEvents).not.toContainEqual({ type: "reconnected" });
    // The destroyed sender was reaped mid-broadcast.
    expect(bridge.removePeer).toHaveBeenCalledTimes(1);
  });
});
