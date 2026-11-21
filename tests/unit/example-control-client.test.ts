// tests/unit/example-control-client.test.ts
//
// A tmux client the demo server spawns can end before anyone could listen:
// a transport that fails at once closes it inside its constructor. Such a
// client is refused at once, never waited on, and its owner spawns afresh.

import { afterEach, describe, expect, it, vi } from "vitest";
import { MockTmuxServer } from "../../src/mock/index.js";
// The demo resolves the package to dist/, so its clients come from there too.
import {
  TmuxClient,
  TransportClosedError,
} from "@promptctl/tmux-control-mode-js";
import {
  DedicatedControlClient,
  whenReady,
} from "../../examples/web-multiplexer/server/control-client.js";

/** A client whose transport closed before tmux answered its startup. */
function deadClient(): TmuxClient {
  const server = new MockTmuxServer();
  const client = new TmuxClient(server);
  server.close();
  return client;
}

function liveClient(): TmuxClient {
  const server = new MockTmuxServer();
  const client = new TmuxClient(server);
  server.start();
  return client;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("whenReady", () => {
  it("refuses a client that closed before it was handed over", async () => {
    await expect(whenReady(deadClient())).rejects.toBeInstanceOf(
      TransportClosedError,
    );
  });

  it("hands over a client that is already ready", async () => {
    const client = liveClient();
    await expect(whenReady(client)).resolves.toBe(client);
    client.close();
  });
});

describe("DedicatedControlClient", () => {
  it("drops a client that closed at spawn, and spawns a fresh one after the respawn delay", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const spawns: TmuxClient[] = [];
    const owner = new DedicatedControlClient(
      "[test]",
      () => undefined,
      () => {
        const client = spawns.length === 0 ? deadClient() : liveClient();
        spawns.push(client);
        return client;
      },
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await expect(owner.ready()).rejects.toBeInstanceOf(TransportClosedError);
      // Within the delay, the ended connection answers without a spawn.
      await expect(owner.ready()).rejects.toBeInstanceOf(TransportClosedError);
      expect(spawns).toHaveLength(1);

      vi.advanceTimersByTime(1000);
      await expect(owner.ready()).resolves.toBe(spawns[1]);
      expect(spawns).toHaveLength(2);
    } finally {
      warn.mockRestore();
      owner.close();
    }
  });
});
