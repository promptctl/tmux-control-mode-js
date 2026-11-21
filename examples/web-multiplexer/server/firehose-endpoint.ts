// examples/web-multiplexer/server/firehose-endpoint.ts
// The `/firehose-ws` endpoint: live bytes from every pane, one socket per page.
//
// [LAW:no-ambient-temporal-coupling] A socket's lifetime IS its firehose's
//   lifetime: opening the socket starts the taps, closing it stops them. There
//   is no start/stop message, so no request can outlive the socket it was sent
//   on or reach the next one.
// [LAW:one-source-of-truth] Frames are the library's pane-output frames
//   (`encodePaneOutput`), the same codec `/ws` uses for attached pane bytes.
// The channel is server-to-browser only: an inbound frame closes the socket.

import { encodePaneOutput } from "@promptctl/tmux-control-mode-js/websocket";
import type { FirehoseExecute, FirehoseSink } from "./pane-firehose.js";

/** The firehose an endpoint socket drives: started once, stopped once. */
export interface Firehose {
  start(): Promise<void>;
  stop(): void;
}

export type StartFirehose = (
  execute: FirehoseExecute,
  sink: FirehoseSink,
) => Firehose;

/** The part of a server-side `ws` socket the endpoint uses. */
export interface FirehoseSocket {
  readonly readyState: number;
  readonly OPEN: number;
  send(data: Uint8Array): void;
  close(code: number, reason: string): void;
  on(event: "message" | "close", listener: () => void): void;
}

/** Close code for a frame the browser had no business sending. */
const UNSUPPORTED_DATA = 1003;
/** Close code for the tap failing on the server side. */
const INTERNAL_ERROR = 1011;

export class FirehoseEndpoint {
  private readonly sockets = new Set<FirehoseSocket>();

  constructor(
    private readonly execute: FirehoseExecute,
    private readonly startFirehose: StartFirehose,
  ) {}

  accept(ws: FirehoseSocket): void {
    this.sockets.add(ws);
    const firehose = this.startFirehose(this.execute, (paneId, data) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(encodePaneOutput({ paneId, data }));
      }
    });
    ws.on("message", () =>
      ws.close(UNSUPPORTED_DATA, "the firehose is server-to-browser only"),
    );
    ws.on("close", () => {
      this.sockets.delete(ws);
      firehose.stop();
    });
    firehose.start().catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      ws.close(INTERNAL_ERROR, closeReason(`firehose failed: ${message}`));
    });
  }

  /** Close every socket, as when the tmux connection the taps run on ends. */
  closeAll(reason: string): void {
    for (const ws of [...this.sockets]) {
      ws.close(INTERNAL_ERROR, closeReason(reason));
    }
  }
}

/** A WebSocket close reason may be at most 123 UTF-8 bytes (RFC 6455 §5.5),
 *  and `ws` throws past that, so trim whole characters until it fits. */
function closeReason(text: string): string {
  let chars = [...text];
  while (Buffer.byteLength(chars.join("")) > 123) chars = chars.slice(0, -1);
  return chars.join("");
}
