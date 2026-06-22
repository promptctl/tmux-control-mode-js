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
import type { EmitterMessage } from "../../src/emitter.js";

import { createWebSocketBridge } from "../../src/connectors/websocket/server.js";
import {
  WebSocketTmuxClient,
  type WebSocketTmuxClientState,
} from "../../src/connectors/websocket/client.js";
import { BridgeError } from "../../src/connectors/websocket/protocol.js";
import type {
  BridgeObservabilityEvent,
  ServerWebSocketLike,
} from "../../src/connectors/websocket/types.js";
import { serverScope, sessionScope, parsePaneListLine } from "../../src/pane-output.js";

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

      // Bytes flow through `attachBytesSink` (server scope = all panes) —
      // the WS client's emitter no longer carries `OutputMessage`.
      const seen: Uint8Array[] = [];
      const detach = client.attachBytesSink({
        write(msg) {
          // BytesSink contract: msg.data is read-only, copy before retention.
          seen.push(msg.data.slice());
        },
        end() {},
      });

      // Use a raw send-keys so the "Enter" key name is honored. No target:
      // sendKeys defaults to the active pane of the attached session, which
      // matches the existing client integration test's pattern.
      await client.execute(`send-keys 'echo websocket-bridge-ok' Enter`);

      // Poll for the printf to appear in the byte stream.
      const isMatch = (): boolean =>
        seen.some((data) =>
          new TextDecoder().decode(data).includes("websocket-bridge-ok"),
        );
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && !isMatch()) {
        await new Promise<void>((r) => setTimeout(r, 50));
      }
      expect(isMatch()).toBe(true);

      detach();
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

// ---------------------------------------------------------------------------
// qz5.5 — subscription scoping across two WS connections.
//
// The audit (C2) called out that the WS bridge had no per-connection
// subscription scoping: a peer could unsubscribe a name owned by another
// peer and tear down its subscription. The qz5.5 lift routes
// subscribe/unsubscribe through a per-Connection BridgeConnection helper,
// so a peer's unsubscribe of a name it does not own is rejected with
// BRIDGE_UNKNOWN_SUBSCRIPTION (the same code the Electron bridge raises).
//
// This test runs against the REAL `ws` package + a real tmux process — the
// unit-test version (tests/unit/websocket-bridge.test.ts) covers the same
// shape with fakes; this version pins that the wire-frame round-trip
// preserves the contract end-to-end.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// qz5.4 — WebSocketTmuxClient outbox/pending lifecycle across reconnect/close.
//
// The unit-test sibling (tests/unit/websocket-client-lifecycle.test.ts)
// pins the structural invariants against a fake browser WebSocket: pending
// IS the queue (no separate outbox to drift), close() settles pending
// synchronously, finalize is idempotent. These integration tests pin the
// same contract against the REAL `ws` package + a real tmux process so a
// future regression in the actual socket lifecycle (e.g. `ws` upgrading
// its close semantics) is caught end-to-end.
// ---------------------------------------------------------------------------

describe.skipIf(!RUN_INTEGRATION)(
  "WebSocket bridge — qz5.4 outbox/pending lifecycle (real socket)",
  () => {
    let fx: Fixture;
    beforeEach(async () => {
      fx = await startFixture("qz5-4");
    });
    afterEach(async () => {
      await fx.shutdown();
    });

    it(
      "call queued during reconnecting completes through the new connection",
      async () => {
        // Capture the underlying ws so the test can terminate it on demand
        // to simulate a transport failure.
        let lastWs: WsClient | null = null;
        const client = new WebSocketTmuxClient({
          url: fx.url,
          createWebSocket: (u) => {
            const ws = new WsClient(u);
            lastWs = ws;
            return ws as unknown as import("../../src/connectors/websocket/types.js").BrowserWebSocketLike;
          },
          reconnect: {
            maxAttempts: 5,
            initialDelayMs: 25,
            maxDelayMs: 50,
            factor: 1,
            jitterMs: 0,
          },
          heartbeatIntervalMs: 0,
        });

        try {
          await waitForState(client, "ready");
          // Baseline: confirm normal call/result round-trips before we
          // break the socket.
          const before = await client.execute("list-windows");
          expect(before.success).toBe(true);

          // Forcibly close the live socket. ws.terminate() sends no close
          // frame; the bridge sees an abnormal close, finalize runs, the
          // reconnect timer fires.
          expect(lastWs).not.toBeNull();
          (lastWs as unknown as WsClient).terminate();

          // Wait until the terminate's close has been OBSERVED by the
          // client — i.e. state has left "ready". Otherwise we'd race the
          // async close event and fire the call while the client still
          // thinks the socket is live, which would just reject through
          // the old connection's finalize with "close 1006".
          const leftReady = Date.now() + 2_000;
          while (client.state === "ready" && Date.now() < leftReady) {
            await new Promise<void>((r) => setTimeout(r, 5));
          }
          expect(client.state).not.toBe("ready");

          // Fire a call while the client is mid-flux. With the fix the
          // call is added to pending; flushOutbox transmits it on the
          // NEW connection after welcome, and the result routes back to
          // this same promise. The pre-fix bug would have surfaced as
          // the queued frame riding the new connection with a stale id
          // whose pending entry was already rejected — silent drop.
          const after = await client.execute("list-windows");
          expect(after.success).toBe(true);
        } finally {
          await client.close();
        }
      },
      15_000,
    );

    it(
      "close() settles in-flight call before resolving (M3 over real ws)",
      async () => {
        const { client } = createWsBackedClient(fx.url);
        try {
          await waitForState(client, "ready");

          // Fire a call but immediately close — the only observable answer
          // for the caller must be BRIDGE_CLOSED, not "pending forever".
          const callPromise = client.execute("list-windows");
          let settled = false;
          callPromise.catch(() => {
            settled = true;
          });

          await client.close();
          // Microtask flush so the .catch handler runs after rejection.
          await Promise.resolve();
          await Promise.resolve();

          expect(settled).toBe(true);
          await expect(callPromise).rejects.toMatchObject({
            code: "BRIDGE_CLOSED",
          });
        } finally {
          // Idempotent.
          await client.close();
        }
      },
      10_000,
    );
  },
);

describe.skipIf(!RUN_INTEGRATION)(
  "WebSocket bridge — qz5.5 subscription scoping (real socket)",
  () => {
    let fx: Fixture;
    beforeEach(async () => {
      fx = await startFixture("qz5-scope");
    });
    afterEach(async () => {
      await fx.shutdown();
    });

    it(
      "peer B's unsubscribe of a name only peer A owns is rejected with BRIDGE_UNKNOWN_SUBSCRIPTION",
      async () => {
        const a = createWsBackedClient(fx.url);
        const b = createWsBackedClient(fx.url);
        await Promise.all([
          waitForState(a.client, "ready"),
          waitForState(b.client, "ready"),
        ]);

        // A subscribes "qz5-focus".
        const aSub = await a.client.subscribeRaw(
          "qz5-focus",
          "",
          "#{pane_id}",
        );
        expect(aSub.success).toBe(true);

        // B's unsubscribe must be rejected — B never claimed "qz5-focus"
        // through its own helper, so the bridge raises
        // BRIDGE_UNKNOWN_SUBSCRIPTION at the trust boundary. tmux is
        // never asked to unsubscribe.
        const err = await b.client
          .unsubscribe("qz5-focus")
          .then(() => undefined, (e: unknown) => e);
        expect(err).toBeInstanceOf(BridgeError);
        expect((err as BridgeError).code).toBe("BRIDGE_UNKNOWN_SUBSCRIPTION");

        // A's subscription is preserved: A can still unsubscribe its
        // OWN name without surprises.
        const aUnsub = await a.client.unsubscribe("qz5-focus");
        expect(aUnsub.success).toBe(true);

        a.client.close();
        b.client.close();
      },
      15_000,
    );
  },
);

// ---------------------------------------------------------------------------
// INT-20 & INT-21: WebSocket forwarder scope tests
//
// INT-20: serverScope delivers bytes from two different panes over the bridge.
// INT-21: sessionScope($A) delivers bytes from $A but not from $B.
// ---------------------------------------------------------------------------

describe.skipIf(!RUN_INTEGRATION)("WebSocket bridge — bytes sink scope", () => {
  let fx: Fixture;

  beforeEach(async () => {
    fx = await startFixture("bytes-scope");
  });
  afterEach(async () => {
    await fx.shutdown();
  });

  it(
    "INT-20: serverScope delivers bytes from two panes over WS bridge",
    async () => {
      const { client } = createWsBackedClient(fx.url);
      await waitForState(client, "ready");

      // Open a second window so we have two panes on the server.
      await client.execute("new-window");

      // Get the two pane IDs.
      const listResp = await client.execute(
        "list-panes -a -F '#{pane_id} #{window_id} #{session_id}'",
      );
      const paneIds = listResp.output
        .flatMap((line) => {
          const p = parsePaneListLine(line);
          return p !== null ? [p.paneId] : [];
        })
        .slice(0, 2);
      expect(paneIds.length).toBeGreaterThanOrEqual(2);
      const [pane0, pane1] = paneIds;

      // Attach with serverScope — both panes should produce chunks.
      const received = new Map<number, Uint8Array[]>();
      const dispose = client.attachBytesSink(
        {
          write(msg) {
            const arr = received.get(msg.paneId) ?? [];
            arr.push(msg.data.slice());
            received.set(msg.paneId, arr);
          },
          end() {},
        },
        { scope: serverScope },
      );

      // Drive output in both panes via the main tmux client.
      await fx.tmux.execute(`send-keys -t %${pane0} 'echo ws-int20-p0' Enter`);
      await fx.tmux.execute(`send-keys -t %${pane1} 'echo ws-int20-p1' Enter`);

      const deadline = Date.now() + 8_000;
      const hasP0 = () =>
        (received.get(pane0) ?? []).some((d) =>
          Buffer.from(d).toString().includes("ws-int20-p0"),
        );
      const hasP1 = () =>
        (received.get(pane1) ?? []).some((d) =>
          Buffer.from(d).toString().includes("ws-int20-p1"),
        );
      while ((!hasP0() || !hasP1()) && Date.now() < deadline) {
        await new Promise<void>((r) => setTimeout(r, 30));
      }

      expect(hasP0()).toBe(true);
      expect(hasP1()).toBe(true);

      dispose();
      await client.close();
    },
    20_000,
  );

  it(
    "INT-21: sessionScope($A) receives bytes from $A but not from $B",
    async () => {
      // Create a second session on the same tmux server.
      const sessionBName = `s-bytes-scope-B-${Date.now()}`;
      await fx.tmux.execute(`new-session -d -s ${sessionBName}`);

      // Get all panes — find one in $A (original session) and one in $B.
      const listResp = await fx.tmux.execute(
        "list-panes -a -F '#{pane_id} #{window_id} #{session_id}'",
      );
      let paneA: number | null = null;
      let paneB: number | null = null;
      for (const line of listResp.output) {
        const p = parsePaneListLine(line);
        if (p === null) continue;
        if (paneA === null && p.sessionId !== -1) {
          // First pane from the session we attached (session with the tmux client).
          // The tmux client's session is the one named fx.sessionName; find it
          // by querying session ID.
          paneA = p.paneId;
        } else if (paneB === null) {
          paneB = p.paneId;
        }
        if (paneA !== null && paneB !== null) break;
      }
      expect(paneA).not.toBeNull();
      expect(paneB).not.toBeNull();

      // Determine the session ID for session A (the original session).
      const sessionIdResp = await fx.tmux.execute(
        `list-sessions -F '#{session_id} #{session_name}'`,
      );
      let sessionAId: string | null = null;
      for (const line of sessionIdResp.output) {
        const m = line.match(/^(\$\d+)\s+(.+)$/);
        if (m && m[2] === fx.sessionName) {
          sessionAId = m[1];
          break;
        }
      }
      expect(sessionAId).not.toBeNull();

      const { client } = createWsBackedClient(fx.url);
      await waitForState(client, "ready");

      const received = new Map<number, Uint8Array[]>();
      const dispose = client.attachBytesSink(
        {
          write(msg) {
            const arr = received.get(msg.paneId) ?? [];
            arr.push(msg.data.slice());
            received.set(msg.paneId, arr);
          },
          end() {},
        },
        // sessionAId is "$N" — sessionScope takes the numeric N.
        { scope: sessionScope(parseInt(sessionAId!.slice(1), 10)) },
      );

      // Drive output in session A's pane and session B's pane.
      await fx.tmux.execute(`send-keys -t %${paneA} 'echo ws-int21-a' Enter`);
      await fx.tmux.execute(`send-keys -t %${paneB!} 'echo ws-int21-b' Enter`);

      // Wait for session A's bytes to arrive.
      const hasA = () =>
        (received.get(paneA!) ?? []).some((d) =>
          Buffer.from(d).toString().includes("ws-int21-a"),
        );
      const deadline = Date.now() + 8_000;
      while (!hasA() && Date.now() < deadline) {
        await new Promise<void>((r) => setTimeout(r, 30));
      }

      // Brief extra wait to catch any session B leakage.
      await new Promise<void>((r) => setTimeout(r, 500));

      expect(hasA()).toBe(true);

      // Session B's pane should not have delivered bytes to this scope.
      const hasB = (received.get(paneB!) ?? []).some((d) =>
        Buffer.from(d).toString().includes("ws-int21-b"),
      );
      expect(hasB).toBe(false);

      dispose();
      await client.close();
    },
    25_000,
  );
});

