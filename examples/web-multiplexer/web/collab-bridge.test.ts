// examples/web-multiplexer/web/collab-bridge.test.ts
//
// The collaborative channel's input path, live: CollabBridge over the
// platform WebSocket, the demo server's own `handleCollabConnection`, and a
// real tmux pane running od on a raw tty — so the pane's dump is exactly the
// bytes its pty received. Gated behind TMUX_INTEGRATION=1.
//
// The file reads the package's built dist/ as the demo does: run
// `pnpm run build` first.

import { describe, it, beforeAll, afterAll } from "vitest";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import { killTmuxServer } from "../../../tests/helpers/reap-test-sockets.ts";
import {
  readUntil,
  tmux,
  uniqueSocket,
} from "../../../tests/helpers/integration.ts";
import { handleCollabConnection } from "../server/bridge.ts";
import { CollabInput } from "../server/collab-input.ts";
import { MirrorRegistry } from "../server/mirror-registry.ts";
import { CollabBridge } from "./collab-bridge.ts";

const integration = process.env.TMUX_INTEGRATION === "1";

describe.skipIf(!integration)("CollabBridge input → pane", () => {
  const socket = uniqueSocket("tmux-bridge-test-", "collab");
  const registry = new MirrorRegistry();
  const input = new CollabInput();
  let server: WebSocketServer;
  let wsBase: string;
  let paneId: number;

  beforeAll(async () => {
    tmux(socket, [
      "new-session",
      "-d",
      "-x",
      "80",
      "-y",
      "24",
      "stty raw -echo; od -An -tx1 -v",
    ]);
    // The server's control clients attach where the demo's do.
    process.env.TMUX_DEMO_SOCKET = socket;
    paneId = Number(
      tmux(socket, ["display-message", "-p", "#{pane_id}"]).trim().slice(1),
    );
    await readUntil(
      () =>
        tmux(socket, [
          "display-message",
          "-p",
          "#{pane_current_command}",
        ]).trim(),
      (cmd) => cmd === "od",
      "the pane never reached od",
    );
    server = new WebSocketServer({ port: 0 });
    server.on("connection", (ws, request) =>
      handleCollabConnection(ws, registry, input, request.url ?? ""),
    );
    await once(server, "listening");
    wsBase = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    input.close();
    registry.close();
    server.close();
    delete process.env.TMUX_DEMO_SOCKET;
    killTmuxServer(socket);
  });

  it("input bytes reach the pane's program byte-exact, a legacy mouse report included", async () => {
    const bridge = new CollabBridge(wsBase, paneId);
    // Sent before the socket opens: buffered, then flushed in order.
    const mouse = new Uint8Array([0x1b, 0x5b, 0x4d, 0x20, 0xa1, 0x21]);
    const text = new TextEncoder().encode("éABCDEFGH");
    bridge.sendKeys(mouse);
    bridge.sendKeys(text);
    bridge.connect();
    try {
      const expected = [...mouse, ...text]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(" ");
      await readUntil(
        () =>
          tmux(socket, ["capture-pane", "-p", "-t", `%${paneId}`]).replace(
            /\s+/g,
            " ",
          ),
        (d) => d.includes(expected),
        `the pane never received ${expected}`,
      );
    } finally {
      bridge.disconnect();
    }
  });
});
