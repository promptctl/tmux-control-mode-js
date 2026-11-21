// tests/unit/example-bridge-server.test.ts
//
// The demo's bridge server, run whole on a free port over mock tmux clients:
// only the demo page's origin reaches tmux or the LLM, the server listens on
// loopback only, a page is handed its tmux client only once tmux has attached
// it, and no bad frame or broken socket takes the server down.

import { afterEach, describe, expect, it } from "vitest";
import { connect } from "node:net";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { MockTmuxServer } from "../../src/mock/index.js";
// The demo resolves the package to dist/, so its clients come from there too.
import { TmuxClient } from "@promptctl/tmux-control-mode-js";
import {
  WebSocketTmuxClient,
  type WebSocketTmuxClientOptions,
} from "@promptctl/tmux-control-mode-js/websocket/client";
import type { ConnectionState } from "@promptctl/tmux-control-mode-js/browser";
import {
  startBridge,
  type BridgeHandle,
} from "../../examples/web-multiplexer/server/bridge.js";
import {
  COPILOT_MAX_BODY_BYTES,
  suggest,
} from "../../examples/web-multiplexer/server/copilot.js";
import { chatCompletion } from "../../examples/web-multiplexer/server/llm-client.js";
import {
  FIREHOSE_WS_PATH,
  TMUX_WS_PATH,
  WEB_ORIGINS,
} from "../../examples/web-multiplexer/shared/config.js";
import { MIRROR_WS_PATH } from "../../examples/web-multiplexer/shared/mirror-frame.js";
import { COLLAB_WS_PATH } from "../../examples/web-multiplexer/shared/collab-frame.js";
import { COPILOT_PATH } from "../../examples/web-multiplexer/shared/copilot-frame.js";

const PAGE = WEB_ORIGINS[0];

type PageSocketFactory = NonNullable<
  WebSocketTmuxClientOptions["createWebSocket"]
>;
/** A browser's WebSocket on the demo page: it sends the page's Origin. Node's
 *  `ws` speaks the browser API, but its binaryType also admits Node-only
 *  values the browser type does not list. */
const pageSocket: PageSocketFactory = (url, protocols) =>
  new WebSocket(url, protocols, {
    headers: { Origin: PAGE },
  }) as unknown as ReturnType<PageSocketFactory>;
const EVIL = "http://evil.com:44173";

interface Rig {
  readonly bridge: BridgeHandle;
  readonly port: number;
  /** How many tmux clients the server has spawned. */
  spawned(): number;
  /** How many times the server has called the LLM. */
  llmCalls(): number;
}

let open: Rig[] = [];
afterEach(() => {
  open.forEach((rig) => rig.bridge.close());
  open = [];
});

/** Each spawned client attaches (`attached`) or exits before its startup reply. */
async function startRig(attached = true): Promise<Rig> {
  let spawned = 0;
  let llmCalls = 0;
  const bridge = startBridge({
    port: 0,
    spawnClient: () => {
      spawned += 1;
      const server = new MockTmuxServer();
      const client = new TmuxClient(server);
      if (attached) server.start();
      else server.close();
      return client;
    },
    startFirehose: () => ({
      start: () => Promise.resolve(),
      stop: () => undefined,
    }),
    complete: () => {
      llmCalls += 1;
      return Promise.resolve("ok");
    },
  });
  const { port } = await bridge.listening;
  const rig = {
    bridge,
    port,
    spawned: () => spawned,
    llmCalls: () => llmCalls,
  };
  open.push(rig);
  return rig;
}

/** The status an upgrade request gets: 101 when it opens. */
function upgradeStatus(
  port: number,
  path: string,
  origin: string,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, {
      headers: { Origin: origin },
    });
    ws.on("unexpected-response", (_req, res) => {
      resolve(res.statusCode ?? 0);
      ws.terminate();
    });
    ws.on("open", () => {
      resolve(101);
      ws.terminate();
    });
    ws.on("error", reject);
  });
}

/** A page's library client on `/ws`, settled at its first ready or closed. */
async function pageState(port: number): Promise<{
  client: WebSocketTmuxClient;
  state: ConnectionState;
}> {
  const client = new WebSocketTmuxClient({
    url: `ws://127.0.0.1:${port}${TMUX_WS_PATH}`,
    createWebSocket: pageSocket,
  });
  const state = await new Promise<ConnectionState>((resolve) => {
    client.on("connection-state", ({ state: next }) => {
      if (next.status === "ready" || next.status === "closed") resolve(next);
    });
  });
  return { client, state };
}

function post(
  port: number,
  origin: string,
  body: Buffer,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: COPILOT_PATH,
        method: "POST",
        headers: { Origin: origin, "content-type": "application/json" },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

const MESSAGES = JSON.stringify({
  messages: [{ role: "user", content: "hi" }],
});

describe("the demo bridge server", () => {
  it("listens on loopback only", async () => {
    const rig = await startRig();
    expect((await rig.bridge.listening).address).toBe("127.0.0.1");
  });

  it.each([TMUX_WS_PATH, FIREHOSE_WS_PATH, MIRROR_WS_PATH, COLLAB_WS_PATH])(
    "refuses another site's page on %s with 403, before any tmux client exists",
    async (path) => {
      const rig = await startRig();
      expect(await upgradeStatus(rig.port, path, EVIL)).toBe(403);
      expect(rig.spawned()).toBe(0);
    },
  );

  it("hands the demo page a tmux client it can run commands on", async () => {
    const rig = await startRig();
    const { client, state } = await pageState(rig.port);
    try {
      expect(state.status).toBe("ready");
      await expect(client.execute("list-sessions")).resolves.toMatchObject({
        success: true,
      });
    } finally {
      await client.close();
    }
  });

  it("refuses the page, and sends no welcome, when tmux exits before attaching", async () => {
    const rig = await startRig(false);
    const { client, state } = await pageState(rig.port);
    await client.close();
    expect(state).toMatchObject({ status: "closed", reason: "refused" });
    expect(rig.spawned()).toBe(1);
  });

  it("closes a socket that sends a frame outside the protocol, and still serves the next page", async () => {
    const rig = await startRig();
    const code = await new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${rig.port}${TMUX_WS_PATH}`, {
        headers: { Origin: PAGE },
      });
      ws.on("open", () => {
        ws.send("null");
        ws.send("not json at all");
      });
      ws.on("close", (closeCode) => resolve(closeCode));
      ws.on("error", reject);
    });
    expect(code).not.toBe(1000);

    const { client, state } = await pageState(rig.port);
    await client.close();
    expect(state.status).toBe("ready");
  });

  it("survives a client that writes garbage onto an upgraded socket", async () => {
    const rig = await startRig();
    await new Promise<void>((resolve, reject) => {
      const raw = connect(rig.port, "127.0.0.1", () => {
        raw.write(
          [
            `GET ${TMUX_WS_PATH} HTTP/1.1`,
            `Host: 127.0.0.1:${rig.port}`,
            `Origin: ${PAGE}`,
            "Upgrade: websocket",
            "Connection: Upgrade",
            "Sec-WebSocket-Version: 13",
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
            "",
            "",
          ].join("\r\n"),
        );
      });
      raw.once("data", () => {
        // An unmasked frame with reserved bits set: invalid from a client.
        raw.write(Buffer.from([0xff, 0xff, 0xff, 0xff]));
      });
      raw.on("close", () => resolve());
      raw.on("error", reject);
    });

    const { client, state } = await pageState(rig.port);
    await client.close();
    expect(state.status).toBe("ready");
  });

  it("refuses the copilot to another site's page, and calls no LLM", async () => {
    const rig = await startRig();
    const reply = await post(rig.port, EVIL, Buffer.from(MESSAGES));
    expect(reply.status).toBe(403);
    expect(rig.llmCalls()).toBe(0);
  });

  it("answers a copilot body one byte over the cap with 413, and calls no LLM", async () => {
    const rig = await startRig();
    const reply = await post(
      rig.port,
      PAGE,
      Buffer.alloc(COPILOT_MAX_BODY_BYTES + 1, 0x20),
    );
    expect(reply.status).toBe(413);
    expect(rig.llmCalls()).toBe(0);
  });

  it("relays the demo page's copilot request to the LLM", async () => {
    const rig = await startRig();
    const reply = await post(rig.port, PAGE, Buffer.from(MESSAGES));
    expect(reply).toEqual({
      status: 200,
      body: JSON.stringify({ ok: true, content: "ok" }),
    });
    expect(rig.llmCalls()).toBe(1);
  });
});

describe("the copilot's LLM call", () => {
  let stalled: Server | undefined;
  afterEach(() => {
    stalled?.closeAllConnections();
    stalled?.close();
    stalled = undefined;
  });

  it("ends at its deadline as a represented failure, not a hang", async () => {
    // An endpoint that accepts the request and never answers.
    stalled = createServer(() => undefined);
    await new Promise<void>((resolve) =>
      stalled!.listen(0, "127.0.0.1", resolve),
    );
    const { port } = stalled.address() as AddressInfo;
    const deadline = new AbortController();

    const reply = suggest(JSON.parse(MESSAGES), (messages) =>
      chatCompletion(
        messages,
        { baseUrl: `http://127.0.0.1:${port}/v1`, model: "m", apiKey: "k" },
        deadline.signal,
      ),
    );
    deadline.abort(new Error("the LLM took too long"));

    await expect(reply).resolves.toEqual({
      status: 200,
      response: { ok: false, error: "the LLM took too long" },
    });
  });
});
