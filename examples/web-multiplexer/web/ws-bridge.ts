// examples/web-multiplexer/web/ws-bridge.ts
// The web entry's bridge: the library's WebSocket connector on `/ws`, and the
// firehose on its own socket at `/firehose-ws`.
//
// [LAW:no-ambient-temporal-coupling] The server taps every pane for exactly as
//   long as the firehose socket is open, so `start` opens it and `stop` closes
//   it. A socket the server closes is forgotten; the stores start the
//   firehose again on their next `ready`, which opens a fresh one.

import { WebSocketTmuxClient } from "@promptctl/tmux-control-mode-js/websocket/client";
import {
  decodePaneOutput,
  isPaneOutputFrame,
} from "@promptctl/tmux-control-mode-js/websocket/protocol";
import { FIREHOSE_WS_PATH, TMUX_WS_PATH } from "../shared/config.ts";
import type { FirehoseHandler } from "./bridge.ts";
import { LibraryBridge, type Firehose } from "./library-bridge.ts";

/** `ws://` or `wss://` to `path` on the page's own host, as Vite proxies it. */
function socketUrl(path: string): string {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${location.host}${path}`;
}

export function webSocketBridge(): LibraryBridge {
  return new LibraryBridge(
    (reportError) =>
      new WebSocketTmuxClient({
        url: socketUrl(TMUX_WS_PATH),
        onError: (err) => reportError(err.message),
      }),
    (sink, reportError) =>
      new FirehoseSocket(socketUrl(FIREHOSE_WS_PATH), sink, reportError),
  );
}

export class FirehoseSocket implements Firehose {
  private socket: WebSocket | null = null;

  constructor(
    private readonly url: string,
    private readonly sink: FirehoseHandler,
    private readonly reportError: (message: string) => void,
    private readonly createSocket: (url: string) => WebSocket = (url) =>
      new WebSocket(url),
  ) {}

  start(): void {
    if (this.socket !== null) return;
    const socket = this.createSocket(this.url);
    socket.binaryType = "arraybuffer";
    socket.addEventListener("message", (ev: MessageEvent<unknown>) => {
      if (this.socket !== socket) return;
      const frame =
        ev.data instanceof ArrayBuffer ? new Uint8Array(ev.data) : null;
      if (frame === null || !isPaneOutputFrame(frame)) {
        this.stop();
        this.reportError("the server sent a frame that is not pane output");
        return;
      }
      const { paneId, data } = decodePaneOutput(frame);
      this.sink(paneId, data);
    });
    socket.addEventListener("close", (ev: CloseEvent) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.reportError(
        `socket closed (${ev.code}${ev.reason === "" ? "" : `: ${ev.reason}`})`,
      );
    });
    this.socket = socket;
  }

  stop(): void {
    const socket = this.socket;
    this.socket = null;
    socket?.close();
  }
}
