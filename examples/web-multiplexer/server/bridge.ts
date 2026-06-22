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
import { TmuxClient } from "@promptctl/tmux-control-mode-js";
import { spawnTmux } from "@promptctl/tmux-control-mode-js";
import { isTmuxMessage } from "@promptctl/tmux-control-mode-js";
import { serverScope } from "@promptctl/tmux-control-mode-js";
import { sendKeys } from "@promptctl/tmux-control-mode-js";
import type { EmitterMessage } from "@promptctl/tmux-control-mode-js";
import { attachWebSocketSink } from "@promptctl/tmux-control-mode-js/websocket";
import type { ClientToServer, ServerToClient } from "../shared/protocol.js";
import { BRIDGE_PORT, WEB_PORT } from "../shared/config.js";

// ---------------------------------------------------------------------------
// Outbound forwarding: TmuxClient → WebSocket
// ---------------------------------------------------------------------------

/**
 * Minimum WebSocket surface this bridge sends on: binary pane-output frames
 * (via the library's WebSocketSink) and JSON text frames (state events,
 * responses). The `ws` package's WebSocket and a test double both satisfy it.
 */
export interface BridgeSocket {
  readonly readyState: number;
  readonly OPEN: number;
  send(data: string | ArrayBufferLike | ArrayBufferView): void;
}

/**
 * Wire a `TmuxClient`'s outbound traffic onto a WebSocket and return a
 * disposer. Two channels, one boundary:
 *
 *   - pane bytes → binary pane-output frames, encoded by the library's
 *     `WebSocketSink` (`attachWebSocketSink`). The bridge never touches the
 *     bytes; the browser decodes with the matching `decodePaneOutput`.
 *   - every non-byte event → a JSON `event` frame.
 *
 * [LAW:single-enforcer] The one place that forwards client traffic to a
 *   socket — the live server and its tests share this wiring, so neither can
 *   drift from the other.
 * [LAW:effects-at-boundaries] Pure wiring: no `listen`, no process state. The
 *   caller owns the socket and the server lifecycle.
 */
export function forwardClientToSocket(
  client: TmuxClient,
  ws: BridgeSocket,
): () => void {
  const detachBytes = attachWebSocketSink(client, ws, { scope: serverScope });

  // [LAW:dataflow-not-control-flow] `client.on("*")` carries
  // `EmitterTmuxMessage` only — pane bytes are structurally excluded from the
  // emitter (they ride the binary sink above), so this channel is JSON state
  // events end to end. ConnectionStateMessage / ReconnectedMessage are local
  // lifecycle signals; they are not forwarded over the wire.
  const onEvent = (msg: EmitterMessage): void => {
    if (!isTmuxMessage(msg)) return;
    if (ws.readyState === ws.OPEN) {
      const frame: ServerToClient = { kind: "event", event: msg };
      ws.send(JSON.stringify(frame));
    }
  };
  client.on("*", onEvent);

  return () => {
    detachBytes();
    client.off("*", onEvent);
  };
}

// ---------------------------------------------------------------------------
// Per-connection state
// ---------------------------------------------------------------------------

/**
 * Each WebSocket connection gets its own TmuxClient. This keeps one browser
 * session independent from another (no shared state, no cross-talk).
 *
 * `detachBytes` tears down the per-connection pane-byte sink (the binary
 * pane-output channel) when the connection closes.
 */
interface ConnectionState {
  readonly ws: WebSocket;
  readonly client: TmuxClient;
  readonly detachBytes: () => void;
}

const connections = new Set<ConnectionState>();

function removeConnection(connection: ConnectionState): void {
  connections.delete(connection);
}

function closeConnection(connection: ConnectionState): void {
  removeConnection(connection);
  connection.detachBytes();
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

  // Pane bytes (binary frames) + non-byte events (JSON) are forwarded by the
  // shared wiring; `detachBytes` tears both down on close.
  const detachBytes = forwardClientToSocket(client, ws);

  const connection = { ws, client, detachBytes };
  connections.add(connection);

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
        const response = await client.execute(msg.command).catch((r) => r); // both resolve and reject carry CommandResponse
        send({ kind: "response", id: msg.id, response });
        return;
      }
      if (msg.kind === "sendKeys") {
        // [LAW:decomposition] sendKeys is a free command function over the
        // TmuxConnection surface, not a TmuxClient method — one shared
        // implementation for every connector.
        const response = await sendKeys(client, msg.target, msg.keys).catch(
          (r) => r,
        );
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

/** A running bridge server. `close()` tears down every connection + listener. */
export interface BridgeHandle {
  close(): void;
}

/**
 * Construct the HTTP + WebSocket bridge and start listening. Returns a handle
 * whose `close()` centralizes teardown (Ctrl+C, watcher restart, test cleanup)
 * through one path. [LAW:single-enforcer]
 *
 * The process entry (`server/main.ts`) owns the signal handlers; importing
 * this module performs no I/O, so tests can exercise `forwardClientToSocket`
 * without binding a port. [LAW:effects-at-boundaries]
 */
export function startBridge(port: number = BRIDGE_PORT): BridgeHandle {
  const httpServer = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(
      "tmux-control-mode-js demo bridge — connect to /ws via WebSocket\n",
    );
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

  httpServer.listen(port, () => {
    console.log(`[bridge] listening on http://localhost:${port} (WS at /ws)`);
    console.log(
      `[bridge] open the Vite dev server (default http://localhost:${WEB_PORT})`,
    );
  });

  return {
    close(): void {
      for (const connection of [...connections]) {
        closeConnection(connection);
      }
      wss.close();
      httpServer.close();
    },
  };
}
