// tests/unit/_helpers/websocket-hub.ts
// A fake socket factory for WebSocketTmuxClient: one hub per test, one MockWS
// per socket the client opens. Each MockWS records every frame the client
// tried to send, so tests can assert which frames crossed which connection.
//
// [LAW:one-source-of-truth] The one model of how `ws` behaves under the
//   client, shared by every suite that drives the client through a socket.

import {
  encodeServerFrame,
  parseDurationMs,
  parsePositiveInt,
  type DurationMs,
  type HeartbeatInterval,
  type ServerFrame,
  type WelcomeFrame,
} from "../../../src/connectors/websocket/protocol.js";

type Listener = (ev: unknown) => void;

export interface MockWS {
  url: string;
  readyState: number;
  readonly sent: string[];
  send(data: string | ArrayBufferLike | Uint8Array): void;
  close(code?: number, reason?: string): void;
  // Listener registry as `ws` implements it: removeEventListener is the
  // only teardown. `ws` ignores an `{ signal }` option, so this mock does
  // not take one — a client that relied on it would leak listeners here
  // exactly as it does under `ws`.
  addEventListener(event: string, listener: Listener): void;
  removeEventListener(event: string, listener: Listener): void;
  fire(event: string, payload: unknown): void;
}

export class MockWebSocketHub {
  readonly sockets: MockWS[] = [];

  factory = (url: string): MockWS => {
    const listeners = new Map<string, Set<Listener>>();
    const sent: string[] = [];
    const ws: MockWS = {
      url,
      readyState: 0, // CONNECTING
      sent,
      send(data) {
        sent.push(typeof data === "string" ? data : "<binary>");
      },
      close(code = 1000, reason = "") {
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
        const set = listeners.get(event) ?? new Set();
        // `ws`'s WebSocket is an EventEmitter: an 'error' nobody listens
        // for throws in the host process.
        if (event === "error" && set.size === 0) {
          throw new Error("unhandled 'error' event");
        }
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

  /** Advertise a welcome; the heartbeat is off and the server's call timeout
   *  is 30s unless a test is about them. */
  welcome(
    idx = -1,
    heartbeatIntervalMs: HeartbeatInterval = 0,
    requestTimeoutMs: DurationMs = parseDurationMs("requestTimeoutMs", 30_000),
  ): void {
    const ws = idx === -1 ? this.latest() : this.sockets[idx];
    if (!ws) return;
    const welcome: WelcomeFrame = {
      k: "welcome",
      limits: {
        requestTimeoutMs,
        heartbeatIntervalMs,
        maxInflight: parsePositiveInt("maxInflight", 16),
      },
    };
    ws.fire("message", {
      data: encodeServerFrame(welcome satisfies ServerFrame),
    });
  }

  fireClose(idx = -1, code = 1006, reason = "abnormal"): void {
    const ws = idx === -1 ? this.latest() : this.sockets[idx];
    if (!ws) return;
    ws.readyState = 3;
    ws.fire("close", { code, reason });
  }
}
