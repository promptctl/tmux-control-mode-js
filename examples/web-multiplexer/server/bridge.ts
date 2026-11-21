// examples/web-multiplexer/server/bridge.ts
// Bridge server: exposes tmux to the demo page over WebSocket.
//
// Architecture:
//   page <-- library WebSocket connector (/ws) --> bridge <-- tmux -C --> tmux
//   page <-- pane-output frames (/firehose-ws) -- bridge <-- pipe-pane taps
//
// The browser never imports the tmux-control-mode-js runtime — only types.
// [LAW:one-source-of-truth] /ws is the library's own bridge and wire
// (`createWebSocketBridge`); the demo adds no protocol of its own on it.

import {
  createServer,
  STATUS_CODES,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import type { TmuxClient } from "@promptctl/tmux-control-mode-js";
import {
  BridgeError,
  createWebSocketBridge,
} from "@promptctl/tmux-control-mode-js/websocket";
import { PaneFirehose } from "./pane-firehose.js";
import { FirehoseEndpoint, type StartFirehose } from "./firehose-endpoint.js";
import {
  DedicatedControlClient,
  spawnDemoClient,
  whenReady,
  type SpawnControlClient,
} from "./control-client.js";
import {
  BRIDGE_HOST,
  BRIDGE_PORT,
  TMUX_WS_PATH,
  WEB_PORT,
} from "../shared/config.js";
import { admitHttp, admitUpgrade, type Route } from "./trust-gate.js";
import { MirrorRegistry, type MirrorViewer } from "./mirror-registry.js";
import { CollabInput } from "./collab-input.js";
import {
  parseMirrorPane,
  MIRROR_WS_PATH,
  type MirrorControlFrame,
} from "../shared/mirror-frame.js";
import { COLLAB_WS_PATH } from "../shared/collab-frame.js";
import { COPILOT_PATH } from "../shared/copilot-frame.js";
import {
  COPILOT_MAX_BODY_BYTES,
  readCappedBody,
  suggest,
  type CompleteChat,
} from "./copilot.js";
import { chatCompletion, llmConfigFromEnv } from "./llm-client.js";

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
  /** Where the server listens, once it does. */
  readonly listening: Promise<AddressInfo>;
  close(): void;
}

/** What `startBridge` runs on. Every field defaults to the live demo's. */
export interface BridgeOptions {
  /** 0 lets the OS pick a free port (tests). */
  readonly port?: number;
  /** Spawns the `tmux -C` client each `/ws` page and the firehose run on. */
  readonly spawnClient?: SpawnControlClient;
  readonly startFirehose?: StartFirehose;
  /** The co-pilot's LLM call; by default the env-configured endpoint. */
  readonly complete?: CompleteChat;
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
 * Handle a `/copilot/suggest` POST: read at most COPILOT_MAX_BODY_BYTES, parse
 * the JSON, and answer through `suggest`. [LAW:no-silent-failure] an oversized
 * body is a 413, a malformed one a 400, and an LLM failure a `{ ok: false }`
 * value the browser renders. Nothing is swallowed.
 */
async function handleCopilotRequest(
  req: IncomingMessage,
  res: ServerResponse,
  complete: CompleteChat,
): Promise<void> {
  const body = await readCappedBody(req, COPILOT_MAX_BODY_BYTES);
  if (body.kind === "too-large") {
    writeJson(res, 413, { ok: false, error: "copilot request too large" });
    return;
  }
  if (body.kind === "stream-error") {
    writeJson(res, 400, { ok: false, error: body.message });
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.text);
  } catch {
    writeJson(res, 400, { ok: false, error: "invalid JSON body" });
    return;
  }
  const reply = await suggest(parsed, complete);
  writeJson(res, reply.status, reply.response);
}

/**
 * Construct the HTTP + WebSocket bridge and start listening. Returns a handle
 * whose `close()` centralizes teardown (Ctrl+C, watcher restart, test cleanup)
 * through one path. [LAW:single-enforcer]
 *
 * The process entry (`server/main.ts`) owns the signal handlers; importing
 * this module performs no I/O; `options` lets a test run the whole server
 * on a free port over its own tmux. [LAW:effects-at-boundaries]
 */
export function startBridge(options: BridgeOptions = {}): BridgeHandle {
  const port = options.port ?? BRIDGE_PORT;
  const spawnClient = options.spawnClient ?? spawnDemoClient;
  const startFirehose: StartFirehose =
    options.startFirehose ??
    ((execute, sink) => new PaneFirehose(execute, sink));
  const complete: CompleteChat =
    options.complete ?? ((messages) => chatCompletion(messages, copilotConfig));

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
      void handleCopilotRequest(req, res, complete);
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(
      "tmux-control-mode-js demo bridge — connect to /ws via WebSocket\n",
    );
  });

  const mirrorRegistry = new MirrorRegistry(spawnClient);
  // The collaborative endpoint reuses the SAME mirror registry for output
  // (one tap per pane, shared with read-only viewers — a read-only mirror and
  // a writable collaborator of one pane share its byte stream and viewer count)
  // and adds the write side via a dedicated `CollabInput`. [LAW:one-source-of-
  // truth] one pane, one tap, regardless of how each browser connects.
  const collabInput = new CollabInput(spawnClient);

  // [LAW:one-source-of-truth] One handler per route; `admitUpgrade` owns the
  // path-to-route table, so this record cannot name a route the gate lacks.
  // Each page gets its own tmux client, so one page's session never reaches
  // another's. [LAW:no-ambient-temporal-coupling] The library sends its
  // welcome once `createClient` returns, so the client is handed over only
  // once tmux has attached it (`whenReady`); a tmux that exits first refuses
  // the page instead.
  const tmuxBridge = createWebSocketBridge({
    createClient: async () => {
      const client = spawnClient();
      try {
        return await whenReady(client);
      } catch (err) {
        client.close();
        throw new BridgeError(
          "BRIDGE_REFUSED",
          `tmux did not attach: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
    disposeClient: (client: TmuxClient) => client.close(),
  });

  // The firehose's taps run on one long-lived client; when tmux takes it
  // away, every firehose socket closes and its page reopens one.
  const firehoseControl = new DedicatedControlClient(
    "[firehose]",
    () => firehoseEndpoint.closeAll("tmux connection lost"),
    spawnClient,
  );
  const firehoseEndpoint = new FirehoseEndpoint(
    (command) => firehoseControl.ready().then((c) => c.execute(command)),
    startFirehose,
  );

  const routes: Record<
    Route,
    (ws: WebSocket, request: IncomingMessage) => void
  > = {
    tmux: (ws, request) => {
      tmuxBridge
        .handleConnection(ws, {
          url: request.url,
          headers: request.headers,
          remoteAddress: request.socket.remoteAddress,
        })
        .catch((err: unknown) =>
          console.error("[bridge] tmux connection failed:", err),
        );
    },
    firehose: (ws) => firehoseEndpoint.accept(ws),
    mirror: (ws, request) =>
      handleMirrorConnection(ws, mirrorRegistry, request.url ?? ""),
    collab: (ws, request) =>
      handleCollabConnection(
        ws,
        mirrorRegistry,
        collabInput,
        request.url ?? "",
      ),
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
        routes[admission.route](ws, request);
      } catch (err) {
        console.error(`[bridge] ${admission.route} connection failed:`, err);
        ws.close();
      }
    });
  });

  const listening = new Promise<AddressInfo>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.once("listening", () =>
      resolve(httpServer.address() as AddressInfo),
    );
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
    listening,
    close(): void {
      void tmuxBridge.shutdown();
      firehoseEndpoint.closeAll("bridge shutting down");
      firehoseControl.close();
      mirrorRegistry.close();
      collabInput.close();
      wss.close();
      httpServer.close();
    },
  };
}
