// tests/integration/connection-state.test.ts
// End-to-end ConnectionState lifecycle against a real tmux server.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TmuxClient } from "../../src/client.js";
import type { ConnectionState } from "../../src/connection-state.js";
import { spawnTmux } from "../../src/transport/spawn.js";
import { killTmuxServer } from "../helpers/reap-test-sockets.js";
import {
  uniqueSocket,
  uniqueName,
  waitForEvent,
  waitReady,
  tmux,
} from "../helpers/integration.js";

const RUN_INTEGRATION = process.env.TMUX_INTEGRATION === "1";

describe.skipIf(!RUN_INTEGRATION)(
  "TmuxClient — ConnectionState against real tmux",
  () => {
    let socketName: string;
    let client: TmuxClient | null;

    beforeEach(() => {
      socketName = uniqueSocket("tmux-js-test-", "connstate");
      client = null;
    });

    afterEach(() => {
      try {
        client?.close();
      } catch {
        // ignore — we may have already closed during the test
      }
      killTmuxServer(socketName);
    });

    it("transitions connecting → ready once the startup greeting is consumed, then closed{exit} once the server's last session is killed", async () => {
      const sessionName = uniqueName("connstate");
      tmux(socketName, ["new-session", "-d", "-s", sessionName]);
      const transport = spawnTmux(["attach-session", "-t", sessionName], {
        socketPath: socketName,
      });
      client = new TmuxClient(transport);

      // The constructor runs synchronously; before tmux speaks we're connecting.
      expect(client.connectionState).toEqual({ status: "connecting" });

      const seen: ConnectionState[] = [];
      client.on("connection-state", (ev) => seen.push(ev.state));

      // Wait for the client to consume tmux's unsolicited startup
      // %begin/%end greeting (see the TmuxClient constructor) — that is
      // what "ready" now means, not merely "first byte received".
      await waitReady(client);
      expect(client.connectionState).toEqual({ status: "ready" });

      // Kill the only session on the isolated socket; tmux's exit-empty
      // default then kills the server out from under the client;
      // observe `closed{exit}`.
      const closed = waitForEvent(
        client,
        "connection-state",
        (e) => e.state.status === "closed",
      );
      killTmuxServer(socketName);
      const { state: finalState } = await closed;
      expect(finalState.status).toBe("closed");
      // tmux exits cleanly once its last session is killed: reason is
      // 'exit'. (Some tmux builds may report a SIGTERM-driven
      // 'transport-error' instead — both
      // are valid "tmux is gone" signals; assert the inclusive set.)
      expect(["exit", "transport-error"]).toContain(
        finalState.status === "closed" ? finalState.reason : "",
      );
    }, 15000);
  },
);
