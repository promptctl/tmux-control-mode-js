// examples/web-multiplexer/web/collab-bridge.test.ts
//
// The collaborative channel's input path, live: CollabBridge over a
// WebSocket, the demo server's own `handleCollabConnection`, and a real tmux
// pane recording the raw bytes its pty receives. Gated behind
// TMUX_INTEGRATION=1.
//
// The file reads the package's built dist/ as the demo does: run
// `pnpm run build` first.

import { describe, it, beforeAll, afterAll, vi } from "vitest";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { killTmuxServer } from "../../../tests/helpers/reap-test-sockets.ts";
import {
  hexBytes,
  rawInputCapture,
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
  const socket = uniqueSocket("collab");
  const registry = new MirrorRegistry();
  const input = new CollabInput();
  const capture = rawInputCapture();
  let server: WebSocketServer;
  let wsBase: string;
  let paneId: number;

  beforeAll(async () => {
    // The browser's WebSocket, which Node has globally only from 22: ws's
    // client speaks the same API CollabBridge uses.
    vi.stubGlobal("WebSocket", WebSocket);
    tmux(socket, [
      "new-session",
      "-d",
      "-x",
      "80",
      "-y",
      "24",
      capture.command,
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
      (cmd) => cmd === "cat",
      "the pane never reached cat",
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
    vi.unstubAllGlobals();
  });

  it("input bytes reach the pane's program byte-exact, a legacy mouse report included", async () => {
    const bridge = new CollabBridge(wsBase, paneId);
    // Sent before the socket opens: buffered, then flushed in order.
    const mouse = new Uint8Array([0x1b, 0x5b, 0x4d, 0x20, 0xa1, 0x21]);
    const text = new TextEncoder().encode("é");
    bridge.sendKeyBytes(mouse);
    bridge.sendKeyBytes(text);
    bridge.connect();
    try {
      const expected = hexBytes([...mouse, ...text]);
      await readUntil(
        capture.hex,
        (got) => got === expected,
        `the pane never received exactly ${expected}`,
      );
    } finally {
      bridge.disconnect();
    }
  });
});
