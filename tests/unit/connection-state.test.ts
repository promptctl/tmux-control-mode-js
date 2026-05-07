// tests/unit/connection-state.test.ts
// Behavior-level tests for the unified ConnectionState lifecycle on every
// TmuxClient-shaped class:
//   - TmuxClient (spawn-style; no reconnect)
//   - WebSocketTmuxClient (with optional reconnect; emits 'reconnected')
//   - TmuxClientProxy (Electron renderer; mirrors main's lifecycle over IPC)

import { describe, expect, it, vi } from "vitest";

import { TmuxClient } from "../../src/client.js";
import type { TmuxTransport } from "../../src/transport/types.js";
import type { ConnectionState } from "../../src/connection-state.js";
import { createMainBridge } from "../../src/connectors/electron/main.js";
import { createRendererBridge } from "../../src/connectors/electron/renderer.js";
import { WebSocketTmuxClient } from "../../src/connectors/websocket/client.js";
import {
  PROTOCOL_VERSION,
  encodeServerFrame,
  type ServerFrame,
  type WelcomeFrame,
} from "../../src/connectors/websocket/protocol.js";
import { createIpcHub } from "./_helpers/ipc-hub.js";

// ---------------------------------------------------------------------------
// Shared fake transport for spawn-style TmuxClient.
// ---------------------------------------------------------------------------
interface FakeTransport extends TmuxTransport {
  feed(chunk: string): void;
  triggerClose(reason?: string): void;
}

function createFakeTransport(): FakeTransport {
  const dataCallbacks: ((chunk: string) => void)[] = [];
  const closeCallbacks: ((reason?: string) => void)[] = [];
  return {
    send(): void {},
    onData(cb): void {
      dataCallbacks.push(cb);
    },
    onClose(cb): void {
      closeCallbacks.push(cb);
    },
    close(): void {},
    feed(chunk): void {
      dataCallbacks.forEach((cb) => cb(chunk));
    },
    triggerClose(reason): void {
      closeCallbacks.forEach((cb) => cb(reason));
    },
  };
}

// ---------------------------------------------------------------------------
// TmuxClient (spawn) — straight-line lifecycle, never reconnects.
// ---------------------------------------------------------------------------

describe("TmuxClient — connection state", () => {
  it("starts in connecting", () => {
    const client = new TmuxClient(createFakeTransport());
    expect(client.connectionState).toEqual({ status: "connecting" });
  });

  it("transitions to ready on the first transport chunk", () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t);
    const states: ConnectionState[] = [];
    client.on("connection-state", (ev) => states.push(ev.state));

    t.feed("%begin 1 1 0\n%end 1 1 0\n");

    expect(client.connectionState).toEqual({ status: "ready" });
    expect(states).toEqual([{ status: "ready" }]);
  });

  it("subsequent chunks do not re-emit ready", () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t);
    const states: ConnectionState[] = [];
    client.on("connection-state", (ev) => states.push(ev.state));

    t.feed("%begin 1 1 0\n%end 1 1 0\n");
    t.feed("%window-add @1\n");

    expect(states).toEqual([{ status: "ready" }]);
  });

  it("closes with reason='exit' on a clean transport close", () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t);
    const states: ConnectionState[] = [];
    client.on("connection-state", (ev) => states.push(ev.state));

    t.feed("%begin 1 1 0\n%end 1 1 0\n");
    t.triggerClose(); // undefined reason = clean exit

    expect(client.connectionState).toEqual({
      status: "closed",
      reason: "exit",
    });
    expect(states.at(-1)).toEqual({ status: "closed", reason: "exit" });
  });

  it("closes with reason='transport-error' on an error close", () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t);
    const states: ConnectionState[] = [];
    client.on("connection-state", (ev) => states.push(ev.state));

    t.feed("%begin 1 1 0\n%end 1 1 0\n");
    t.triggerClose("EPIPE");

    expect(client.connectionState).toEqual({
      status: "closed",
      reason: "transport-error",
    });
  });

  it("closes with reason='disposed' when client.close() is called first", () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t);
    const states: ConnectionState[] = [];
    client.on("connection-state", (ev) => states.push(ev.state));

    t.feed("%begin 1 1 0\n%end 1 1 0\n");
    client.close();
    t.triggerClose("EPIPE"); // even an error reason → disposed wins

    expect(client.connectionState).toEqual({
      status: "closed",
      reason: "disposed",
    });
  });

  it("never emits 'reconnected'", () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t);
    const reconnects = vi.fn();
    client.on("reconnected", reconnects);

    t.feed("%begin 1 1 0\n%end 1 1 0\n");
    t.triggerClose();

    expect(reconnects).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// WebSocketTmuxClient — drives the connect/close/reopen cycle through a fake
// browser WebSocket and asserts the unified mapping.
// ---------------------------------------------------------------------------

type Listener = (ev: unknown) => void;

interface MockWS {
  url: string;
  readyState: number;
  send: (data: string | ArrayBufferLike | Uint8Array) => void;
  close: (code?: number, reason?: string) => void;
  addEventListener: (event: string, listener: Listener) => void;
  removeEventListener: (event: string, listener: Listener) => void;
  fire(event: string, payload: unknown): void;
}

class MockWebSocketHub {
  readonly sockets: MockWS[] = [];

  factory = (url: string): MockWS => {
    const listeners = new Map<string, Set<Listener>>();
    const ws: MockWS = {
      url,
      readyState: 0, // CONNECTING
      send: () => {},
      close: (code = 1000, reason = "") => {
        ws.readyState = 3; // CLOSED
        ws.fire("close", { code, reason });
      },
      addEventListener(event, listener) {
        let set = listeners.get(event);
        if (!set) {
          set = new Set();
          listeners.set(event, set);
        }
        set.add(listener);
      },
      removeEventListener(event, listener) {
        listeners.get(event)?.delete(listener);
      },
      fire(event, payload) {
        const set = listeners.get(event);
        if (!set) return;
        for (const cb of set) cb(payload);
      },
    };
    this.sockets.push(ws);
    return ws;
  };

  latest(): MockWS {
    const ws = this.sockets.at(-1);
    if (!ws) throw new Error("no socket created yet");
    return ws;
  }

  open(idx = -1): void {
    const ws = idx === -1 ? this.latest() : this.sockets[idx];
    if (!ws) throw new Error("no socket at index " + idx);
    ws.readyState = 1; // OPEN
    ws.fire("open", {});
  }

  welcome(idx = -1): void {
    const ws = idx === -1 ? this.latest() : this.sockets[idx];
    if (!ws) return;
    const welcome: WelcomeFrame = {
      v: 1,
      k: "welcome",
      protocol: PROTOCOL_VERSION,
      limits: {
        requestTimeoutMs: 30_000,
        heartbeatIntervalMs: 30_000,
        maxInflight: 16,
      },
    };
    ws.fire("message", {
      data: encodeServerFrame(welcome satisfies ServerFrame),
    });
  }

  close(code = 1006, reason = "abnormal"): void {
    const ws = this.latest();
    ws.readyState = 3;
    ws.fire("close", { code, reason });
  }
}

describe("WebSocketTmuxClient — connection state", () => {
  function makeClient(reconnect = false): {
    client: WebSocketTmuxClient;
    hub: MockWebSocketHub;
  } {
    const hub = new MockWebSocketHub();
    const client = new WebSocketTmuxClient({
      url: "ws://test/",
      autoConnect: false,
      createWebSocket: hub.factory as never,
      reconnect: reconnect
        ? {
            initialDelayMs: 1,
            maxDelayMs: 1,
            backoffFactor: 1,
            jitter: 0,
            maxAttempts: 3,
          }
        : undefined,
    });
    return { client, hub };
  }

  it("starts in connecting", () => {
    const { client } = makeClient();
    expect(client.connectionState).toEqual({ status: "connecting" });
  });

  it("transitions through connecting → ready on welcome", async () => {
    const { client, hub } = makeClient();
    const states: ConnectionState[] = [];
    client.on("connection-state", (ev) => states.push(ev.state));
    void client.connect();

    hub.open();
    hub.welcome();
    await new Promise((r) => setImmediate(r));

    expect(client.connectionState).toEqual({ status: "ready" });
    // Connecting state changes (idle→connecting→open) all map to
    // {status:'connecting'} in the unified shape and dedupe.
    expect(states.at(-1)).toEqual({ status: "ready" });
  });

  it("does not emit 'reconnected' the first time it reaches ready", async () => {
    const { client, hub } = makeClient();
    const reconnects = vi.fn();
    client.on("reconnected", reconnects);
    void client.connect();
    hub.open();
    hub.welcome();
    await new Promise((r) => setImmediate(r));
    expect(reconnects).not.toHaveBeenCalled();
  });

  it("emits 'reconnected' after a close→reopen cycle with reconnect policy", async () => {
    const { client, hub } = makeClient(true);
    const reconnects = vi.fn();
    const states: ConnectionState[] = [];
    client.on("reconnected", reconnects);
    client.on("connection-state", (ev) => states.push(ev.state));

    void client.connect();
    hub.open();
    hub.welcome();
    await new Promise((r) => setImmediate(r));
    expect(reconnects).not.toHaveBeenCalled();

    hub.close(1006, "abnormal");
    await new Promise((r) => setTimeout(r, 5));
    // Should be reconnecting at attempt 1
    expect(client.connectionState.status).toBe("reconnecting");

    hub.open();
    hub.welcome();
    await new Promise((r) => setImmediate(r));

    expect(client.connectionState).toEqual({ status: "ready" });
    expect(reconnects).toHaveBeenCalledTimes(1);
  });

  it("close() lands in closed{disposed}", async () => {
    const { client, hub } = makeClient();
    void client.connect();
    hub.open();
    hub.welcome();
    await new Promise((r) => setImmediate(r));

    void client.close();

    expect(client.connectionState).toEqual({
      status: "closed",
      reason: "disposed",
    });
  });
});

// ---------------------------------------------------------------------------
// TmuxClientProxy — mirrors main's connectionState over IPC.
// ---------------------------------------------------------------------------

describe("TmuxClientProxy (Electron renderer) — connection state", () => {
  it("receives the current snapshot on register and tracks subsequent transitions", () => {
    const hub = createIpcHub();
    const t = createFakeTransport();
    const main = new TmuxClient(t);
    // Drive main into ready BEFORE the renderer joins so we can verify the
    // late-join snapshot path.
    t.feed("%begin 1 1 0\n%end 1 1 0\n");
    expect(main.connectionState).toEqual({ status: "ready" });

    createMainBridge(main, hub.ipcMain);

    const renderer = hub.createRenderer();
    const proxy = createRendererBridge(renderer.ipcRenderer);

    // Snapshot delivered synchronously by main.onRegister.
    expect(proxy.connectionState).toEqual({ status: "ready" });

    const states: ConnectionState[] = [];
    proxy.on("connection-state", (ev) => states.push(ev.state));

    // Drive main to closed; the renderer should observe the transition.
    t.triggerClose();

    expect(states.at(-1)).toEqual({ status: "closed", reason: "exit" });
    expect(proxy.connectionState).toEqual({
      status: "closed",
      reason: "exit",
    });
  });

  it("proxy.close() lands in closed{disposed} regardless of main's state", () => {
    const hub = createIpcHub();
    const t = createFakeTransport();
    const main = new TmuxClient(t);
    t.feed("%begin 1 1 0\n%end 1 1 0\n");
    createMainBridge(main, hub.ipcMain);

    const renderer = hub.createRenderer();
    const proxy = createRendererBridge(renderer.ipcRenderer);

    expect(proxy.connectionState.status).toBe("ready");
    proxy.close();

    expect(proxy.connectionState).toEqual({
      status: "closed",
      reason: "disposed",
    });
  });

  it("proxy.close() overrides main's closed{exit} with closed{disposed}", () => {
    // Pins the contract documented at renderer.ts (close() is the proxy-side
    // terminator: even if main already broadcast closed{exit}, the proxy
    // reports closed{disposed} so the proxy's lifecycle reflects *its*
    // termination cause, not main's).
    const hub = createIpcHub();
    const t = createFakeTransport();
    const main = new TmuxClient(t);
    t.feed("%begin 1 1 0\n%end 1 1 0\n");
    createMainBridge(main, hub.ipcMain);

    const renderer = hub.createRenderer();
    const proxy = createRendererBridge(renderer.ipcRenderer);

    const states: ConnectionState[] = [];
    proxy.on("connection-state", (ev) => states.push(ev.state));

    // Drive main to closed{exit}; proxy mirrors it.
    t.triggerClose();
    expect(proxy.connectionState).toEqual({
      status: "closed",
      reason: "exit",
    });

    // proxy.close() must still terminate the proxy lifecycle as disposed.
    proxy.close();

    expect(proxy.connectionState).toEqual({
      status: "closed",
      reason: "disposed",
    });
    expect(states.at(-1)).toEqual({ status: "closed", reason: "disposed" });
  });

  it("proxy.close() overrides main's closed{transport-error} with closed{disposed}", () => {
    const hub = createIpcHub();
    const t = createFakeTransport();
    const main = new TmuxClient(t);
    t.feed("%begin 1 1 0\n%end 1 1 0\n");
    createMainBridge(main, hub.ipcMain);

    const renderer = hub.createRenderer();
    const proxy = createRendererBridge(renderer.ipcRenderer);

    t.triggerClose("EPIPE");
    expect(proxy.connectionState).toEqual({
      status: "closed",
      reason: "transport-error",
    });

    proxy.close();

    expect(proxy.connectionState).toEqual({
      status: "closed",
      reason: "disposed",
    });
  });

  it("proxy.close() is idempotent on closed{disposed} (no duplicate emit)", () => {
    const hub = createIpcHub();
    const t = createFakeTransport();
    const main = new TmuxClient(t);
    t.feed("%begin 1 1 0\n%end 1 1 0\n");
    createMainBridge(main, hub.ipcMain);

    const renderer = hub.createRenderer();
    const proxy = createRendererBridge(renderer.ipcRenderer);

    const states: ConnectionState[] = [];
    proxy.on("connection-state", (ev) => states.push(ev.state));

    proxy.close();
    proxy.close();

    expect(
      states.filter(
        (s) => s.status === "closed" && s.reason === "disposed",
      ),
    ).toHaveLength(1);
  });
});
