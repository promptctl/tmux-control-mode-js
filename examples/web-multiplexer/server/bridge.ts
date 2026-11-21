// examples/web-multiplexer/server/bridge.ts
// Bridge server: wraps a TmuxClient and exposes it to browsers over WebSocket.
//
// Architecture:
//   browser <-- WebSocket (JSON) --> bridge <-- spawn + control protocol --> tmux
//
// The browser never imports the tmux-control-mode-js runtime — only types.
// All wire-protocol parsing and encoding happens here on the Node side.

import {
  createServer,
  STATUS_CODES,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { TmuxClient } from "@promptctl/tmux-control-mode-js";
import { spawnTmux } from "@promptctl/tmux-control-mode-js";
import { isTmuxMessage } from "@promptctl/tmux-control-mode-js";
import { serverScope } from "@promptctl/tmux-control-mode-js";
import { sendKeys } from "@promptctl/tmux-control-mode-js";
import { isConnectionGone } from "@promptctl/tmux-control-mode-js";
import type { EmitterMessage } from "@promptctl/tmux-control-mode-js";
import { attachWebSocketSink } from "@promptctl/tmux-control-mode-js/websocket";
import { asCommandResponse } from "../shared/command-response.js";
import type { ClientToServer, ServerToClient } from "../shared/protocol.js";
import { BRIDGE_HOST, BRIDGE_PORT, WEB_PORT } from "../shared/config.js";
import {
  admitHttp,
  admitUpgrade,
  TMUX_WS_PATH,
  type Route,
} from "./trust-gate.js";
import { PaneFirehose } from "./pane-firehose.js";
import { encodeFirehoseFrame } from "../shared/firehose-frame.js";
import { MirrorRegistry, type MirrorViewer } from "./mirror-registry.js";
import { CollabInput } from "./collab-input.js";
import {
  parseMirrorPane,
  MIRROR_WS_PATH,
  type MirrorControlFrame,
} from "../shared/mirror-frame.js";
import { COLLAB_WS_PATH } from "../shared/collab-frame.js";
import {
  COPILOT_PATH,
  parseCopilotRequest,
  type CopilotSuggestResponse,
} from "../shared/copilot-frame.js";
import { chatCompletion, llmConfigFromEnv } from "./llm-client.js";
import { demoAttachArgs } from "./tmux-target.js";

// The bridge's request handler unwraps a failed command's rejection into the
// wire `response` frame through the shared `asCommandResponse` enforcer, so the
// frame always honors its declared `CommandResponse` type and a non-command
// rejection still reaches the `error`-frame path. [LAW:single-enforcer]

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

/**
 * Send `ready` once tmux has attached the client's session — the handshake the
 * browser waits for before it trusts the connection.
 */
export function announceReadyOnAttach(
  client: TmuxClient,
  send: (frame: ServerToClient) => void,
): void {
  const onSessionChanged = (): void => {
    client.off("session-changed", onSessionChanged);
    send({ kind: "ready" });
  };
  client.on("session-changed", onSessionChanged);
}

/**
 * The frame that answers one browser command. A tmux %error travels as a
 * `success: false` response, because an Error does not survive JSON; the
 * browser's bridge turns it back into a rejection. Any other failure is an
 * error frame carrying the command's id.
 *
 * [LAW:single-enforcer] The live server and its tests share this reply, as
 *   they share `forwardClientToSocket`.
 */
export function replyToCommand(
  client: TmuxClient,
  msg: Extract<ClientToServer, { kind: "execute" | "sendKeys" }>,
): Promise<ServerToClient> {
  // [LAW:decomposition] sendKeys is a free command function over the
  //   TmuxConnection surface, not a TmuxClient method — one shared
  //   implementation for every connector.
  const reply =
    msg.kind === "execute"
      ? client.execute(msg.command)
      : sendKeys(client, msg.target, msg.keys);
  return reply.catch(asCommandResponse).then(
    (response): ServerToClient => ({ kind: "response", id: msg.id, response }),
    // [LAW:single-enforcer] The library's isConnectionGone decides what a
    //   lost connection is, so the page retires it as the library would.
    (err: unknown): ServerToClient => ({
      kind: "error",
      id: msg.id,
      code: isConnectionGone(err) ? "BRIDGE_CLOSED" : "BRIDGE_INTERNAL",
      message: err instanceof Error ? err.message : String(err),
    }),
  );
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

  announceReadyOnAttach(client, send);

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
      if (msg.kind === "execute" || msg.kind === "sendKeys") {
        send(await replyToCommand(client, msg));
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
        code: "BRIDGE_INTERNAL",
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
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) {
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
 * binary frame's bytes are forwarded to the pane via `sendKeyBytes`. Many
 * browsers can hold this socket on the same pane at once; tmux serialises their
 * input into one authoritative pane and the result fans back through the shared
 * tap — so "two browsers, one pane" needs no CRDT. [LAW:no-silent-failure] a
 * text frame closes the socket loudly (1003) rather than being ignored.
 */
export function handleCollabConnection(
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

  // The collaborative channel's ONE inbound capability: input bytes → pane. A
  // text frame is misuse, not data. [LAW:no-silent-failure]
  ws.on("message", (raw: Buffer, isBinary: boolean) => {
    if (!isBinary) {
      ws.close(1003, "collab expects binary input frames");
      return;
    }
    void input.sendKeyBytes(paneId, raw);
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

// ---------------------------------------------------------------------------
// AI co-pilot — the one outbound LLM effect (HTTP POST /copilot/suggest)
// ---------------------------------------------------------------------------

// [LAW:one-source-of-truth] The LLM endpoint is resolved once from the env. An
// env read is not socket IO, so it is safe at import (the comment on startBridge
// is about not binding ports / spawning on import).
const copilotConfig = llmConfigFromEnv();

/** Write a JSON body with the given status. */
function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
}

/**
 * Handle a `/copilot/suggest` POST: read the body, validate it at the trust
 * boundary, call the LLM, and return the raw completion (or a represented
 * error). [LAW:no-silent-failure] an LLM failure is a `{ ok: false }` value the
 * browser renders; a malformed request is a 400. Nothing is swallowed.
 */
function handleCopilotRequest(req: IncomingMessage, res: ServerResponse): void {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("error", () =>
    writeJson(res, 400, { ok: false, error: "request stream error" }),
  );
  req.on("end", () => {
    void respondToCopilot(Buffer.concat(chunks).toString("utf8"), res);
  });
}

async function respondToCopilot(
  rawBody: string,
  res: ServerResponse,
): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    writeJson(res, 400, { ok: false, error: "invalid JSON body" });
    return;
  }
  const request = parseCopilotRequest(parsed);
  if (request === null) {
    writeJson(res, 400, { ok: false, error: "malformed copilot request" });
    return;
  }
  try {
    const content = await chatCompletion(request.messages, copilotConfig);
    writeJson(res, 200, { ok: true, content } satisfies CopilotSuggestResponse);
  } catch (err) {
    writeJson(res, 200, {
      ok: false,
      error: err instanceof Error ? err.message : "LLM call failed",
    } satisfies CopilotSuggestResponse);
  }
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
  const httpServer = createServer((req, res) => {
    // [LAW:single-enforcer] The same origin rule as every upgrade: a cross-site
    // POST would otherwise spend the user's LLM credentials.
    const admission = admitHttp(req);
    if (admission.kind === "refused") {
      console.warn(`[bridge] refused HTTP: ${admission.reason}`);
      res.writeHead(admission.status, { "content-type": "text/plain" });
      res.end(`${admission.reason}\n`);
      return;
    }
    // The AI co-pilot's LLM call is the one non-WebSocket route: a request /
    // response RPC, so it is plain HTTP, not a stream. [LAW:decomposition]
    if (
      req.method === "POST" &&
      (req.url ?? "").split("?")[0] === COPILOT_PATH
    ) {
      handleCopilotRequest(req, res);
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(
      "tmux-control-mode-js demo bridge — connect to /ws via WebSocket\n",
    );
  });

  const mirrorRegistry = new MirrorRegistry();
  // The collaborative endpoint reuses the SAME mirror registry for output
  // (one tap per pane, shared with read-only viewers — a read-only mirror and
  // a writable collaborator of one pane share its byte stream and viewer count)
  // and adds the write side via a dedicated `CollabInput`. [LAW:one-source-of-
  // truth] one pane, one tap, regardless of how each browser connects.
  const collabInput = new CollabInput();

  // [LAW:one-source-of-truth] One handler per route; `admitUpgrade` owns the
  // path-to-route table, so this record cannot name a route the gate lacks.
  const routes: Record<Route, (ws: WebSocket, url: string) => void> = {
    tmux: (ws) => handleConnection(ws),
    mirror: (ws, url) => handleMirrorConnection(ws, mirrorRegistry, url),
    collab: (ws, url) =>
      handleCollabConnection(ws, mirrorRegistry, collabInput, url),
  };

  // [LAW:single-enforcer] One `upgrade` router: every socket passes the trust
  //   gate before any upgrade, then one `noServer` WebSocketServer upgrades it.
  //   (Two `WebSocketServer({server})` on one HTTP server each handle every
  //   upgrade and abort the other's handshake, hence `noServer`.)
  const wss = new WebSocketServer({ noServer: true });
  httpServer.on("upgrade", (request, socket, head) => {
    const admission = admitUpgrade(request);
    if (admission.kind === "refused") {
      console.warn(`[bridge] refused upgrade: ${admission.reason}`);
      socket.end(
        `HTTP/1.1 ${admission.status} ${STATUS_CODES[admission.status]}\r\nConnection: close\r\n\r\n`,
      );
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      // `ws` throws an unheard 'error' as an uncaught exception, so every
      // socket gets its listener here, once, before any route sees it.
      ws.on("error", (err) =>
        console.error(`[bridge] ${admission.route} socket error:`, err),
      );
      console.log(`[bridge] ${admission.route} connected`);
      try {
        routes[admission.route](ws, request.url ?? "");
      } catch (err) {
        console.error(`[bridge] ${admission.route} connection failed:`, err);
        ws.close();
      }
    });
  });

  httpServer.listen(port, BRIDGE_HOST, () => {
    console.log(
      `[bridge] listening on http://${BRIDGE_HOST}:${port} (WS at ${TMUX_WS_PATH})`,
    );
    console.log(`[bridge] read-only pane mirror at ${MIRROR_WS_PATH}?pane=%N`);
    console.log(`[bridge] collaborative pane at ${COLLAB_WS_PATH}?pane=%N`);
    console.log(
      `[bridge] AI co-pilot at POST ${COPILOT_PATH} → LLM ${copilotConfig.baseUrl} (${copilotConfig.model})`,
    );
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
      httpServer.close();
    },
  };
}
