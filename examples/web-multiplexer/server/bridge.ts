// examples/web-multiplexer/server/bridge.ts
// Bridge server: hosts the library's first-party WebSocket bridge so a
// browser can drive a tmux session through the canonical
// `@promptctl/tmux-control-mode-js/websocket/server` surface.
//
// Architecture:
//   browser <-- WebSocket --> createWebSocketBridge <-- spawn + control
//                                                       protocol --> tmux
//
// This file owns only what the demo specifically needs:
//   - HTTP server + WebSocketServer at a known port (the library is
//     transport-agnostic; the host wires up the actual socket).
//   - The `createClient` hook that spawns one TmuxClient per WebSocket,
//     honoring the demo's `TMUX_DEMO_SOCKET` / `TMUX_DEMO_SESSION` env
//     contract (shared with the Electron demo so a single test harness
//     drives both targets).
//   - The `disposeClient` hook that closes the per-connection TmuxClient
//     when the browser disconnects — without this, every refresh would
//     leak a tmux attach.
//   - SIGINT/SIGTERM shutdown that flushes the bridge.
//
// Everything else — frame encoding, RPC dispatch, hello/welcome handshake,
// heartbeats, drain, binary pane-output framing — lives in the library.

import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { TmuxClient } from "../../../src/client.js";
import { spawnTmux } from "../../../src/transport/spawn.js";
import { createWebSocketBridge } from "../../../src/connectors/websocket/server.js";
import { BRIDGE_PORT, WEB_PORT } from "../shared/config.js";

// ---------------------------------------------------------------------------
// Library bridge — owns wire framing, RPC dispatch, lifecycle.
// ---------------------------------------------------------------------------

// [LAW:single-enforcer] One client per WebSocket. The library's default is
// to share clients across connections (suitable for multi-tenant servers);
// the demo's contract is "fresh tmux attach per browser tab" so we spawn
// in createClient and tear down in disposeClient.
const bridge = createWebSocketBridge({
  createClient: () => {
    // Spawn tmux in -C mode. By default we attach to whatever the user's
    // host tmux server is already serving (no -L, no -t). For e2e/test
    // isolation, TMUX_DEMO_SOCKET pins us to a private `-L` socket and
    // TMUX_DEMO_SESSION targets a specific session — same env contract
    // the Electron main honors, so a single test harness can drive both
    // targets. Either env var is independent: socket alone with no
    // session attaches whatever exists on that socket; session alone
    // with no socket targets the default server's named session.
    const SOCKET = process.env.TMUX_DEMO_SOCKET;
    const SESSION = process.env.TMUX_DEMO_SESSION;
    const attachArgs =
      SESSION === undefined
        ? ["attach-session"]
        : ["attach-session", "-t", SESSION];
    const transport = spawnTmux(
      attachArgs,
      SOCKET === undefined ? undefined : { socketPath: SOCKET },
    );
    return new TmuxClient(transport);
  },
  disposeClient: (client) => {
    client.close();
  },
});

// ---------------------------------------------------------------------------
// HTTP + WebSocket server
// ---------------------------------------------------------------------------

const httpServer = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("tmux-control-mode-js demo bridge — connect to /ws via WebSocket\n");
});

const wss = new WebSocketServer({ server: httpServer, path: "/ws" });
wss.on("connection", (ws, request) => {
  console.log("[bridge] client connected");
  // The library bridge's handleConnection takes ownership of the socket.
  // It returns when the connection closes (graceful or otherwise).
  void bridge.handleConnection(ws, request).catch((err: unknown) => {
    console.error("[bridge] connection failed:", err);
  });
});

httpServer.listen(BRIDGE_PORT, () => {
  console.log(
    `[bridge] listening on http://localhost:${BRIDGE_PORT} (WS at /ws)`,
  );
  console.log(
    `[bridge] open the Vite dev server (default http://localhost:${WEB_PORT})`,
  );
});

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

let shuttingDown = false;

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  // [LAW:single-enforcer] Bridge teardown is centralized: the library's
  // shutdown drains live connections and rejects new ones; once it
  // resolves we can close the HTTP server and exit.
  await bridge.shutdown();
  wss.close();
  httpServer.close();
  setImmediate(() => {
    process.exit(0);
  });
}

process.once("SIGINT", () => {
  void shutdown();
});
process.once("SIGTERM", () => {
  void shutdown();
});
