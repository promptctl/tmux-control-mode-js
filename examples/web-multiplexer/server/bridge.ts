// examples/web-multiplexer/server/bridge.ts
// Bridge server: wraps a TmuxClient and exposes it to browsers over WebSocket.
//
// Architecture:
//   browser <-- WebSocket (JSON) --> bridge <-- spawn + control protocol --> tmux
//
// The browser never imports the tmux-control-mode-js runtime — only types.
// All wire-protocol parsing and encoding happens here on the Node side.

import { createServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { TmuxClient } from "../../../src/client.js";
import { spawnTmux } from "../../../src/transport/spawn.js";
import type { TmuxMessage } from "../../../src/protocol/types.js";
import type {
  ClientToServer,
  ServerToClient,
  SerializedTmuxMessage,
} from "../shared/protocol.js";
import { BRIDGE_PORT, WEB_PORT } from "../shared/config.js";

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/**
 * Convert a Uint8Array to a base64 string using Node's Buffer.
 * Kept as a tiny helper so the intent is obvious at the call site.
 */
function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

/**
 * Serialize a TmuxMessage for JSON transport. The only types that need
 * special handling are `output` and `extended-output`, which carry
 * `Uint8Array` data.
 *
 * [LAW:dataflow-not-control-flow] Returns the same shape regardless of
 * type; the variability lives in which fields are set.
 */
function serialize(msg: TmuxMessage): SerializedTmuxMessage {
  if (msg.type === "output") {
    return { type: "output", paneId: msg.paneId, dataBase64: toBase64(msg.data) };
  }
  if (msg.type === "extended-output") {
    return {
      type: "extended-output",
      paneId: msg.paneId,
      age: msg.age,
      dataBase64: toBase64(msg.data),
    };
  }
  return msg;
}

// ---------------------------------------------------------------------------
// Per-connection state
// ---------------------------------------------------------------------------

/**
 * Each WebSocket connection gets its own TmuxClient. This keeps one browser
 * session independent from another (no shared state, no cross-talk).
 */
interface ConnectionState {
  readonly ws: WebSocket;
  readonly client: TmuxClient;
}

const connections = new Set<ConnectionState>();

function removeConnection(connection: ConnectionState): void {
  connections.delete(connection);
}

function closeConnection(connection: ConnectionState): void {
  removeConnection(connection);
  connection.client.close();
  if (
    connection.ws.readyState === connection.ws.OPEN ||
    connection.ws.readyState === connection.ws.CONNECTING
  ) {
    connection.ws.terminate();
  }
}

function handleConnection(ws: WebSocket): void {
  const send = (frame: ServerToClient): void => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(frame));
    }
  };

  // Spawn tmux in -C mode against the host's existing tmux server.
  // No explicit socket path — use the default server the user already has.
  const transport = spawnTmux(["attach-session"]);
  const client = new TmuxClient(transport);
  const connection = { ws, client };
  connections.add(connection);

  // [LAW:dataflow-not-control-flow] Forward every message through the same
  // pipeline. The `*` wildcard is the single enforcement point.
  client.on("*", (msg: TmuxMessage) => {
    send({ kind: "event", event: serialize(msg) });
  });

  // Fire a ready frame after the session-changed handshake arrives.
  const onSessionChanged = () => {
    client.off("session-changed", onSessionChanged);
    send({ kind: "ready" });
  };
  client.on("session-changed", onSessionChanged);

  // [LAW:single-enforcer] When the underlying tmux client exits (user ran
  // detach-client, tmux server died, etc.), tear down the WebSocket so the
  // browser's connState transitions to "closed". Without this the browser
  // would keep thinking the bridge is alive and the clickable reconnect
  // Badge would never appear.
  client.on("exit", () => {
    closeConnection(connection);
  });

  // Forward browser commands to the TmuxClient and correlate responses.
  ws.on("message", async (raw: Buffer) => {
    let msg: ClientToServer;
    try {
      msg = JSON.parse(raw.toString("utf8")) as ClientToServer;
    } catch {
      send({ kind: "error", message: "invalid JSON frame from browser" });
      return;
    }

    try {
      if (msg.kind === "execute") {
        const response = await client
          .execute(msg.command)
          .catch((r) => r); // both resolve and reject carry CommandResponse
        send({ kind: "response", id: msg.id, response });
        return;
      }
      if (msg.kind === "sendKeys") {
        const response = await client
          .sendKeys(msg.target, msg.keys)
          .catch((r) => r);
        send({ kind: "response", id: msg.id, response });
        return;
      }
      if (msg.kind === "detach") {
        client.detach();
        return;
      }
    } catch (err) {
      send({
        kind: "error",
        id: (msg as ClientToServer).id as string | undefined,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  ws.on("close", () => {
    closeConnection(connection);
  });
}

// ---------------------------------------------------------------------------
// HTTP + WebSocket server
// ---------------------------------------------------------------------------

const httpServer = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("tmux-control-mode-js demo bridge — connect to /ws via WebSocket\n");
});

const wss = new WebSocketServer({ server: httpServer, path: "/ws" });
wss.on("connection", (ws) => {
  console.log("[bridge] client connected");
  try {
    handleConnection(ws);
  } catch (err) {
    console.error("[bridge] connection failed:", err);
    ws.close();
  }
});

httpServer.listen(BRIDGE_PORT, () => {
  console.log(`[bridge] listening on http://localhost:${BRIDGE_PORT} (WS at /ws)`);
  console.log(`[bridge] open the Vite dev server (default http://localhost:${WEB_PORT})`);
});

let shuttingDown = false;

function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;

  // [LAW:single-enforcer] Bridge teardown is centralized here so Ctrl+C and
  // watcher restarts close sockets and tmux clients through one path.
  for (const connection of [...connections]) {
    closeConnection(connection);
  }

  wss.close();
  httpServer.close();
  setImmediate(() => {
    process.exit(0);
  });
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
