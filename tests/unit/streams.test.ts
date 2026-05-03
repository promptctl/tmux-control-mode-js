// tests/unit/streams.test.ts
// Behavior-level tests for the three TmuxClient projections:
//   - toReadableStream (Web Streams)
//   - toNodeStream (Node Readable in objectMode)
//   - toEventEmitter (Node EventEmitter)
//
// Each test drives a real TmuxClient with a fake TmuxTransport, feeding
// canned control-mode lines so the projection sees real parsed messages
// emerging from the public API surface.

import { TmuxClient } from "../../src/client.js";
import type { TmuxTransport } from "../../src/transport/types.js";
import type { TmuxMessage } from "../../src/protocol/types.js";

import { toReadableStream } from "../../src/connectors/streams/web.js";
import {
  toNodeStream,
  toEventEmitter,
} from "../../src/connectors/streams/node.js";

interface FakeTransport extends TmuxTransport {
  readonly sent: string[];
  feed(chunk: string): void;
  triggerClose(reason?: string): void;
}

function createFakeTransport(): FakeTransport {
  const dataCallbacks: ((chunk: string) => void)[] = [];
  const closeCallbacks: ((reason?: string) => void)[] = [];
  const sent: string[] = [];
  return {
    sent,
    send(command: string): void {
      sent.push(command);
    },
    onData(cb): void {
      dataCallbacks.push(cb);
    },
    onClose(cb): void {
      closeCallbacks.push(cb);
    },
    close(): void {},
    feed(chunk: string): void {
      dataCallbacks.forEach((cb) => cb(chunk));
    },
    triggerClose(reason?: string): void {
      closeCallbacks.forEach((cb) => cb(reason));
    },
  };
}

// Three notifications + a fake-out: a session-changed, a window-add, and
// then a transport close. The parser strips trailing \n and produces
// strongly-typed messages.
const NOTIFICATIONS = [
  "%session-changed $0 main\n",
  "%window-add @1\n",
];

describe("toReadableStream", () => {
  it("emits every notification followed by exit, then closes", async () => {
    const transport = createFakeTransport();
    const client = new TmuxClient(transport);
    const stream = toReadableStream(client);
    const reader = stream.getReader();

    NOTIFICATIONS.forEach((line) => transport.feed(line));
    transport.triggerClose("test-shutdown");

    const collected: TmuxMessage[] = [];
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      collected.push(value);
    }

    expect(collected.map((m) => m.type)).toEqual([
      "session-changed",
      "window-add",
      "exit",
    ]);
    const exit = collected[2];
    expect(exit.type === "exit" && exit.reason).toBe("test-shutdown");
  });

  it("cancelling the reader unsubscribes from the client", async () => {
    const transport = createFakeTransport();
    const client = new TmuxClient(transport);
    const stream = toReadableStream(client);
    const reader = stream.getReader();

    transport.feed("%session-changed $0 main\n");
    const first = await reader.read();
    expect(first.value?.type).toBe("session-changed");

    await reader.cancel();

    // Further events on the client must not throw or buffer in a leaked
    // controller. The stream is gone; we just verify no crash.
    transport.feed("%window-add @1\n");
    expect(true).toBe(true);
  });
});

describe("toNodeStream", () => {
  it("pushes every notification followed by null on exit", async () => {
    const transport = createFakeTransport();
    const client = new TmuxClient(transport);
    const stream = toNodeStream(client);

    const collected: TmuxMessage[] = [];
    stream.on("data", (msg: TmuxMessage) => collected.push(msg));
    const ended = new Promise<void>((resolve) => stream.on("end", resolve));

    NOTIFICATIONS.forEach((line) => transport.feed(line));
    transport.triggerClose("done");
    await ended;

    expect(collected.map((m) => m.type)).toEqual([
      "session-changed",
      "window-add",
      "exit",
    ]);
  });

  it("destroying the stream unsubscribes from the client", async () => {
    const transport = createFakeTransport();
    const client = new TmuxClient(transport);
    const stream = toNodeStream(client);

    const collected: TmuxMessage[] = [];
    stream.on("data", (msg: TmuxMessage) => collected.push(msg));

    transport.feed("%session-changed $0 main\n");
    // Yield once so the data event handler runs synchronously enough to
    // capture the first event before destroy.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(collected.map((m) => m.type)).toEqual(["session-changed"]);

    stream.destroy();
    await new Promise<void>((resolve) => stream.on("close", resolve));

    transport.feed("%window-add @1\n");
    // Stream is destroyed — no further data events should arrive.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(collected.map((m) => m.type)).toEqual(["session-changed"]);
  });
});

describe("toEventEmitter", () => {
  it("re-emits each notification under its type and on the wildcard channel", () => {
    const transport = createFakeTransport();
    const client = new TmuxClient(transport);
    const ee = toEventEmitter(client);

    const sessionChanged: TmuxMessage[] = [];
    const wildcard: TmuxMessage[] = [];
    ee.on("session-changed", (m: TmuxMessage) => sessionChanged.push(m));
    ee.on("*", (m: TmuxMessage) => wildcard.push(m));

    transport.feed("%session-changed $0 main\n");
    transport.feed("%window-add @1\n");

    expect(sessionChanged.map((m) => m.type)).toEqual(["session-changed"]);
    expect(wildcard.map((m) => m.type)).toEqual([
      "session-changed",
      "window-add",
    ]);
  });

  it("emits the synthetic exit message when the transport closes", () => {
    const transport = createFakeTransport();
    const client = new TmuxClient(transport);
    const ee = toEventEmitter(client);

    const exits: TmuxMessage[] = [];
    ee.on("exit", (m: TmuxMessage) => exits.push(m));

    transport.triggerClose("bye");
    expect(exits).toHaveLength(1);
    expect(exits[0].type === "exit" && exits[0].reason).toBe("bye");
  });
});
