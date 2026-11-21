// examples/web-multiplexer/web/ws-bridge.test.ts
//
// The web entry's bridge: the library WebSocket connector on /ws, over the
// library's own mock socket hub, and the firehose socket beside it.
//
// The file reads the package's built dist/ as the demo does: run
// `pnpm run build` first.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  encodePaneOutput,
  encodeServerFrame,
} from "@promptctl/tmux-control-mode-js/websocket/protocol";
import type { ConnectionState } from "@promptctl/tmux-control-mode-js/browser";
import { MockWebSocketHub } from "../../../tests/unit/_helpers/websocket-hub.ts";
import { FIREHOSE_WS_PATH, TMUX_WS_PATH } from "../shared/config.ts";
import {
  FirehoseSocket,
  webSocketBridge,
  type FirehoseWebSocket,
} from "./ws-bridge.ts";
import { tick } from "./test-utils.ts";

/** A binary frame as a browser hands it over with binaryType "arraybuffer". */
function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}

describe("webSocketBridge", () => {
  let hub: MockWebSocketHub;
  beforeEach(() => {
    hub = new MockWebSocketHub();
    const factory = hub.factory;
    vi.stubGlobal("location", { protocol: "http:", host: "localhost:44173" });
    vi.stubGlobal("WebSocket", function MockWebSocket(url: string) {
      return factory(url);
    } as unknown as typeof WebSocket);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("dials /ws on the page's host and is ready once the server welcomes it", async () => {
    const bridge = webSocketBridge();
    const states: ConnectionState["status"][] = [];
    bridge.onState((s) => states.push(s.status));

    bridge.connect();
    hub.open();
    hub.welcome();
    await tick();

    expect(hub.latest().url).toBe(`ws://localhost:44173${TMUX_WS_PATH}`);
    expect(states.at(-1)).toBe("ready");
    bridge.disconnect();
  });

  it("delivers a pane-output frame on onPaneOutput", async () => {
    const bridge = webSocketBridge();
    const chunks: { paneId: number; bytes: number[] }[] = [];
    bridge.onPaneOutput(({ paneId, data }) =>
      chunks.push({ paneId, bytes: [...data] }),
    );
    bridge.connect();
    hub.open();
    hub.welcome();
    await tick();

    hub.latest().fire("message", {
      data: arrayBuffer(
        encodePaneOutput({ paneId: 4, data: new Uint8Array([0x68, 0x69]) }),
      ),
    });
    await tick();

    expect(chunks).toEqual([{ paneId: 4, bytes: [0x68, 0x69] }]);
    bridge.disconnect();
  });

  it("opens the firehose on its own socket at /firehose-ws", () => {
    const bridge = webSocketBridge();

    bridge.startFirehose();

    expect(hub.latest().url).toBe(`ws://localhost:44173${FIREHOSE_WS_PATH}`);
    bridge.stopFirehose();
  });

  it("is refused, with the server's reason, when the server sends no welcome but a fatal error", async () => {
    const bridge = webSocketBridge();
    const states: ConnectionState[] = [];
    bridge.onState((s) => states.push(s));
    bridge.connect();
    hub.open();

    hub.latest().fire("message", {
      data: encodeServerFrame({
        k: "error",
        fatal: true,
        error: { code: "BRIDGE_REFUSED", message: "tmux did not attach" },
      }),
    });
    // The server closes a refused page with a 44xx code after the frame.
    hub.fireClose(-1, 4403, "refused");
    await tick();

    expect(states.at(-1)).toMatchObject({
      status: "closed",
      reason: "refused",
      error: {
        code: "BRIDGE_REFUSED",
        message: expect.stringContaining("tmux did not attach"),
      },
    });
    bridge.disconnect();
  });
});

/** A socket the test drives: what it was sent, and its close. */
interface FakeSocket extends FirehoseWebSocket {
  closed: boolean;
  message(data: unknown): void;
  serverClose(code: number, reason: string): void;
}

function fakeSocket(): FakeSocket {
  const onMessage: ((ev: { data: unknown }) => void)[] = [];
  const onClose: ((ev: { code: number; reason: string }) => void)[] = [];
  const socket: FakeSocket = {
    binaryType: "blob",
    closed: false,
    addEventListener(type: string, listener: never) {
      if (type === "message") onMessage.push(listener);
      else onClose.push(listener);
    },
    close() {
      socket.closed = true;
    },
    message(data) {
      onMessage.forEach((l) => l({ data }));
    },
    serverClose(code, reason) {
      onClose.forEach((l) => l({ code, reason }));
    },
  };
  return socket;
}

function firehose(): {
  fh: FirehoseSocket;
  sockets: FakeSocket[];
  received: { paneId: number; bytes: number[] }[];
  errors: string[];
} {
  const sockets: FakeSocket[] = [];
  const received: { paneId: number; bytes: number[] }[] = [];
  const errors: string[] = [];
  const fh = new FirehoseSocket(
    "ws://page/firehose-ws",
    (paneId, data) => received.push({ paneId, bytes: [...data] }),
    (message) => errors.push(message),
    () => {
      const s = fakeSocket();
      sockets.push(s);
      return s;
    },
  );
  return { fh, sockets, received, errors };
}

describe("FirehoseSocket", () => {
  it("delivers each pane-output frame to its sink, and opens one socket however often it is started", () => {
    const { fh, sockets, received } = firehose();
    fh.start();
    fh.start();

    sockets[0].message(
      arrayBuffer(encodePaneOutput({ paneId: 2, data: new Uint8Array([1]) })),
    );

    expect(sockets).toHaveLength(1);
    expect(sockets[0].binaryType).toBe("arraybuffer");
    expect(received).toEqual([{ paneId: 2, bytes: [1] }]);
  });

  it.each([
    { name: "a text frame", data: "hello" },
    {
      name: "a binary frame that is not pane output",
      data: arrayBuffer(new Uint8Array([0x01, 0x02])),
    },
  ])("reports $name and closes the socket", ({ data }) => {
    const { fh, sockets, received, errors } = firehose();
    fh.start();

    sockets[0].message(data);

    expect(received).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(sockets[0].closed).toBe(true);
  });

  it("delivers nothing that arrives after stop()", () => {
    const { fh, sockets, received } = firehose();
    fh.start();
    fh.stop();

    sockets[0].message(
      arrayBuffer(encodePaneOutput({ paneId: 2, data: new Uint8Array([1]) })),
    );

    expect(sockets[0].closed).toBe(true);
    expect(received).toEqual([]);
  });

  it("reports a close it did not ask for, and opens a fresh socket on the next start", () => {
    const { fh, sockets, errors } = firehose();
    fh.start();

    sockets[0].serverClose(1011, "tmux connection lost");
    fh.start();

    expect(errors).toEqual(["socket closed (1011: tmux connection lost)"]);
    expect(sockets).toHaveLength(2);
  });
});
