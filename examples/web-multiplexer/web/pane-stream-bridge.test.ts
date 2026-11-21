// examples/web-multiplexer/web/pane-stream-bridge.test.ts
//
// BridgePaneStreamClient over the page's real WebSocket bridge, talking to the
// demo's own bridge server in-process: the page dials it as a browser would,
// from the demo's origin, and every frame reaches the page as its own task.
// The seam cases run the server over mock tmux clients. The move cases are
// the ones tests/integration/pane-scope.test.ts runs on TmuxClient, so the
// demo follows every move the library does; they drive real tmux and are
// gated behind TMUX_INTEGRATION=1.
//
// The file reads the package's built dist/ as the demo does: run
// `pnpm run build` first.

import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket as NodeWebSocket } from "ws";
import {
  TmuxClient,
  spawnTmux,
  type TmuxTransport,
} from "@promptctl/tmux-control-mode-js";
import {
  TmuxCommandError,
  serverScope,
  windowScope,
} from "@promptctl/tmux-control-mode-js/browser";
import { MockTmuxServer } from "../../../src/mock/index.ts";
import { readUntil, tmux } from "../../../tests/helpers/integration.ts";
import { describeTopologyMoves } from "../../../tests/helpers/topology-moves.ts";
import { startBridge, type BridgeHandle } from "../server/bridge.ts";
import type { SpawnControlClient } from "../server/control-client.ts";
import { WEB_ORIGINS } from "../shared/config.ts";
import type { TmuxBridge } from "./bridge.ts";
import { BridgePaneStreamClient } from "./pane-stream-bridge.ts";
import { webSocketBridge } from "./ws-bridge.ts";

/** A browser's WebSocket on the demo page: it sends the page's Origin. */
class PageWebSocket extends NodeWebSocket {
  constructor(url: string, protocols?: string | string[]) {
    super(url, protocols, { headers: { Origin: WEB_ORIGINS[0] } });
  }
}

let servers: BridgeHandle[] = [];
afterEach(() => {
  servers.forEach((s) => s.close());
  servers = [];
  vi.unstubAllGlobals();
});

/** The demo page, on a bridge server whose tmux clients `spawnClient` makes. */
async function page(spawnClient: SpawnControlClient): Promise<{
  bridge: TmuxBridge;
  conn: BridgePaneStreamClient;
}> {
  const server = startBridge({
    port: 0,
    spawnClient,
    startFirehose: () => ({
      start: () => Promise.resolve(),
      stop: () => undefined,
    }),
    complete: () => Promise.reject(new Error("the copilot is not used here")),
  });
  servers.push(server);
  const { port } = await server.listening;
  vi.stubGlobal("location", { protocol: "http:", host: `127.0.0.1:${port}` });
  vi.stubGlobal("WebSocket", PageWebSocket);
  const bridge = webSocketBridge();
  const conn = new BridgePaneStreamClient(bridge);
  bridge.connect();
  await readUntil(
    () => conn.connectionState.status,
    (status) => status === "ready",
    "the page's connection never became ready",
  );
  return { bridge, conn };
}

/** A tmux client over `server`, attached; `transport` may stand between. */
function mockClient(
  server: MockTmuxServer,
  transport: TmuxTransport = server,
): TmuxClient {
  const client = new TmuxClient(transport);
  server.start();
  return client;
}

const settle = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 20));

const noSink = { write: () => undefined, end: () => undefined };

describe("BridgePaneStreamClient command seam", () => {
  it("a tmux %error rejects as TmuxCommandError, so the router's refresh of a gone window reports nothing", async () => {
    // @9 is a window that is gone.
    const tmuxServer = new MockTmuxServer({
      respond: (command) =>
        command.includes("-t @9")
          ? { kind: "error", output: ["can't find window: @9"] }
          : undefined,
    });
    const { bridge, conn } = await page(() => mockClient(tmuxServer));
    try {
      const reported: Error[] = [];
      conn.on("topology-error", (ev) => reported.push(ev.error));

      await expect(conn.execute("list-panes -t @9")).rejects.toBeInstanceOf(
        TmuxCommandError,
      );
      conn.attachBytesSink(noSink, { scope: windowScope(9) });
      tmuxServer.emit({ type: "window-close", windowId: 9 });
      await settle();

      expect(reported).toEqual([]);
    } finally {
      bridge.disconnect();
    }
  });

  it("a command the server's lost tmux connection could not carry retires the router's connection before the socket closes, so it reports no topology error", async () => {
    // The server's tmux client ends with the router's first command in flight.
    let loseOnCommand = false;
    const tmuxServer = new MockTmuxServer();
    const dying: TmuxTransport = {
      send: (command) => {
        if (loseOnCommand) {
          tmuxServer.close();
          return { ok: true };
        }
        return tmuxServer.send(command);
      },
      onData: (cb) => tmuxServer.onData(cb),
      onClose: (cb) => tmuxServer.onClose(cb),
      close: () => tmuxServer.close(),
    };
    const { bridge, conn } = await page(() => mockClient(tmuxServer, dying));
    try {
      const reported: Error[] = [];
      conn.on("topology-error", (ev) => reported.push(ev.error));
      loseOnCommand = true;

      conn.attachBytesSink(noSink, { scope: windowScope(1) });
      await settle();

      expect(reported).toEqual([]);
    } finally {
      bridge.disconnect();
    }
  });

  it("delivers connection-state after the consumer code running when the bridge closed, never inside it", async () => {
    const tmuxServer = new MockTmuxServer();
    const { bridge, conn } = await page(() => mockClient(tmuxServer));
    try {
      const order: string[] = [];
      conn.on("connection-state", ({ state }) => order.push(state.status));
      conn.attachBytesSink(
        {
          write: () => {
            order.push("write");
            bridge.disconnect();
            order.push("write returned");
          },
          end: () => undefined,
        },
        { scope: serverScope },
      );

      tmuxServer.emitOutput(1, new Uint8Array([0x61]));
      await settle();

      expect(order).toEqual(["write", "write returned", "closed"]);
    } finally {
      bridge.disconnect();
    }
  });

  it("retires the router's connection before consumers hear it closed, so a window sink attached then asks nothing of it", async () => {
    const { bridge, conn } = await page(() => mockClient(new MockTmuxServer()));
    try {
      const bridgeErrors: string[] = [];
      bridge.onError((message) => bridgeErrors.push(message));
      conn.on("connection-state", ({ state }) => {
        if (state.status === "closed") {
          conn.attachBytesSink(noSink, { scope: windowScope(1) });
        }
      });

      bridge.disconnect();
      await settle();

      // A bootstrap on the dropped connection would be refused BRIDGE_CLOSED.
      expect(bridgeErrors).toEqual([]);
    } finally {
      bridge.disconnect();
    }
  });
});

describeTopologyMoves("BridgePaneStreamClient", async (socketName, session) => {
  tmux(socketName, ["new-session", "-d", "-s", session]);
  const { bridge, conn } = await page(
    () =>
      new TmuxClient(
        spawnTmux(["attach-session", "-t", session], {
          socketPath: socketName,
        }),
      ),
  );
  return { conn, close: () => bridge.disconnect() };
});
