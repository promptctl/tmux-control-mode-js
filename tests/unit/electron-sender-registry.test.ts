// tests/unit/electron-sender-registry.test.ts
// Isolation tests for SenderRegistry — the per-proxy lifecycle collaborator
// extracted from createMainBridge (GM3). Every dependency (bridge, client) is
// constructor-injected, so the registry is driven directly here against spies,
// with no ipcMain and no TmuxClient. The end-to-end behavior through the shell
// is covered by electron-bridge.test.ts; these assert the seam in isolation.

import { describe, expect, it, vi } from "vitest";

import type {
  BridgeConnection,
  DeliveredRoute,
  EventRoute,
  Peer,
} from "../../src/connectors/bridge-connection.js";
import { eventSubject, type EmitterMessage } from "../../src/emitter.js";
import type { TmuxClient } from "../../src/client.js";
import type {
  AttachOptions,
  BytesSink,
  ChunkPayload,
} from "../../src/pane-output.js";
import type { ConnectionState } from "../../src/connection-state.js";
import {
  IPC,
  type AddressedEvent,
  type IpcMainEventLike,
  type ProxyId,
  type WebContentsLike,
} from "../../src/connectors/electron/types.js";
import {
  SenderRegistry,
  type PendingDispatch,
  type ProxyPeer,
} from "../../src/connectors/electron/sender-registry.js";
import { createIpcHub, type FakeRenderer } from "./_helpers/ipc-hub.js";

// Two proxies' addresses on one page.
const P: ProxyId = 7;
const Q: ProxyId = 8;

// Register `proxy` from `event`'s page and return the peer it opened. Throws
// when the page refused the register (it has ended), rather than asserting
// non-null.
function mustOpen(
  registry: SenderRegistry,
  event: IpcMainEventLike,
  proxy: ProxyId = P,
): ProxyPeer {
  registry.register(event, proxy);
  const state = registry.registered(event, proxy);
  if (state === undefined) throw new Error("expected a live page for wc");
  return state;
}

// A WebContentsLike whose destroyed state is set directly, WITHOUT firing the
// `destroyed` once-handler. Lets a test drive the broadcast reaping path
// (isDestroyed → teardown) in isolation from the destroy-handler teardown path.
interface ControllableWc {
  readonly wc: WebContentsLike;
  readonly event: IpcMainEventLike;
  readonly sends: AddressedEvent[];
  setDestroyed(): void;
  /** Crashed, with `mainFrame` still readable (Electron 34+). */
  setCrashed(): void;
  pageListenerCount(): number;
}

function makeControllableWc(): ControllableWc {
  let destroyed = false;
  let crashed = false;
  const sends: AddressedEvent[] = [];
  const attached = new Map<string, Set<() => void>>();
  const attach = (event: string, listener: () => void): void => {
    const set = attached.get(event) ?? new Set();
    attached.set(event, set.add(listener));
  };
  const wc: WebContentsLike = {
    send(_channel, msg) {
      sends.push(msg);
    },
    mainFrame: { processId: 1, routingId: 1 },
    once: attach,
    on: attach,
    removeListener(event, listener) {
      attached.get(event)?.delete(listener);
    },
    isDestroyed() {
      return destroyed;
    },
    isCrashed: () => crashed,
  };
  return {
    wc,
    event: { sender: wc, processId: 1, frameId: 1 },
    sends,
    setDestroyed() {
      destroyed = true;
    },
    setCrashed() {
      crashed = true;
    },
    pageListenerCount: () =>
      [...attached.values()].reduce((n, set) => n + set.size, 0),
  };
}

// ---------------------------------------------------------------------------
// Fakes — the two injected seams, typed to the exact Pick the registry needs.
// ---------------------------------------------------------------------------

type BridgeSurface = Pick<
  BridgeConnection,
  | "registerPeer"
  | "removePeer"
  | "accountOutput"
  | "ackOutput"
  | "routeEvent"
  | "deliversTo"
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
    routeEvent: vi.fn(
      (msg: EmitterMessage): EventRoute =>
        ({ kind: eventSubject(msg), msg }) as EventRoute,
    ),
    deliversTo: (
      _peer: Peer,
      route: EventRoute,
    ): route is DeliveredRoute<boolean> => route.kind !== "none",
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
function captureEvents(renderer: FakeRenderer): AddressedEvent[] {
  const events: AddressedEvent[] = [];
  renderer.ipcRenderer.on(IPC.event, (_e, addressed) => events.push(addressed));
  return events;
}

describe("SenderRegistry — peer lifecycle", () => {
  it("register opens exactly one peer per proxy and is idempotent", () => {
    const bridge = makeBridge();
    const registry = new SenderRegistry({ bridge, client: makeClient() });
    const r = createIpcHub().createRenderer();

    const a = mustOpen(registry, r.event);
    const b = mustOpen(registry, r.event);
    const other = mustOpen(registry, r.event, Q);

    expect(a).toBe(b);
    expect(other.peer).not.toBe(a.peer);
    expect(bridge.registerPeer).toHaveBeenCalledTimes(2);
    expect(a.peer).toBe(bridge.peers[0]);
    // One page, one set of page listeners, however many proxies it has.
    expect(r.pageListenerCount()).toBe(4);
  });

  it("a page's end releases every proxy's peer on it", () => {
    const bridge = makeBridge();
    const registry = new SenderRegistry({ bridge, client: makeClient() });
    const r = createIpcHub().createRenderer();
    const a = mustOpen(registry, r.event);
    const b = mustOpen(registry, r.event, Q);

    r.destroy();
    expect(bridge.removePeer).toHaveBeenCalledWith(a.peer);
    expect(bridge.removePeer).toHaveBeenCalledWith(b.peer);
  });

  it("attaches one page-end handler whose firing drives teardown (removePeer)", () => {
    const bridge = makeBridge();
    const registry = new SenderRegistry({ bridge, client: makeClient() });
    const r = createIpcHub().createRenderer();

    const state = mustOpen(registry, r.event);
    expect(r.pageListenerCount()).toBe(4);

    r.destroy();
    expect(bridge.removePeer).toHaveBeenCalledWith(state.peer);
    // The fired handler was consumed by `once`; teardown detached the rest.
    expect(r.pageListenerCount()).toBe(0);
  });

  it("refuses to resurrect a sender for an already-destroyed wc (post-teardown invoke race)", () => {
    const bridge = makeBridge();
    const registry = new SenderRegistry({ bridge, client: makeClient() });
    const dead = makeControllableWc();

    mustOpen(registry, dead.event); // live: one peer registered
    expect(bridge.registerPeer).toHaveBeenCalledTimes(1);

    // Renderer dies: teardown runs (as its destroyed handler would) and the wc
    // now reports destroyed. A queued register then lands.
    registry.teardown(dead.wc);
    dead.setDestroyed();
    registry.register(dead.event, P);

    // No new sender, no leaked peer, no never-firing destroyed listener.
    expect(registry.registered(dead.event, P)).toBeUndefined();
    expect(bridge.registerPeer).toHaveBeenCalledTimes(1);
    expect(dead.pageListenerCount()).toBe(0);
  });
});

describe("SenderRegistry — the live page", () => {
  it("refuses a message from a frame other than the page's main frame", () => {
    const bridge = makeBridge();
    const registry = new SenderRegistry({ bridge, client: makeClient() });
    const r = createIpcHub().createRenderer();
    const subframe = { ...r.event, frameId: r.event.frameId + 1 };

    registry.register(subframe, P);
    expect(registry.registered(subframe, P)).toBeUndefined();
    expect(bridge.registerPeer).not.toHaveBeenCalled();
  });

  it("a navigation tears the page's sender down", async () => {
    const bridge = makeBridge();
    const registry = new SenderRegistry({ bridge, client: makeClient() });
    const r = createIpcHub().createRenderer();
    const state = mustOpen(registry, r.event);

    await r.navigate();
    expect(bridge.removePeer).toHaveBeenCalledWith(state.peer);
    expect(mustOpen(registry, r.event).peer).not.toBe(state.peer);
  });

  it("a failed load that commits an error page tears the page's sender down", () => {
    const bridge = makeBridge();
    const registry = new SenderRegistry({ bridge, client: makeClient() });
    const r = createIpcHub().createRenderer();
    const state = mustOpen(registry, r.event);

    r.failLoad({ commitErrorPage: true });
    expect(bridge.removePeer).toHaveBeenCalledWith(state.peer);
    expect(r.pageListenerCount()).toBe(0);
  });

  it("a failed load that commits nothing leaves the page's sender", () => {
    const bridge = makeBridge();
    const registry = new SenderRegistry({ bridge, client: makeClient() });
    const r = createIpcHub().createRenderer();
    const state = mustOpen(registry, r.event);

    r.failLoad({ commitErrorPage: false });
    expect(bridge.removePeer).not.toHaveBeenCalled();
    expect(registry.registered(r.event, P)).toBe(state);
  });

  it("refuses a crashed renderer's queued message when its frame still reads (Electron 34+)", () => {
    const bridge = makeBridge();
    const registry = new SenderRegistry({ bridge, client: makeClient() });
    const dead = makeControllableWc();
    mustOpen(registry, dead.event);

    registry.teardown(dead.wc); // as render-process-gone would
    dead.setCrashed();
    registry.register(dead.event, P);
    expect(registry.registered(dead.event, P)).toBeUndefined();
    expect(bridge.registerPeer).toHaveBeenCalledTimes(1);
  });

  it("an ack from a page that has ended releases nothing against the next page's peer", async () => {
    const bridge = makeBridge();
    const registry = new SenderRegistry({ bridge, client: makeClient() });
    const r = createIpcHub().createRenderer();
    const old = r.event;
    mustOpen(registry, old);

    await r.navigate({ swapFrame: true });
    mustOpen(registry, r.event);
    registry.ack(old, P, { paneId: 3, bytes: 128 });
    expect(bridge.ackOutput).not.toHaveBeenCalled();
  });

  it("refuses what a crashed renderer had queued, without reading its disposed frame", () => {
    const bridge = makeBridge();
    const registry = new SenderRegistry({ bridge, client: makeClient() });
    const r = createIpcHub().createRenderer();
    const dead = r.event;
    mustOpen(registry, dead);

    r.crash();
    expect(() => r.sender.mainFrame).toThrow();
    registry.register(dead, P);
    expect(registry.registered(dead, P)).toBeUndefined();
    registry.ack(dead, P, { paneId: 3, bytes: 128 });
    registry.unregister(dead, P);
    expect(bridge.registerPeer).toHaveBeenCalledTimes(1);
    expect(bridge.ackOutput).not.toHaveBeenCalled();
  });
});

describe("SenderRegistry — register", () => {
  it("attaches the proxy's byte sink once, and sends it a state snapshot", async () => {
    const bridge = makeBridge();
    const client = makeClient();
    client.state = { status: "connecting" };
    const registry = new SenderRegistry({ bridge, client });
    const hub = createIpcHub();
    const r = hub.createRenderer();
    const events = captureEvents(r);

    registry.register(r.event, P);
    registry.register(r.event, P);
    await hub.settled();

    // Byte sink attached exactly once despite two register calls.
    expect(client.attachBytesSink).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual({
      to: P,
      msg: { type: "connection-state", state: { status: "connecting" } },
    });
  });

  it("a proxy's snapshot is addressed to it alone", async () => {
    const registry = new SenderRegistry({
      bridge: makeBridge(),
      client: makeClient(),
    });
    const hub = createIpcHub();
    const r = hub.createRenderer();
    const events = captureEvents(r);

    registry.register(r.event, P);
    await hub.settled();
    events.length = 0;
    registry.register(r.event, Q);
    await hub.settled();

    expect(events.map((e) => e.to)).toEqual([Q]);
  });

  it("each proxy's byte sink bills its own peer and addresses its own proxy", async () => {
    const bridge = makeBridge();
    const client = makeClient();
    const registry = new SenderRegistry({ bridge, client });
    const hub = createIpcHub();
    const r = hub.createRenderer();
    const events = captureEvents(r);
    registry.register(r.event, P);
    registry.register(r.event, Q);
    const q = mustOpen(registry, r.event, Q);
    await hub.settled();
    events.length = 0;

    // The last sink attached is Q's.
    expect(client.attachBytesSink).toHaveBeenCalledTimes(2);
    client.lastSink?.write({ paneId: 2, data: new Uint8Array([9]) });
    await hub.settled();

    expect(bridge.accountOutput).toHaveBeenCalledExactlyOnceWith(q.peer, 2, 1);
    expect(events).toEqual([
      {
        to: Q,
        msg: { type: "output", paneId: 2, data: new Uint8Array([9]) },
      },
    ]);
  });

  it("the per-renderer sink accounts output before forwarding, and no-ops when destroyed", async () => {
    const bridge = makeBridge();
    const client = makeClient();
    const registry = new SenderRegistry({ bridge, client });
    const hub = createIpcHub();
    const r = hub.createRenderer();
    const events = captureEvents(r);
    registry.register(r.event, P);
    const state = mustOpen(registry, r.event);

    const chunk: ChunkPayload = {
      paneId: 7,
      data: new Uint8Array([1, 2, 3, 4]),
    };
    client.lastSink?.write(chunk);
    await hub.settled();

    expect(bridge.accountOutput).toHaveBeenCalledWith(state.peer, 7, 4);
    expect(events).toContainEqual({
      to: P,
      msg: { type: "output", paneId: 7, data: new Uint8Array([1, 2, 3, 4]) },
    });

    // Destroyed renderer: the second write is a no-op — no new account, no new
    // forward (accountOutput call count stays at the single earlier write).
    const before = events.length;
    r.destroy();
    client.lastSink?.write(chunk);
    await hub.settled();
    expect(bridge.accountOutput).toHaveBeenCalledTimes(1);
    expect(events.length).toBe(before);
  });
});

describe("SenderRegistry — ack", () => {
  it("forwards a well-formed ack to bridge.ackOutput", () => {
    const bridge = makeBridge();
    const registry = new SenderRegistry({ bridge, client: makeClient() });
    const r = createIpcHub().createRenderer();
    const state = mustOpen(registry, r.event);

    registry.ack(r.event, P, { paneId: 3, bytes: 128 });
    expect(bridge.ackOutput).toHaveBeenCalledWith(state.peer, 3, 128);
  });

  it("drops a malformed ack and an ack from an unknown proxy", () => {
    const bridge = makeBridge();
    const registry = new SenderRegistry({ bridge, client: makeClient() });
    const known = createIpcHub().createRenderer();
    registry.register(known.event, P);

    registry.ack(known.event, P, { paneId: -1, bytes: 5 }); // invalid paneId
    registry.ack(known.event, P, "not-an-object");
    registry.ack(known.event, "P", { paneId: 0, bytes: 1 }); // no address
    registry.ack(known.event, Q, { paneId: 0, bytes: 1 }); // unknown proxy
    registry.ack(createIpcHub().createRenderer().event, P, {
      paneId: 0,
      bytes: 1,
    }); // unknown page

    expect(bridge.ackOutput).not.toHaveBeenCalled();
  });
});

describe("SenderRegistry — unregister", () => {
  it("releases the proxy's peer and leaves the page's other proxies theirs", () => {
    const bridge = makeBridge();
    const client = makeClient();
    const registry = new SenderRegistry({ bridge, client });
    const r = createIpcHub().createRenderer();
    registry.register(r.event, P);
    registry.register(r.event, Q);
    const p = mustOpen(registry, r.event);
    const q = mustOpen(registry, r.event, Q);
    const inFlight: PendingDispatch = { aborted: false };
    q.pending.add(inFlight);

    registry.unregister(r.event, P);
    expect(bridge.removePeer).toHaveBeenCalledExactlyOnceWith(p.peer);
    expect(client.detach).toHaveBeenCalledTimes(1);
    expect(inFlight.aborted).toBe(false);
    expect(mustOpen(registry, r.event, Q)).toBe(q);
    expect(r.pageListenerCount()).toBe(4);

    // The page's last proxy takes the page with it.
    registry.unregister(r.event, Q);
    expect(bridge.removePeer).toHaveBeenLastCalledWith(q.peer);
    expect(inFlight.aborted).toBe(true);
    expect(r.pageListenerCount()).toBe(0);
  });

  it("an unregister naming a proxy the page never registered releases nothing", () => {
    const bridge = makeBridge();
    const registry = new SenderRegistry({ bridge, client: makeClient() });
    const r = createIpcHub().createRenderer();
    mustOpen(registry, r.event);

    registry.unregister(r.event, Q);
    expect(bridge.removePeer).not.toHaveBeenCalled();
    expect(r.pageListenerCount()).toBe(4);
  });
});

describe("SenderRegistry — teardown", () => {
  it("detaches bytes, removes the destroyed listener, and removePeers exactly once", () => {
    const bridge = makeBridge();
    const client = makeClient();
    const registry = new SenderRegistry({ bridge, client });
    const r = createIpcHub().createRenderer();
    registry.register(r.event, P);
    const state = mustOpen(registry, r.event);

    registry.teardown(r.sender);
    registry.teardown(r.sender); // idempotent

    expect(client.detach).toHaveBeenCalledTimes(1);
    expect(bridge.removePeer).toHaveBeenCalledTimes(1);
    expect(bridge.removePeer).toHaveBeenCalledWith(state.peer);
    // Listener detached from the still-alive emitter (unregister-driven path).
    expect(r.pageListenerCount()).toBe(0);
  });

  it("flags every in-flight dispatch of the torn-down sender aborted", () => {
    const bridge = makeBridge();
    const registry = new SenderRegistry({ bridge, client: makeClient() });
    const r = createIpcHub().createRenderer();
    const state = mustOpen(registry, r.event);

    // Stand in for the invoke pipeline: two in-flight dispatches on this sender.
    const a: PendingDispatch = { aborted: false };
    const b: PendingDispatch = { aborted: false };
    state.pending.add(a);
    state.pending.add(b);

    registry.teardown(r.sender);

    // The abort channel — the whole reason `pending` exists — is flipped so the
    // pipeline returns BRIDGE_ABORTED instead of delivering to a dead wc.
    expect(a.aborted).toBe(true);
    expect(b.aborted).toBe(true);
  });

  it("teardownAll tears down every registered sender", () => {
    const bridge = makeBridge();
    const registry = new SenderRegistry({ bridge, client: makeClient() });
    const hub = createIpcHub();
    const a = hub.createRenderer();
    const b = hub.createRenderer();
    registry.register(a.event, P);
    registry.register(b.event, P);

    registry.teardownAll();
    expect(bridge.removePeer).toHaveBeenCalledTimes(2);
  });
});

describe("SenderRegistry — broadcast", () => {
  it("delivers to each proxy on the page, addressed to it", async () => {
    const bridge = makeBridge();
    const registry = new SenderRegistry({ bridge, client: makeClient() });
    const hub = createIpcHub();
    const r = hub.createRenderer();
    const events = captureEvents(r);

    registry.register(r.event, P);
    registry.register(r.event, Q);
    await hub.settled();
    events.length = 0; // drop the register-time connection-state snapshots

    registry.broadcast({ type: "reconnected" });
    await hub.settled();

    expect(events).toEqual([
      { to: P, msg: { type: "reconnected" } },
      { to: Q, msg: { type: "reconnected" } },
    ]);
    expect(bridge.removePeer).not.toHaveBeenCalled();
  });

  it("reaps a sender that became destroyed without firing its destroyed handler", () => {
    // A sender whose wc is destroyed but whose destroyed handler never ran (a
    // real Electron race: `destroyed` may fire asynchronously) is still in the
    // map when broadcast iterates. This exercises broadcast's OWN isDestroyed →
    // teardown reaping path — not the destroy-handler teardown path.
    const bridge = makeBridge();
    const registry = new SenderRegistry({ bridge, client: makeClient() });
    const dead = makeControllableWc();
    registry.register(dead.event, P);
    const state = mustOpen(registry, dead.event);
    dead.sends.length = 0; // drop the register-time connection-state snapshot

    dead.setDestroyed(); // destroyed, but the once-handler did NOT fire
    registry.broadcast({ type: "reconnected" });

    // Broadcast itself detected the dead sender and tore it down: removePeer
    // fired with this sender's peer (the destroy handler never ran), no event
    // was delivered, and the destroyed listener was detached.
    expect(bridge.removePeer).toHaveBeenCalledTimes(1);
    expect(bridge.removePeer).toHaveBeenCalledWith(state.peer);
    expect(dead.sends).toEqual([]);
    expect(dead.pageListenerCount()).toBe(0);

    // Reaped: a second broadcast finds nothing to tear down.
    registry.broadcast({ type: "reconnected" });
    expect(bridge.removePeer).toHaveBeenCalledTimes(1);
  });
});
