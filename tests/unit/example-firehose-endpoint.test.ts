// tests/unit/example-firehose-endpoint.test.ts
//
// A firehose socket taps every pane for exactly as long as it is open, and
// carries nothing but the library's pane-output frames.

import { describe, it, expect } from "vitest";
import { decodePaneOutput } from "@promptctl/tmux-control-mode-js/websocket/protocol";
import { deferred } from "../../examples/web-multiplexer/web/test-utils.js";
import type { FirehoseSink } from "../../examples/web-multiplexer/server/pane-firehose.js";
import {
  FirehoseEndpoint,
  type Firehose,
  type FirehoseSocket,
} from "../../examples/web-multiplexer/server/firehose-endpoint.js";

interface FakeSocket extends FirehoseSocket {
  readonly sent: Uint8Array[];
  readonly closes: { code: number; reason: string }[];
  receive(): void;
}

function fakeSocket(): FakeSocket {
  const listeners: Record<"message" | "close", (() => void)[]> = {
    message: [],
    close: [],
  };
  const socket: FakeSocket = {
    OPEN: 1,
    readyState: 1,
    sent: [],
    closes: [],
    send(data) {
      socket.sent.push(data);
    },
    close(code, reason) {
      socket.closes.push({ code, reason });
      (socket as { readyState: number }).readyState = 3;
      listeners.close.forEach((l) => l());
    },
    on(event, listener) {
      listeners[event].push(listener);
    },
    receive() {
      listeners.message.forEach((l) => l());
    },
  };
  return socket;
}

/** A firehose that records its lifecycle and hands its sink to the test. */
function fakeFirehoses(start: () => Promise<void> = () => Promise.resolve()): {
  started: number;
  stopped: number;
  sinks: FirehoseSink[];
  startFirehose: (execute: unknown, sink: FirehoseSink) => Firehose;
} {
  const rig = {
    started: 0,
    stopped: 0,
    sinks: [] as FirehoseSink[],
    startFirehose: (_execute: unknown, sink: FirehoseSink): Firehose => {
      rig.sinks.push(sink);
      return {
        start: () => {
          rig.started += 1;
          return start();
        },
        stop: () => {
          rig.stopped += 1;
        },
      };
    },
  };
  return rig;
}

const noExecute = () => Promise.reject(new Error("not used by these cases"));

describe("FirehoseEndpoint", () => {
  it("starts the taps when a socket opens and stops them when it closes", () => {
    const rig = fakeFirehoses();
    const endpoint = new FirehoseEndpoint(noExecute, rig.startFirehose);
    const ws = fakeSocket();

    endpoint.accept(ws);
    expect([rig.started, rig.stopped]).toEqual([1, 0]);

    ws.close(1000, "page left");
    expect([rig.started, rig.stopped]).toEqual([1, 1]);
  });

  it("sends a tapped chunk as a pane-output frame that decodes to the same pane and bytes", () => {
    const rig = fakeFirehoses();
    const endpoint = new FirehoseEndpoint(noExecute, rig.startFirehose);
    const ws = fakeSocket();
    endpoint.accept(ws);
    const bytes = new Uint8Array([0x00, 0x1b, 0x5b, 0xff, 0x0a]);

    rig.sinks[0](7, bytes);

    expect(ws.sent).toHaveLength(1);
    const frame = decodePaneOutput(ws.sent[0]);
    expect(frame.paneId).toBe(7);
    expect([...frame.data]).toEqual([...bytes]);
  });

  it("closes a socket that sends anything with 1003, and stops its taps", () => {
    const rig = fakeFirehoses();
    const endpoint = new FirehoseEndpoint(noExecute, rig.startFirehose);
    const ws = fakeSocket();
    endpoint.accept(ws);

    ws.receive();

    expect(ws.closes.map((c) => c.code)).toEqual([1003]);
    expect(rig.stopped).toBe(1);
  });

  it("closes the socket with 1011 and a reason that fits a close frame when the taps fail to start", async () => {
    const failed = deferred<undefined>();
    const rig = fakeFirehoses(() => failed.promise);
    const endpoint = new FirehoseEndpoint(noExecute, rig.startFirehose);
    const ws = fakeSocket();
    endpoint.accept(ws);

    failed.reject(new Error("é".repeat(200)));
    await failed.promise.catch(() => undefined);
    await Promise.resolve();

    expect(ws.closes).toHaveLength(1);
    expect(ws.closes[0].code).toBe(1011);
    expect(Buffer.byteLength(ws.closes[0].reason)).toBeLessThanOrEqual(123);
  });

  it("closes every open socket when the tmux connection the taps run on is lost", () => {
    const rig = fakeFirehoses();
    const endpoint = new FirehoseEndpoint(noExecute, rig.startFirehose);
    const sockets = [fakeSocket(), fakeSocket()];
    sockets.forEach((ws) => endpoint.accept(ws));

    endpoint.closeAll("tmux connection lost");

    expect(sockets.map((ws) => ws.closes)).toEqual([
      [{ code: 1011, reason: "tmux connection lost" }],
      [{ code: 1011, reason: "tmux connection lost" }],
    ]);
    expect(rig.stopped).toBe(2);
  });
});
