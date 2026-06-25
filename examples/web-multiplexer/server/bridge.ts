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
import { PaneFirehose } from "./pane-firehose.js";
import { encodeFirehoseFrame } from "../shared/firehose-frame.js";
import { MirrorRegistry, type MirrorViewer } from "./mirror-registry.js";
import { CollabInput } from "./collab-input.js";
import {
  parseMirrorPane,
  MIRROR_WS_PATH,
  type MirrorControlFrame,
} from "../shared/mirror-frame.js";
import { COLLAB_WS_PATH, parseCollabKeys } from "../shared/collab-frame.js";
import { demoAttachArgs } from "./tmux-target.js";

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
  /**
   * The cross-terminal firehose for this connection, lazily created on the
   * first `startFirehose` and torn down on `stopFirehose` or close. Null while
   * the browser isn't in regex-matcher mode, so idle connections pay no
   * pipe-pane cost.
   */
  firehose: PaneFirehose | null;
}

const connections = new Set<ConnectionState>();

function removeConnection(connection: ConnectionState): void {
  connections.delete(connection);
}

function closeConnection(connection: ConnectionState): void {
  removeConnection(connection);
  connection.firehose?.stop();
  connection.firehose = null;
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

  // Spawn tmux in -C mode against the demo's target server (default server, or
  // a `TMUX_DEMO_SOCKET`-pinned `-L` socket). [LAW:single-enforcer] the target
  // is computed in one place, shared with the mirror registry's client.
  const transport = spawnTmux(demoAttachArgs());
  const client = new TmuxClient(transport);

  // Pane bytes (binary frames) + non-byte events (JSON) are forwarded by the
  // shared wiring; `detachBytes` tears both down on close.
  const detachBytes = forwardClientToSocket(client, ws);

  const connection: ConnectionState = {
    ws,
    client,
    detachBytes,
    firehose: null,
  };
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
      if (msg.kind === "startFirehose") {
        // [LAW:single-enforcer] One firehose per connection. A repeat start
        // (e.g. re-entering regex mode) reuses the live one; PaneFirehose.start
        // is itself idempotent.
        if (connection.firehose === null) {
          connection.firehose = new PaneFirehose(
            (command) => client.execute(command),
            (paneId, data) => {
              if (ws.readyState === ws.OPEN) {
                ws.send(encodeFirehoseFrame(paneId, data));
              }
            },
          );
        }
        await connection.firehose.start();
        return;
      }
      if (msg.kind === "stopFirehose") {
        connection.firehose?.stop();
        connection.firehose = null;
        return;
      }
    } catch (err) {
      send({
        kind: "error",
        id: msg.id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  ws.on("close", () => {
    closeConnection(connection);
  });
}

// ---------------------------------------------------------------------------
// Read-only pane mirror: /mirror endpoint
// ---------------------------------------------------------------------------

/**
 * Wire a `/mirror` WebSocket to the registry as a read-only viewer of the pane
 * named in its query string (`/mirror?pane=%3`). The viewer is MUTE by
 * construction: this handler registers no `message` listener that forwards to
 * tmux — an inbound frame is a protocol violation and closes the socket. The
 * only path from browser to pane does not exist. [LAW:types-are-the-program]
 *
 * Binary frames carry pane bytes (seed then live); JSON text frames carry
 * lifecycle (size / viewers / gone / error) — the same two-channel split the
 * main bridge uses, so the browser distinguishes them by frame type.
 */
function handleMirrorConnection(
  ws: WebSocket,
  registry: MirrorRegistry,
  requestUrl: string,
): void {
  const q = requestUrl.indexOf("?");
  const paneId = parseMirrorPane(q === -1 ? "" : requestUrl.slice(q));
  const send = (frame: MirrorControlFrame): void => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
  };

  if (paneId === null) {
    send({ kind: "error", message: "mirror requires a ?pane=%N query" });
    ws.close();
    return;
  }

  const viewer: MirrorViewer = {
    sendControl: send,
    sendBytes: (data) => {
      if (ws.readyState === ws.OPEN) ws.send(data);
    },
    close: () => {
      if (
        ws.readyState === ws.OPEN ||
        ws.readyState === ws.CONNECTING
      ) {
        ws.close();
      }
    },
  };

  // [LAW:single-enforcer] One read-only contract, enforced server-side too: any
  //   inbound frame on a mirror socket is misuse — close it loudly rather than
  //   silently ignore. A legitimate viewer never sends. [LAW:no-silent-failure]
  ws.on("message", () => ws.close(1003, "mirror is read-only"));

  let dispose: (() => void) | null = null;
  let closed = false;
  ws.on("close", () => {
    closed = true;
    dispose?.();
  });

  void registry.addViewer(paneId, viewer).then((d) => {
    // The socket may have closed during the async seed; dispose immediately.
    if (closed) d();
    else dispose = d;
  });
}

// ---------------------------------------------------------------------------
// Collaborative pane: /collab-ws endpoint
// ---------------------------------------------------------------------------

/**
 * Wire a `/collab-ws` WebSocket as a READ-WRITE collaborator on the pane named
 * in its query string (`/collab-ws?pane=%3`). Output is the read-only mirror,
 * unchanged: the socket registers as a `MirrorViewer` and receives the same
 * seed → live bytes + lifecycle frames every viewer gets. [LAW:composability]
 * the output fan-out is reused whole, not re-implemented.
 *
 * What this endpoint ADDS over the mirror is exactly one capability: an inbound
 * `keys` frame is forwarded to the pane via `sendKeys`. Many browsers can hold
 * this socket on the same pane at once; tmux serialises their keystrokes into
 * one authoritative pane and the result fans back through the shared tap — so
 * "two browsers, one pane" needs no CRDT. [LAW:no-silent-failure] a frame that
 * is not a well-formed `keys` frame closes the socket loudly (1003) rather than
 * being ignored.
 */
function handleCollabConnection(
  ws: WebSocket,
  registry: MirrorRegistry,
  input: CollabInput,
  requestUrl: string,
): void {
  const q = requestUrl.indexOf("?");
  const paneId = parseMirrorPane(q === -1 ? "" : requestUrl.slice(q));
  const send = (frame: MirrorControlFrame): void => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
  };

  if (paneId === null) {
    send({ kind: "error", message: "collab requires a ?pane=%N query" });
    ws.close();
    return;
  }

  const viewer: MirrorViewer = {
    sendControl: send,
    sendBytes: (data) => {
      if (ws.readyState === ws.OPEN) ws.send(data);
    },
    close: () => {
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) {
        ws.close();
      }
    },
  };

  // The collaborative channel's ONE inbound capability: keystrokes → pane. A
  // frame that is not a valid `keys` frame is misuse, not data. [LAW:no-silent-
  // failure]
  ws.on("message", (raw: Buffer) => {
    const keys = parseCollabKeys(raw.toString("utf8"));
    if (keys === null) {
      ws.close(1003, "collab expects { kind: 'keys' } frames");
      return;
    }
    void input.sendKeys(paneId, keys);
  });

  let dispose: (() => void) | null = null;
  let closed = false;
  ws.on("close", () => {
    closed = true;
    dispose?.();
  });

  void registry.addViewer(paneId, viewer).then((d) => {
    if (closed) d();
    else dispose = d;
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

  // Two endpoints on one HTTP server: the full `/ws` bridge and the read-only
  // `/mirror-ws` viewer. [LAW:decomposition] the mirror's viewers never touch
  // the per-`/ws`-connection clients, so the mirror can't become an input
  // back-door into a session.
  //
  // [LAW:single-enforcer] One `upgrade` router decides which endpoint a socket
  //   belongs to, by path. Attaching two `WebSocketServer({server})` to the
  //   same HTTP server does NOT work — each handles every `upgrade` and the
  //   non-matching one aborts the handshake with 400 — so both are `noServer`
  //   and this router calls the right `handleUpgrade`.
  const wss = new WebSocketServer({ noServer: true });
  wss.on("connection", (ws) => {
    console.log("[bridge] client connected");
    try {
      handleConnection(ws);
    } catch (err) {
      console.error("[bridge] connection failed:", err);
      ws.close();
    }
  });

  const mirrorRegistry = new MirrorRegistry();
  const mirrorWss = new WebSocketServer({ noServer: true });
  mirrorWss.on("connection", (ws, request) => {
    console.log("[bridge] mirror viewer connected");
    try {
      handleMirrorConnection(ws, mirrorRegistry, request.url ?? "");
    } catch (err) {
      console.error("[bridge] mirror connection failed:", err);
      ws.close();
    }
  });

  // The collaborative endpoint reuses the SAME mirror registry for output
  // (one tap per pane, shared with read-only viewers — a read-only mirror and
  // a writable collaborator of one pane share its byte stream and viewer count)
  // and adds the write side via a dedicated `CollabInput`. [LAW:one-source-of-
  // truth] one pane, one tap, regardless of how each browser connects.
  const collabInput = new CollabInput();
  const collabWss = new WebSocketServer({ noServer: true });
  collabWss.on("connection", (ws, request) => {
    console.log("[bridge] collaborator connected");
    try {
      handleCollabConnection(ws, mirrorRegistry, collabInput, request.url ?? "");
    } catch (err) {
      console.error("[bridge] collab connection failed:", err);
      ws.close();
    }
  });

  httpServer.on("upgrade", (request, socket, head) => {
    const path = (request.url ?? "").split("?")[0];
    if (path === "/ws") {
      wss.handleUpgrade(request, socket, head, (ws) =>
        wss.emit("connection", ws, request),
      );
    } else if (path === MIRROR_WS_PATH) {
      mirrorWss.handleUpgrade(request, socket, head, (ws) =>
        mirrorWss.emit("connection", ws, request),
      );
    } else if (path === COLLAB_WS_PATH) {
      collabWss.handleUpgrade(request, socket, head, (ws) =>
        collabWss.emit("connection", ws, request),
      );
    } else {
      socket.destroy();
    }
  });

  httpServer.listen(port, () => {
    console.log(`[bridge] listening on http://localhost:${port} (WS at /ws)`);
    console.log(`[bridge] read-only pane mirror at ${MIRROR_WS_PATH}?pane=%N`);
    console.log(`[bridge] collaborative pane at ${COLLAB_WS_PATH}?pane=%N`);
    console.log(
      `[bridge] open the Vite dev server (default http://localhost:${WEB_PORT})`,
    );
  });

  return {
    close(): void {
      for (const connection of [...connections]) {
        closeConnection(connection);
      }
      mirrorRegistry.close();
      collabInput.close();
      wss.close();
      mirrorWss.close();
      collabWss.close();
      httpServer.close();
    },
  };
}
