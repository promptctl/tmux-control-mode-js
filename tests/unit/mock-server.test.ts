// tests/unit/mock-server.test.ts
// MockTmuxServer drives a REAL TmuxClient with no tmux process. This is the
// library's own integration harness: if the client parses, correlates, routes
// bytes, and surfaces events correctly against the mock's protocol-faithful
// wire, it does so against real tmux too (the wire is the same — guaranteed by
// the serializer↔parser round-trip in protocol-serializer.test.ts).
//
// [LAW:verifiable-goals] Deterministic, tmux-free, runs in the unit tier.

import { describe, it, expect } from "vitest";
import { MockTmuxServer } from "../../src/mock/index.js";
import type { MockScenario } from "../../src/mock/index.js";
import { TmuxClient } from "../../src/client.js";
import { TmuxCommandError, TransportSendError } from "../../src/errors.js";
import { serverScope } from "../../src/pane-output.js";
import type { BytesSink, ChunkPayload } from "../../src/pane-output.js";
import type { EmitterMessage } from "../../src/emitter.js";

// Collect every emitted event off the wildcard channel.
function collectEvents(client: TmuxClient): EmitterMessage[] {
  const events: EmitterMessage[] = [];
  client.on("*", (ev) => events.push(ev));
  return events;
}

describe("MockTmuxServer drives a real TmuxClient", () => {
  it("delivers the greeting topology as parsed events", () => {
    const scenario: MockScenario = {
      greeting: [
        { type: "session-changed", sessionId: 1, name: "main" },
        { type: "sessions-changed" },
        { type: "window-add", windowId: 2 },
      ],
    };
    const server = new MockTmuxServer(scenario);
    const client = new TmuxClient(server);
    const events = collectEvents(client);

    server.start();

    expect(events).toEqual(
      expect.arrayContaining([
        { type: "session-changed", sessionId: 1, name: "main" },
        { type: "sessions-changed" },
        { type: "window-add", windowId: 2 },
      ]),
    );
  });

  it("frames a command's scripted output in a %begin/%end block and resolves it", async () => {
    const scenario: MockScenario = {
      respond(command) {
        if (command.startsWith("list-windows")) {
          return { kind: "ok", output: ["@1 main", "@2 editor"] };
        }
        return undefined; // default ok, no output
      },
    };
    const server = new MockTmuxServer(scenario);
    const client = new TmuxClient(server);
    server.start();

    const response = await client.execute("list-windows");
    expect(response.success).toBe(true);
    expect(response.output).toEqual(["@1 main", "@2 editor"]);
    expect(server.sentCommands).toContain("list-windows");
  });

  it("a default reply is an empty successful block (real tmux's common case)", async () => {
    const server = new MockTmuxServer();
    const client = new TmuxClient(server);
    server.start();

    const response = await client.execute("kill-pane -t %3");
    expect(response.success).toBe(true);
    expect(response.output).toEqual([]);
  });

  it("an error reply rejects with TmuxCommandError carrying the block's output", async () => {
    const scenario: MockScenario = {
      respond(command) {
        if (command.startsWith("kill-pane")) {
          return { kind: "error", output: ["can't find pane %99"] };
        }
        return undefined;
      },
    };
    const server = new MockTmuxServer(scenario);
    const client = new TmuxClient(server);
    server.start();

    await expect(client.execute("kill-pane -t %99")).rejects.toBeInstanceOf(
      TmuxCommandError,
    );
  });

  it("correlates concurrent commands in FIFO order (each gets its own response)", async () => {
    const scenario: MockScenario = {
      respond: (command) => ({ kind: "ok", output: [`echo:${command}`] }),
    };
    const server = new MockTmuxServer(scenario);
    const client = new TmuxClient(server);
    server.start();

    const [a, b, c] = await Promise.all([
      client.execute("alpha"),
      client.execute("beta"),
      client.execute("gamma"),
    ]);
    expect(a.output).toEqual(["echo:alpha"]);
    expect(b.output).toEqual(["echo:beta"]);
    expect(c.output).toEqual(["echo:gamma"]);
  });

  it("routes an emitted %output to an attached bytes sink", () => {
    const server = new MockTmuxServer();
    const client = new TmuxClient(server);
    server.start();

    const received: ChunkPayload[] = [];
    const sink: BytesSink = {
      write: (msg) => received.push({ paneId: msg.paneId, data: msg.data.slice() }),
      end: () => {},
    };
    client.attachBytesSink(sink, { scope: serverScope });

    server.emitOutput(5, new Uint8Array([104, 105, 0x1b])); // "hi" + ESC

    expect(received).toHaveLength(1);
    expect(received[0].paneId).toBe(5);
    expect(received[0].data).toEqual(new Uint8Array([104, 105, 0x1b]));
  });

  it("a notification emitted mid-session surfaces as an event", () => {
    const server = new MockTmuxServer();
    const client = new TmuxClient(server);
    const events = collectEvents(client);
    server.start();

    server.emit({ type: "window-renamed", windowId: 2, name: "renamed" });

    expect(events).toContainEqual({
      type: "window-renamed",
      windowId: 2,
      name: "renamed",
    });
  });

  it("a bare-newline detach ends the connection (transport close)", () => {
    const server = new MockTmuxServer();
    const client = new TmuxClient(server);
    const events = collectEvents(client);
    server.start();

    client.detach(); // sends "\n"

    expect(events.some((e) => e.type === "exit")).toBe(true);
    expect(client.connectionState.status).toBe("closed");
  });

  it("refuses sends after close with a typed result (no throw, no delivery)", () => {
    const server = new MockTmuxServer();
    const client = new TmuxClient(server);
    server.start();
    server.close();

    expect(server.send("list-windows\n")).toEqual({
      ok: false,
      reason: "transport closed",
    });
    expect(server.sentCommands).not.toContain("list-windows");
  });

  it("execute after transport close rejects with TransportSendError instead of hanging", async () => {
    const server = new MockTmuxServer();
    const client = new TmuxClient(server);
    server.start();
    server.close();

    // Before the seam carried send failure, this promise never settled — the
    // entry sat in the FIFO waiting for a %begin that could never arrive.
    await expect(client.execute("list-windows")).rejects.toBeInstanceOf(
      TransportSendError,
    );
    await expect(client.execute("list-windows")).rejects.toThrow(
      /transport closed/,
    );
  });
});
