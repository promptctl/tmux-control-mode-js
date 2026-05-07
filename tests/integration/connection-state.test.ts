// tests/integration/connection-state.test.ts
// End-to-end ConnectionState lifecycle against a real tmux server.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";

import { TmuxClient } from "../../src/client.js";
import type { ConnectionState } from "../../src/connection-state.js";
import { spawnTmux } from "../../src/transport/spawn.js";

const RUN_INTEGRATION = process.env.TMUX_INTEGRATION === "1";

function uniqueSocket(prefix: string): string {
  return `tmux-js-test-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function uniqueSession(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function tmuxCmd(socketName: string, args: string): string {
  return `tmux -L ${socketName} ${args}`;
}

function killServer(socketName: string): void {
  try {
    execSync(tmuxCmd(socketName, "kill-server"), { stdio: "ignore" });
  } catch {
    // already gone
  }
}

describe.skipIf(!RUN_INTEGRATION)(
  "TmuxClient — ConnectionState against real tmux",
  () => {
    let socketName: string;
    let client: TmuxClient | null;

    beforeEach(() => {
      socketName = uniqueSocket("connstate");
      client = null;
    });

    afterEach(() => {
      try {
        client?.close();
      } catch {
        // ignore — we may have already closed during the test
      }
      killServer(socketName);
    });

    it(
      "transitions connecting → ready on first byte, then closed{exit} on kill-server",
      async () => {
        const sessionName = uniqueSession("connstate");
        execSync(
          tmuxCmd(socketName, `new-session -d -s ${sessionName}`),
          { stdio: "ignore" },
        );
        const transport = spawnTmux(["attach-session", "-t", sessionName], {
          socketPath: socketName,
        });
        client = new TmuxClient(transport);

        // The constructor runs synchronously; before tmux speaks we're connecting.
        expect(client.connectionState).toEqual({ status: "connecting" });

        const seen: ConnectionState[] = [];
        client.on("connection-state", (ev) => seen.push(ev.state));

        // Wait for tmux's handshake byte.
        await new Promise<void>((resolve) => {
          const onState = (ev: { state: ConnectionState }) => {
            if (ev.state.status === "ready") {
              client?.off("connection-state", onState);
              resolve();
            }
          };
          client.on("connection-state", onState);
        });
        expect(client.connectionState).toEqual({ status: "ready" });

        // Kill the server out from under the client; observe `closed{exit}`.
        const closed = new Promise<ConnectionState>((resolve) => {
          const onState = (ev: { state: ConnectionState }) => {
            if (ev.state.status === "closed") {
              client?.off("connection-state", onState);
              resolve(ev.state);
            }
          };
          client?.on("connection-state", onState);
        });
        killServer(socketName);
        const finalState = await closed;
        expect(finalState.status).toBe("closed");
        // tmux exits cleanly on kill-server: reason is 'exit'. (Some tmux
        // builds may report a SIGTERM-driven 'transport-error' instead — both
        // are valid "tmux is gone" signals; assert the inclusive set.)
        expect(["exit", "transport-error"]).toContain(
          finalState.status === "closed" ? finalState.reason : "",
        );
      },
      15000,
    );
  },
);
