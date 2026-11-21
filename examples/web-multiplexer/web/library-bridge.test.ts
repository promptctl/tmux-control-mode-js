// examples/web-multiplexer/web/library-bridge.test.ts
//
// LibraryBridge over a hand-written connection whose replies the test settles:
// what the page sees of calls, the wire log, state and reconnects. A call is
// answered on the connection it was sent on, or not at all; nothing is ever
// replayed onto the next one.
//
// The file reads the package's built dist/ as the demo does: run
// `pnpm run build` first.

import { describe, it, expect } from "vitest";
import { TmuxCommandError } from "@promptctl/tmux-control-mode-js/browser";
import type {
  BytesSink,
  ConnectionState,
  EmitterMessage,
} from "@promptctl/tmux-control-mode-js/browser";
import { BridgeError } from "@promptctl/tmux-control-mode-js/websocket/protocol";
import type { CommandResponse } from "@promptctl/tmux-control-mode-js/protocol";
import type { WireEntry } from "./bridge.ts";
import {
  LibraryBridge,
  type BridgeConnection,
  type Firehose,
} from "./library-bridge.ts";
import { deferred, tick, type Deferred } from "./test-utils.ts";

const OK: CommandResponse = {
  commandNumber: 1,
  timestamp: 0,
  output: ["ok"],
  success: true,
};

/** One connection: every call waits on a gate the test opens. */
class FakeConnection implements BridgeConnection {
  connectionState: ConnectionState = { status: "connecting" };
  readonly calls: { command: string; reply: Deferred<CommandResponse> }[] = [];
  closed = false;
  private readonly listeners = new Set<(ev: EmitterMessage) => void>();
  sink: BytesSink | null = null;

  execute(command: string): Promise<CommandResponse> {
    const reply = deferred<CommandResponse>();
    this.calls.push({ command, reply });
    return reply.promise;
  }
  sendKeys(target: string, keys: string): Promise<CommandResponse> {
    return this.execute(`send-keys -t ${target} ${keys}`);
  }
  setSize(): Promise<CommandResponse> {
    return this.execute("refresh-client -C");
  }
  setWindowSize(): Promise<CommandResponse> {
    return this.execute("refresh-client -C @");
  }
  clearWindowSize(): Promise<CommandResponse> {
    return this.execute("refresh-client -C @ clear");
  }
  on(_event: string, handler: (ev: never) => void): void {
    this.listeners.add(handler as (ev: EmitterMessage) => void);
  }
  off(_event: string, handler: (ev: never) => void): void {
    this.listeners.delete(handler as (ev: EmitterMessage) => void);
  }
  attachBytesSink(sink: BytesSink): () => void {
    this.sink = sink;
    return () => {
      this.sink = null;
    };
  }
  close(): void {
    this.closed = true;
    // A library connection fails what it still owed as BRIDGE_CLOSED.
    for (const { reply } of this.calls) {
      reply.reject(new BridgeError("BRIDGE_CLOSED", "connection closed"));
    }
  }

  /** The connection reports a new state, as the library's do on `"*"`. */
  becomes(state: ConnectionState): void {
    this.connectionState = state;
    this.listeners.forEach((l) => l({ type: "connection-state", state }));
  }
  emit(msg: EmitterMessage): void {
    this.listeners.forEach((l) => l(msg));
  }
}

const noFirehose = (): Firehose => ({
  start: () => undefined,
  stop: () => undefined,
});

function rig(): {
  bridge: LibraryBridge;
  connections: FakeConnection[];
  wire: WireEntry[];
  errors: string[];
  states: ConnectionState[];
  observerErrors: unknown[];
} {
  const connections: FakeConnection[] = [];
  const observerErrors: unknown[] = [];
  const bridge = new LibraryBridge(
    () => {
      const c = new FakeConnection();
      connections.push(c);
      return c;
    },
    noFirehose,
    { now: () => 100, onObserverError: (err) => observerErrors.push(err) },
  );
  const wire: WireEntry[] = [];
  const errors: string[] = [];
  const states: ConnectionState[] = [];
  bridge.onWire((entry) => wire.push(entry));
  bridge.onError((message) => errors.push(message));
  bridge.onState((state) => states.push(state));
  return { bridge, connections, wire, errors, states, observerErrors };
}

describe("LibraryBridge calls", () => {
  it("rejects a call made before any connection with BRIDGE_CLOSED, and logs it as a bridge error", async () => {
    const { bridge, wire, errors } = rig();

    const call = bridge.execute("list-panes");

    await expect(call).rejects.toBeInstanceOf(BridgeError);
    await expect(call).rejects.toMatchObject({ code: "BRIDGE_CLOSED" });
    expect(wire.map((w) => w.dir)).toEqual(["in-error"]);
    expect(errors).toHaveLength(1);
  });

  it("logs a tmux %error as the response it is, and reports no bridge error", async () => {
    const { bridge, connections, wire, errors } = rig();
    bridge.connect();
    const failed = { ...OK, output: ["can't find pane"], success: false };

    const call = bridge.execute("list-panes -t %9");
    connections[0].calls[0].reply.reject(new TmuxCommandError(failed));

    await expect(call).rejects.toBeInstanceOf(TmuxCommandError);
    expect(wire.map((w) => w.dir)).toEqual(["out", "in-response"]);
    expect(wire[1]).toMatchObject({ response: failed, latencyMs: 0 });
    expect(errors).toEqual([]);
  });

  it("logs a bridge failure as an error and reports it", async () => {
    const { bridge, connections, wire, errors } = rig();
    bridge.connect();

    const call = bridge.execute("list-panes");
    connections[0].calls[0].reply.reject(
      new BridgeError("BRIDGE_TIMEOUT", "no reply"),
    );

    await expect(call).rejects.toMatchObject({ code: "BRIDGE_TIMEOUT" });
    expect(wire.map((w) => w.dir)).toEqual(["out", "in-error"]);
    expect(errors).toEqual(["[BRIDGE_TIMEOUT] no reply"]);
  });

  it("never carries a call over to the next connection", async () => {
    const { bridge, connections } = rig();
    bridge.connect();
    const call = bridge.execute("list-panes");

    bridge.disconnect();
    bridge.connect();

    await expect(call).rejects.toMatchObject({ code: "BRIDGE_CLOSED" });
    expect(connections[0].closed).toBe(true);
    expect(connections[1].calls).toEqual([]);
  });
});

describe("LibraryBridge state", () => {
  it("reports the connection's state whole, a refusal's error included", () => {
    const { bridge, connections, states } = rig();
    bridge.connect();
    const refused: ConnectionState = {
      status: "closed",
      reason: "refused",
      error: new Error("tmux did not attach"),
    };

    connections[0].becomes({ status: "ready" });
    connections[0].becomes(refused);

    expect(states).toEqual([
      { status: "closed", reason: "disposed" },
      { status: "connecting" },
      { status: "ready" },
      refused,
    ]);
  });

  it("keeps a live connection on connect(), and opens a fresh one once it has closed", () => {
    const { bridge, connections, states } = rig();
    bridge.connect();
    connections[0].becomes({ status: "ready" });

    bridge.connect();
    expect(connections).toHaveLength(1);

    connections[0].becomes({ status: "closed", reason: "transport-error" });
    bridge.connect();

    expect(connections).toHaveLength(2);
    expect(connections[0].closed).toBe(true);
    expect(states.at(-1)).toEqual({ status: "connecting" });
  });

  it("hears nothing more from a connection it has let go", () => {
    const { bridge, connections, states } = rig();
    bridge.connect();
    const first = connections[0];
    bridge.disconnect();
    bridge.connect();
    const before = states.length;

    first.becomes({ status: "ready" });

    expect(states).toHaveLength(before);
  });
});

describe("LibraryBridge handlers", () => {
  it("keeps delivering to every handler when one throws, and reports each throw", async () => {
    const { bridge, connections, observerErrors } = rig();
    const events: string[] = [];
    bridge.onWire(() => {
      throw new Error("wire handler");
    });
    bridge.onEvent(() => {
      throw new Error("event handler");
    });
    bridge.onEvent((ev) => events.push(ev.type));
    bridge.connect();

    const call = bridge.execute("list-panes");
    connections[0].calls[0].reply.resolve(OK);
    connections[0].emit({ type: "window-add", windowId: 1 });

    await expect(call).resolves.toBe(OK);
    await tick();
    expect(events).toEqual(["window-add"]);
    expect(observerErrors.map((e) => (e as Error).message)).toEqual(
      expect.arrayContaining(["wire handler", "event handler"]),
    );
  });

  it("delivers pane bytes on onPaneOutput, never as an event", () => {
    const { bridge, connections, wire } = rig();
    const chunks: number[] = [];
    const events: string[] = [];
    bridge.onPaneOutput((chunk) => chunks.push(chunk.paneId));
    bridge.onEvent((ev) => events.push(ev.type));
    bridge.connect();

    connections[0].sink?.write({ paneId: 3, data: new Uint8Array([0x61]) });

    expect(chunks).toEqual([3]);
    expect(events).toEqual([]);
    expect(wire.map((w) => w.dir)).toEqual(["in-output"]);
  });
});
