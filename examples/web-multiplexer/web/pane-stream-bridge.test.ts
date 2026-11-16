// examples/web-multiplexer/web/pane-stream-bridge.test.ts
//
// The library's pane- and window-move cases, run through the demo's whole
// browser path: BridgePaneStreamClient over the real WebSocketBridge, whose
// socket is joined in-process to the demo server's own forwarding
// (`forwardClientToSocket`) and command reply (`asCommandResponse`) over a
// real tmux. The cases are the ones tests/integration/pane-scope.test.ts runs
// on TmuxClient, so the demo follows every move the library does. The command
// seam case needs no tmux.
//
// The move cases are gated behind TMUX_INTEGRATION=1. The file reads the package's built dist/ as the
// demo does: run `pnpm run build` first.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { TmuxClient, spawnTmux } from "@promptctl/tmux-control-mode-js";
import {
  TmuxCommandError,
  windowScope,
} from "@promptctl/tmux-control-mode-js/browser";
import { describeTopologyMoves } from "../../../tests/helpers/topology-moves.ts";
import { forwardClientToSocket } from "../server/bridge.ts";
import { asCommandResponse } from "../shared/command-response.ts";
import type { ClientToServer, ServerToClient } from "../shared/protocol.ts";
import { WebSocketBridge } from "./ws-client.ts";
import { BridgePaneStreamClient } from "./pane-stream-bridge.ts";

const RUN_INTEGRATION = process.env.TMUX_INTEGRATION === "1";

type Listener = (event?: { data?: unknown }) => void;

/** The browser end of an in-process socket: the bridge server's frames are
 *  delivered to it by `deliver`, and what the page sends goes to `onSend`. */
class InProcessSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static last: InProcessSocket | undefined;

  readyState = InProcessSocket.CONNECTING;
  binaryType: "blob" | "arraybuffer" = "blob";
  onSend: (data: string) => void = () => undefined;
  private readonly listeners: Record<string, Listener[]> = {
    open: [],
    close: [],
    error: [],
    message: [],
  };

  constructor() {
    InProcessSocket.last = this;
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners[type].push(listener);
  }

  send(data: string): void {
    this.onSend(data);
  }

  close(): void {
    this.readyState = InProcessSocket.CLOSED;
  }

  open(): void {
    this.readyState = InProcessSocket.OPEN;
    this.listeners.open.forEach((l) => l());
  }

  // A browser hands binary frames over as an ArrayBuffer (binaryType
  // "arraybuffer"), text frames as a string.
  deliver(data: string | ArrayBufferLike | ArrayBufferView): void {
    const frame =
      typeof data === "string" || data instanceof ArrayBuffer
        ? data
        : ArrayBuffer.isView(data)
          ? new Uint8Array(
              data.buffer,
              data.byteOffset,
              data.byteLength,
            ).slice().buffer
          : new Uint8Array(data).slice().buffer;
    this.listeners.message.forEach((l) => l({ data: frame }));
  }
}

async function openBridged(
  socketName: string,
  session: string,
): Promise<{ conn: BridgePaneStreamClient; close(): void }> {
  const bridge = new WebSocketBridge();
  const conn = new BridgePaneStreamClient(bridge);
  const ready = new Promise<void>((resolve) => {
    const off = bridge.onState((s) => {
      if (s === "ready") {
        off();
        resolve();
      }
    });
  });
  bridge.connect("ws://in-process");
  const socket = InProcessSocket.last!;

  // The server side, as server/bridge.ts handles one connection.
  const client = new TmuxClient(
    spawnTmux(["attach-session", "-t", session], { socketPath: socketName }),
  );
  const send = (frame: ServerToClient): void =>
    socket.deliver(JSON.stringify(frame));
  forwardClientToSocket(client, {
    readyState: 1,
    OPEN: 1,
    send: (data) => socket.deliver(data),
  });
  const onSessionChanged = (): void => {
    client.off("session-changed", onSessionChanged);
    send({ kind: "ready" });
  };
  client.on("session-changed", onSessionChanged);
  socket.onSend = (raw) => {
    const msg = JSON.parse(raw) as ClientToServer;
    if (msg.kind !== "execute") {
      throw new Error(`unexpected ${msg.kind} frame from the bridge`);
    }
    void client
      .execute(msg.command)
      .catch(asCommandResponse)
      .then(
        (response) => send({ kind: "response", id: msg.id, response }),
        (err: unknown) =>
          send({ kind: "error", id: msg.id, message: String(err) }),
      );
  };
  socket.open();
  await ready;

  return {
    conn,
    close: () => {
      bridge.disconnect();
      client.close();
    },
  };
}

beforeAll(() => {
  vi.stubGlobal("WebSocket", InProcessSocket);
});
afterAll(() => {
  vi.unstubAllGlobals();
});

describe("BridgePaneStreamClient command seam", () => {
  it("relays a tmux %error the bridge resolves as a TmuxCommandError, so a gone window's refresh reports nothing", async () => {
    const bridge = new WebSocketBridge();
    const conn = new BridgePaneStreamClient(bridge);
    const reported: Error[] = [];
    conn.on("topology-error", (ev) => reported.push(ev.error));
    bridge.connect("ws://in-process");
    const socket = InProcessSocket.last!;
    // The demo server answers a failed command with a `success: false`
    // response frame (asCommandResponse); @9 is a window that is gone.
    socket.onSend = (raw) => {
      const msg = JSON.parse(raw) as ClientToServer;
      if (msg.kind !== "execute") throw new Error(`unexpected ${msg.kind}`);
      const gone = msg.command.includes("-t @9");
      const frame: ServerToClient = {
        kind: "response",
        id: msg.id,
        response: {
          commandNumber: 0,
          timestamp: 0,
          output: gone ? ["can't find window: @9"] : [],
          success: !gone,
        },
      };
      socket.deliver(JSON.stringify(frame));
    };
    socket.open();
    socket.deliver(JSON.stringify({ kind: "ready" }));

    await expect(conn.execute("list-panes -t @9")).rejects.toBeInstanceOf(
      TmuxCommandError,
    );
    conn.attachBytesSink(
      { write: () => undefined, end: () => undefined },
      { scope: windowScope(9) },
    );
    socket.deliver(
      JSON.stringify({
        kind: "event",
        event: { type: "window-close", windowId: 9 },
      }),
    );
    // Both queries' replies are delivered synchronously; their settles run
    // on the promise jobs after them.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reported).toEqual([]);
    bridge.disconnect();
  });

  it("retires the router's connection before consumers hear it closed, so a window sink attached then asks nothing of it", async () => {
    const bridge = new WebSocketBridge();
    const conn = new BridgePaneStreamClient(bridge);
    const bridgeErrors: string[] = [];
    bridge.onError((message) => bridgeErrors.push(message));
    bridge.connect("ws://in-process");
    const socket = InProcessSocket.last!;
    socket.open();
    socket.deliver(JSON.stringify({ kind: "ready" }));
    conn.on("connection-state", ({ state }) => {
      if (state.status === "closed") {
        conn.attachBytesSink(
          { write: () => undefined, end: () => undefined },
          { scope: windowScope(1) },
        );
      }
    });

    bridge.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // A bootstrap on the dropped connection would be refused with
    // "cannot execute: bridge is not connected".
    expect(bridgeErrors).toEqual([]);
  });
});

describe.skipIf(!RUN_INTEGRATION)("web-multiplexer pane-stream bridge", () => {
  describeTopologyMoves("BridgePaneStreamClient", openBridged);
});
