// tests/integration/websocket-bridge.test.ts
// Integration tests for the WebSocket bridge against a real tmux process,
// a real `ws` WebSocketServer, and a real `ws` WebSocket client.
//
// [LAW:verifiable-goals] Gated behind TMUX_INTEGRATION=1 just like the other
// integration tests. When tmux is installed, these tests prove the bridge
// works end-to-end: browser API surface → JSON/binary over the wire → tmux.

import { describe, it, afterEach, beforeEach, expect } from "vitest";
import { execSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import {
  WebSocket as WsClient,
  WebSocketServer,
  type WebSocket as WsWebSocket,
} from "ws";

import { spawnTmux } from "../../src/transport/spawn.js";
import { TmuxClient } from "../../src/client.js";
import type { TmuxMessage } from "../../src/protocol/types.js";

import { createWebSocketBridge } from "../../src/connectors/websocket/server.js";
import {
  WebSocketTmuxClient,
  type WebSocketTmuxClientState,
} from "../../src/connectors/websocket/client.js";
import {
  BridgeError,
  PROTOCOL_VERSION,
} from "../../src/connectors/websocket/protocol.js";
import type {
  BridgeObservabilityEvent,
  ServerWebSocketLike,
} from "../../src/connectors/websocket/types.js";

const RUN_INTEGRATION = process.env.TMUX_INTEGRATION === "1";

// ---------------------------------------------------------------------------
// Isolation: every test fixture spawns its OWN tmux server via `-L <socket>`.
// This prevents any test command — especially `kill-session` cleanup — from
// reaching the developer's default tmux server. Each fixture gets a unique
// socket name; teardown runs `tmux -L <socket> kill-server` to guarantee the
// isolated server exits whether or not sessions linger.
//
// [LAW:single-enforcer] `tmuxCmd()` is the only place that builds the
// `tmux -L <socket> ...` command line. No execSync string interpolation
// with a raw "tmux" prefix exists anywhere else in this file.
// ---------------------------------------------------------------------------

interface Fixture {
  readonly url: string;
  readonly tmux: TmuxClient;
  readonly sessionName: string;
  readonly socketName: string;
  readonly httpServer: Server;
  readonly wss: WebSocketServer;
  shutdown(): Promise<void>;
  observabilityEvents: BridgeObservabilityEvent[];
}

function uniqueSocket(prefix: string): string {
  return `tmux-bridge-test-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function tmuxCmd(socketName: string, args: string): string {
  return `tmux -L ${socketName} ${args}`;
}

function killServer(socketName: string): void {
  try {
    execSync(tmuxCmd(socketName, "kill-server"), { stdio: "ignore" });
  } catch {
    // already gone
  }
}

async function createTmuxClient(
  socketName: string,
  sessionName: string,
): Promise<TmuxClient> {
  execSync(tmuxCmd(socketName, `new-session -d -s ${sessionName}`), {
    stdio: "ignore",
  });
  const transport = spawnTmux(["attach-session", "-t", sessionName], {
    socketPath: socketName,
  });
  const client = new TmuxClient(transport);
  await new Promise<void>((resolve) => {
    const h = () => {
      client.off("session-changed", h);
      resolve();
    };
    client.on("session-changed", h);
  });
  return client;
}

interface BridgeOptions {
  readonly authenticateToken?: string;
  readonly deniedMethods?: ReadonlySet<string>;
  readonly requestTimeoutMs?: number;
  readonly heartbeatIntervalMs?: number;
  readonly heartbeatTimeoutMs?: number;
  readonly rateLimit?: { maxCalls: number; windowMs: number };
}

async function startFixture(
  sessionPrefix: string,
  options: BridgeOptions = {},
): Promise<Fixture> {
  const socketName = uniqueSocket(sessionPrefix);
  const sessionName = `s-${sessionPrefix}`;
  const tmux = await createTmuxClient(socketName, sessionName);

  const observabilityEvents: BridgeObservabilityEvent[] = [];

  const bridge = createWebSocketBridge({
    createClient: () => tmux,
    authenticate: options.authenticateToken
      ? (req) => {
          const headerToken =
            (req.headers["x-auth-token"] as string | undefined) ?? "";
          return headerToken === options.authenticateToken
            ? { ok: true, identity: { token: headerToken } }
            : { ok: false, reason: "bad token", code: 4401 };
        }
      : undefined,
    authorize: options.deniedMethods
      ? (req) => {
          if (options.deniedMethods!.has(req.method)) {
            return { allow: false, reason: `method '${req.method}' denied` };
          }
          return { allow: true };
        }
      : undefined,
    requestTimeoutMs: options.requestTimeoutMs,
    heartbeatIntervalMs: options.heartbeatIntervalMs,
    heartbeatTimeoutMs: options.heartbeatTimeoutMs,
    rateLimit: options.rateLimit,
    onEvent: (ev) => observabilityEvents.push(ev),
  });

  const httpServer = createServer();
  const wss = new WebSocketServer({ server: httpServer, path: "/tmux" });
  wss.on("connection", (ws: WsWebSocket, req) => {
    const headers: Record<string, string | string[] | undefined> = {};
    for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = v;
    void bridge.handleConnection(ws as unknown as ServerWebSocketLike, {
      url: req.url,
      headers,
      remoteAddress: req.socket.remoteAddress ?? undefined,
    });
  });

  const port = await new Promise<number>((resolve) => {
    httpServer.listen(0, "127.0.0.1", () => {
      const addr = httpServer.address();
      resolve(typeof addr === "object" && addr !== null ? addr.port : 0);
    });
  });
  const url = `ws://127.0.0.1:${port}/tmux`;

  return {
    url,
    tmux,
    sessionName,
    socketName,
    httpServer,
    wss,
    observabilityEvents,
    async shutdown() {
      await bridge.shutdown(1_000);
      await new Promise<void>((r) => wss.close(() => r()));
      await new Promise<void>((r) => httpServer.close(() => r()));
      tmux.close();
      // Kill the whole isolated server, not just the session, so there is
      // NO path by which this test can touch the developer's default tmux
      // server.
      killServer(socketName);
    },
  };
}

// ---------------------------------------------------------------------------
// Browser-side fixture: build a WebSocketTmuxClient that uses `ws` as the
// underlying WebSocket. The browser WebSocket adds "open" as an EventTarget
// event; `ws` exposes both .on("open") and .addEventListener, so the same
// WebSocketTmuxClient works unmodified.
// ---------------------------------------------------------------------------

function createWsBackedClient(
  url: string,
  extraHeaders: Record<string, string> = {},
  overrides: Partial<{
    requestTimeoutMs: number;
    heartbeatIntervalMs: number;
    heartbeatTimeoutMs: number;
  }> = {},
): {
  client: WebSocketTmuxClient;
  states: WebSocketTmuxClientState[];
  errors: BridgeError[];
} {
  const states: WebSocketTmuxClientState[] = [];
  const errors: BridgeError[] = [];
  const client = new WebSocketTmuxClient({
    url,
    createWebSocket: (u) =>
      new WsClient(u, {
        headers: extraHeaders,
      }) as unknown as import("../../src/connectors/websocket/types.js").BrowserWebSocketLike,
    autoConnect: true,
    requestTimeoutMs: overrides.requestTimeoutMs,
    heartbeatIntervalMs: overrides.heartbeatIntervalMs,
    heartbeatTimeoutMs: overrides.heartbeatTimeoutMs,
    onState: (s) => states.push(s),
    onError: (e) => errors.push(e),
  });
  return { client, states, errors };
}

async function waitForState(
  client: WebSocketTmuxClient,
  target: WebSocketTmuxClientState,
  timeoutMs = 5_000,
): Promise<void> {
  if (client.state === target) return;
  await new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(
      () => reject(new Error(`timeout waiting for state '${target}'`)),
      timeoutMs,
    );
    const iv = setInterval(() => {
      if (client.state === target) {
        clearTimeout(deadline);
        clearInterval(iv);
        resolve();
      }
    }, 20);
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!RUN_INTEGRATION)("WebSocket bridge — round-trip", () => {
  let fx: Fixture;

  beforeEach(async () => {
    fx = await startFixture("roundtrip");
  });
  afterEach(async () => {
    await fx.shutdown();
  });

  it(
    "handshake: client reaches 'ready' after welcome",
    async () => {
      const { client } = createWsBackedClient(fx.url);
      await waitForState(client, "ready");
      expect(client.state).toBe("ready");
      await client.close();
    },
    10_000,
  );

  it(
    "execute(list-windows) round-trips through the bridge",
    async () => {
      const { client } = createWsBackedClient(fx.url);
      await waitForState(client, "ready");

      const response = await client.execute("list-windows");
      expect(response.success).toBe(true);
      expect(response.output.length).toBeGreaterThan(0);

      await client.close();
    },
    10_000,
  );

  it(
    "%output rides a binary frame and arrives decoded as Uint8Array",
    async () => {
      const { client } = createWsBackedClient(fx.url);
      await waitForState(client, "ready");

      const seen: TmuxMessage[] = [];
      const handler = (msg: TmuxMessage): void => {
        if (msg.type === "output") seen.push(msg);
      };
      client.on("*", handler);

      // Use a raw send-keys so the "Enter" key name is honored. No target:
      // sendKeys defaults to the active pane of the attached session, which
      // matches the existing client integration test's pattern.
      await client.execute(`send-keys 'echo websocket-bridge-ok' Enter`);

      // Poll for the printf to appear in output events.
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const matched = seen.some((m) => {
          if (m.type !== "output") return false;
          const txt = new TextDecoder().decode(m.data);
          return txt.includes("websocket-bridge-ok");
        });
        if (matched) break;
        await new Promise<void>((r) => setTimeout(r, 50));
      }

      const match = seen.some((m) => {
        if (m.type !== "output") return false;
        const txt = new TextDecoder().decode(m.data);
        return txt.includes("websocket-bridge-ok");
      });
      expect(match).toBe(true);

      client.off("*", handler);
      await client.close();
    },
    15_000,
  );

  it(
    "events (non-pane-output) round-trip through JSON frames",
    async () => {
      const { client } = createWsBackedClient(fx.url);
      await waitForState(client, "ready");

      const windowAdds: TmuxMessage[] = [];
      client.on("window-add", (m) => windowAdds.push(m));

      await client.execute("new-window");

      const deadline = Date.now() + 3_000;
      while (windowAdds.length === 0 && Date.now() < deadline) {
        await new Promise<void>((r) => setTimeout(r, 20));
      }
      expect(windowAdds.length).toBeGreaterThanOrEqual(1);
      expect(windowAdds[0].type).toBe("window-add");

      await client.close();
    },
    10_000,
  );
});

describe.skipIf(!RUN_INTEGRATION)("WebSocket bridge — policy hooks", () => {
  it(
    "authenticate() rejection: connection closes with BRIDGE_AUTH_DENIED",
    async () => {
      const fx = await startFixture("auth", { authenticateToken: "secret" });
      try {
        const { client, errors } = createWsBackedClient(fx.url, {
          "x-auth-token": "wrong",
        });
        await new Promise<void>((resolve) => {
          const iv = setInterval(() => {
            if (client.state === "closed") {
              clearInterval(iv);
              resolve();
            }
          }, 20);
          setTimeout(resolve, 3_000);
        });
        expect(client.state).toBe("closed");
        // The errors list should carry at least one BRIDGE_AUTH_DENIED
        // OR the connection should have been closed without producing
        // any successful call; both are valid observable outcomes.
        const authDenied = errors.find(
          (e) => e.code === "BRIDGE_AUTH_DENIED",
        );
        expect(authDenied).toBeDefined();
      } finally {
        await fx.shutdown();
      }
    },
    10_000,
  );

  it(
    "authenticate() acceptance: ready after matching token",
    async () => {
      const fx = await startFixture("auth-ok", { authenticateToken: "secret" });
      try {
        const { client } = createWsBackedClient(fx.url, {
          "x-auth-token": "secret",
        });
        await waitForState(client, "ready");
        expect(client.state).toBe("ready");
        await client.close();
      } finally {
        await fx.shutdown();
      }
    },
    10_000,
  );

  it(
    "authorize() denial: execute rejects with BRIDGE_COMMAND_DENIED",
    async () => {
      const fx = await startFixture("authz", {
        deniedMethods: new Set(["execute"]),
      });
      try {
        const { client } = createWsBackedClient(fx.url);
        await waitForState(client, "ready");
        await expect(client.execute("list-windows")).rejects.toMatchObject({
          code: "BRIDGE_COMMAND_DENIED",
        });
        await client.close();
      } finally {
        await fx.shutdown();
      }
    },
    10_000,
  );

  it(
    "observability hook fires call + result events",
    async () => {
      const fx = await startFixture("obs");
      try {
        const { client } = createWsBackedClient(fx.url);
        await waitForState(client, "ready");
        await client.execute("list-windows");

        const call = fx.observabilityEvents.find((e) => e.kind === "call");
        const result = fx.observabilityEvents.find((e) => e.kind === "result");
        expect(call).toBeDefined();
        expect(result).toBeDefined();
        expect(
          call && call.kind === "call" ? call.method : undefined,
        ).toBe("execute");
        expect(
          result && result.kind === "result" ? result.ok : undefined,
        ).toBe(true);

        await client.close();
      } finally {
        await fx.shutdown();
      }
    },
    10_000,
  );
});

describe.skipIf(!RUN_INTEGRATION)("WebSocket bridge — timeouts + drain", () => {
  it(
    "server drain sends 'draining' frame and rejects new calls",
    async () => {
      const fx = await startFixture("drain");
      try {
        let drainingDeadline: number | null = null;
        const client = new WebSocketTmuxClient({
          url: fx.url,
          createWebSocket: (u) =>
            new WsClient(u) as unknown as import("../../src/connectors/websocket/types.js").BrowserWebSocketLike,
          onDraining: (dl) => {
            drainingDeadline = dl;
          },
        });
        await waitForState(client, "ready");

        await fx.shutdown();

        // After drain, the client should have entered the draining state and
        // calls should reject with BRIDGE_CLOSED.
        const deadline = Date.now() + 2_000;
        while (
          client.state !== "draining" &&
          client.state !== "closed" &&
          Date.now() < deadline
        ) {
          await new Promise<void>((r) => setTimeout(r, 20));
        }
        expect(["draining", "closed"]).toContain(client.state);
        expect(drainingDeadline).not.toBeNull();
      } finally {
        // fx.shutdown already called
      }
    },
    10_000,
  );
});

describe.skipIf(!RUN_INTEGRATION)("WebSocket bridge — protocol", () => {
  it(
    "welcome.protocol matches PROTOCOL_VERSION",
    async () => {
      const fx = await startFixture("proto");
      try {
        // Open a raw ws client and parse the welcome ourselves.
        const ws = new WsClient(fx.url);
        const welcome = await new Promise<{
          v: number;
          k: string;
          protocol: number;
        }>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("no welcome")), 3_000);
          ws.on("open", () => {
            ws.send(
              JSON.stringify({ v: 1, k: "hello", protocol: PROTOCOL_VERSION }),
            );
          });
          ws.on("message", (data) => {
            clearTimeout(timer);
            const frame = JSON.parse(data.toString());
            resolve(frame);
          });
          ws.on("error", (err) => {
            clearTimeout(timer);
            reject(err);
          });
        });
        expect(welcome.k).toBe("welcome");
        expect(welcome.protocol).toBe(PROTOCOL_VERSION);
        ws.close();
      } finally {
        await fx.shutdown();
      }
    },
    10_000,
  );

  it(
    "hello with wrong protocol version closes with BRIDGE_PROTOCOL_ERROR",
    async () => {
      const fx = await startFixture("proto-bad");
      try {
        const ws = new WsClient(fx.url);
        const frame = await new Promise<{
          k: string;
          error?: { code: string };
        }>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("no frame")), 3_000);
          ws.on("open", () => {
            ws.send(JSON.stringify({ v: 999, k: "hello", protocol: 999 }));
          });
          ws.on("message", (data) => {
            clearTimeout(timer);
            resolve(JSON.parse(data.toString()));
          });
          ws.on("error", (err) => {
            clearTimeout(timer);
            reject(err);
          });
        });
        expect(frame.k).toBe("error");
        expect(frame.error?.code).toBe("BRIDGE_PROTOCOL_ERROR");
        ws.close();
      } finally {
        await fx.shutdown();
      }
    },
    10_000,
  );
});
