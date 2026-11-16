// examples/web-multiplexer/web/pane-stream-bridge.test.ts
//
// BridgePaneStreamClient over the real WebSocketBridge, whose socket is joined
// in-process to the demo server's own code: `forwardClientToSocket`,
// `announceReadyOnAttach` and `replyToCommand`. Each frame reaches the page as
// its own task, as a browser delivers WebSocket messages. The move cases are
// the ones tests/integration/pane-scope.test.ts runs on TmuxClient, so the
// demo follows every move the library does; they are gated behind
// TMUX_INTEGRATION=1. The seam cases need no tmux.
//
// The file reads the package's built dist/ as the demo does: run
// `pnpm run build` first.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { TmuxClient, spawnTmux } from "@promptctl/tmux-control-mode-js";
import {
  TmuxCommandError,
  TransportClosedError,
  serverScope,
  windowScope,
} from "@promptctl/tmux-control-mode-js/browser";
import { encodePaneOutput } from "@promptctl/tmux-control-mode-js/websocket/protocol";
import { readUntil, tmux } from "../../../tests/helpers/integration.ts";
import { describeTopologyMoves } from "../../../tests/helpers/topology-moves.ts";
import {
  announceReadyOnAttach,
  forwardClientToSocket,
  replyToCommand,
} from "../server/bridge.ts";
import type { ClientToServer, ServerToClient } from "../shared/protocol.ts";
import { WebSocketBridge } from "./ws-client.ts";
import { BridgePaneStreamClient } from "./pane-stream-bridge.ts";

type Listener = (event?: { data?: unknown }) => void;

/** The page's end of an in-process socket. `deliver` hands it a server frame
 *  on a task of its own; what the page sends goes to `onSend`. */
class InProcessSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static last: InProcessSocket | undefined;

  readyState = InProcessSocket.CONNECTING;
  binaryType: "blob" | "arraybuffer" = "blob";
  onSend: (msg: ClientToServer) => void = () => undefined;
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
    this.onSend(JSON.parse(data) as ClientToServer);
  }

  close(): void {
    this.readyState = InProcessSocket.CLOSED;
  }

  open(): void {
    this.readyState = InProcessSocket.OPEN;
    this.listeners.open.forEach((l) => l());
  }

  // A browser hands a text frame over as a string and a binary frame as an
  // ArrayBuffer (binaryType "arraybuffer").
  deliver(data: string | ArrayBufferLike | ArrayBufferView): void {
    const frame =
      typeof data === "string"
        ? data
        : ArrayBuffer.isView(data)
          ? new Uint8Array(
              data.buffer,
              data.byteOffset,
              data.byteLength,
            ).slice().buffer
          : new Uint8Array(data).slice().buffer;
    setTimeout(() => {
      this.listeners.message.forEach((l) => l({ data: frame }));
    }, 0);
  }

  deliverFrame(frame: ServerToClient): void {
    this.deliver(JSON.stringify(frame));
  }
}

/** A connected page: the bridge, the adapter over it, and its socket. */
function page(): {
  bridge: WebSocketBridge;
  conn: BridgePaneStreamClient;
  socket: InProcessSocket;
} {
  const bridge = new WebSocketBridge();
  const conn = new BridgePaneStreamClient(bridge);
  bridge.connect("ws://in-process");
  return { bridge, conn, socket: InProcessSocket.last! };
}

async function openBridged(
  socketName: string,
  session: string,
): Promise<{ conn: BridgePaneStreamClient; close(): void }> {
  tmux(socketName, ["new-session", "-d", "-s", session]);
  const { bridge, conn, socket } = page();
  // The server side of one connection, as server/bridge.ts handles it.
  const client = new TmuxClient(
    spawnTmux(["attach-session", "-t", session], { socketPath: socketName }),
  );
  const detach = forwardClientToSocket(client, {
    readyState: InProcessSocket.OPEN,
    OPEN: InProcessSocket.OPEN,
    send: (data) => socket.deliver(data),
  });
  announceReadyOnAttach(client, (frame) => socket.deliverFrame(frame));
  socket.onSend = (msg) => {
    if (msg.kind === "execute" || msg.kind === "sendKeys") {
      void replyToCommand(client, msg).then((f) => socket.deliverFrame(f));
    } else {
      socket.deliverFrame({
        kind: "error",
        id: msg.id,
        code: "BRIDGE_INTERNAL",
        message: `the move cases send no ${msg.kind}`,
      });
    }
  };
  const close = (): void => {
    detach();
    bridge.disconnect();
    client.close();
  };
  socket.open();
  try {
    await readUntil(
      () => conn.connectionState.status,
      (status) => status === "ready",
      "the bridged connection never became ready",
    );
  } catch (err) {
    close();
    throw new Error("the bridged connection never became ready", {
      cause: err,
    });
  }
  return { conn, close };
}

const settle = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 10));

beforeAll(() => {
  vi.stubGlobal("WebSocket", InProcessSocket);
});
afterAll(() => {
  vi.unstubAllGlobals();
});

describe("BridgePaneStreamClient command seam", () => {
  it("a tmux %error rejects as TmuxCommandError, so the router's refresh of a gone window reports nothing", async () => {
    const { bridge, conn, socket } = page();
    try {
      const reported: Error[] = [];
      conn.on("topology-error", (ev) => reported.push(ev.error));
      // The demo server answers a failed command with a `success: false`
      // response frame; @9 is a window that is gone.
      socket.onSend = (msg) => {
        const gone = msg.kind === "execute" && msg.command.includes("-t @9");
        socket.deliverFrame({
          kind: "response",
          id: msg.id,
          response: {
            commandNumber: 0,
            timestamp: 0,
            output: gone ? ["can't find window: @9"] : [],
            success: !gone,
          },
        });
      };
      socket.open();
      socket.deliverFrame({ kind: "ready" });
      await settle();

      await expect(conn.execute("list-panes -t @9")).rejects.toBeInstanceOf(
        TmuxCommandError,
      );
      conn.attachBytesSink(
        { write: () => undefined, end: () => undefined },
        { scope: windowScope(9) },
      );
      socket.deliverFrame({
        kind: "event",
        event: { type: "window-close", windowId: 9 },
      });
      await settle();
      expect(reported).toEqual([]);
    } finally {
      bridge.disconnect();
    }
  });

  it("a command the server's lost tmux connection could not carry retires the router's connection before the socket closes, so it reports no topology error", async () => {
    const { bridge, conn, socket } = page();
    try {
      const reported: Error[] = [];
      conn.on("topology-error", (ev) => reported.push(ev.error));
      socket.onSend = (msg) => {
        if (msg.kind !== "execute") return;
        // The server's tmux client ended with this command in flight.
        void replyToCommand(
          {
            execute: () =>
              Promise.reject(new TransportClosedError("tmux exited")),
          } as unknown as TmuxClient,
          msg,
        ).then((f) => socket.deliverFrame(f));
      };
      socket.open();
      socket.deliverFrame({ kind: "ready" });
      await settle();

      conn.attachBytesSink(
        { write: () => undefined, end: () => undefined },
        { scope: windowScope(1) },
      );
      await settle();
      expect(reported).toEqual([]);
    } finally {
      bridge.disconnect();
    }
  });

  it("delivers connection-state after the consumer code running when the bridge closed, never inside it", async () => {
    const { bridge, conn, socket } = page();
    try {
      socket.open();
      socket.deliverFrame({ kind: "ready" });
      await settle();
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

      socket.deliver(
        encodePaneOutput({ paneId: 1, data: new Uint8Array([0x61]) }),
      );
      await settle();
      expect(order).toEqual(["write", "write returned", "closed"]);
    } finally {
      bridge.disconnect();
    }
  });

  it("retires the router's connection before consumers hear it closed, so a window sink attached then asks nothing of it", async () => {
    const { bridge, conn, socket } = page();
    try {
      const bridgeErrors: string[] = [];
      bridge.onError((message) => bridgeErrors.push(message));
      socket.open();
      socket.deliverFrame({ kind: "ready" });
      await settle();
      conn.on("connection-state", ({ state }) => {
        if (state.status === "closed") {
          conn.attachBytesSink(
            { write: () => undefined, end: () => undefined },
            { scope: windowScope(1) },
          );
        }
      });

      bridge.disconnect();
      await settle();
      // A bootstrap on the dropped connection would be refused with
      // "cannot execute: bridge is not connected".
      expect(bridgeErrors).toEqual([]);
    } finally {
      bridge.disconnect();
    }
  });
});

describeTopologyMoves("BridgePaneStreamClient", openBridged);
