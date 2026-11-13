// tests/integration/startup-failure.test.ts
// Real-tmux integration tests for what a caller learns when the command tmux
// was started with fails (tmux-server-events-6sp.sik). The third form — tmux
// never reaches a server and says why on stderr — is in watch-server.test.ts
// ("starts no server").
//
// [LAW:verifiable-goals] Gated behind TMUX_INTEGRATION=1, same convention as
// tests/integration/client.test.ts.

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { spawnTmux } from "../../src/transport/spawn.js";
import { killTmuxServer } from "../helpers/reap-test-sockets.js";
import {
  uniqueSocket,
  waitForEvent,
  waitReady,
  pollUntil,
  tmux,
} from "../helpers/integration.js";
import { TmuxClient } from "../../src/client.js";
import { TmuxCommandError, TransportClosedError } from "../../src/errors.js";

const RUN_INTEGRATION = process.env.TMUX_INTEGRATION === "1";

describe.skipIf(!RUN_INTEGRATION)(
  "a failed startup command (real tmux)",
  { timeout: 15000 },
  () => {
    let socketName: string;
    let client: TmuxClient | undefined;

    // What a consumer does: connect, send its command at once, and show the
    // rejection's reason when the attach turns out to have failed.
    const connect = (args: string[]) => {
      const transport = spawnTmux(["-f", "/dev/null", ...args], {
        socketPath: socketName,
      });
      client = new TmuxClient(transport);
      return {
        client,
        transport,
        exit: waitForEvent(client, "exit"),
        command: client.execute("list-sessions"),
      };
    };

    beforeEach(() => {
      socketName = uniqueSocket("tmux-js-test-", "startfail");
      client = undefined;
      tmux(socketName, ["new-session", "-d", "-s", "a"]);
    });

    afterEach(() => {
      client?.close();
      killTmuxServer(socketName);
    });

    it("that tmux ran and refused: its error text is the exit reason and the pending command's rejection", async () => {
      const { exit, command } = connect(["attach-session", "-t", "=nope"]);

      await expect(command).rejects.toBeInstanceOf(TransportClosedError);
      await expect(command).rejects.toMatchObject({
        reason: "can't find session: nope",
      });
      expect((await exit).reason).toBe("can't find session: nope");
    });

    it("that tmux could not parse: the line it wrote instead of a reply is the reason, and the client is never ready", async () => {
      const { client, exit, command } = connect(["attach-session", "-Z"]);
      const states: string[] = [];
      client.on("connection-state", (ev) => states.push(ev.state.status));

      // tmux's wording differs by version; every one names the command.
      const { reason } = await exit;
      expect(reason).toMatch(/attach-session/);
      await expect(command).rejects.toBeInstanceOf(TransportClosedError);
      await expect(command).rejects.toMatchObject({ reason });
      await pollUntil(() => client.connectionState.status === "closed");
      expect(states).toEqual(["closed"]);
    });

    it("a connection that worked ends with no reason, whatever a command or run-shell printed along the way", async () => {
      const { client, transport, exit, command } = connect([
        "attach-session",
        "-t",
        "=a",
      ]);
      let wire = "";
      transport.onData((chunk) => (wire += chunk));
      await waitReady(client);
      await command;

      // A command's own %error makes the tmux client process exit 1 later.
      await expect(
        client.execute("kill-session -t =nope"),
      ).rejects.toBeInstanceOf(TmuxCommandError);
      // run-shell's output arrives as a line outside any guard block.
      await client.execute('run-shell "echo unguarded-marker"');
      await pollUntil(() => wire.includes("\nunguarded-marker\n"));

      client.detach();
      const unanswered = client.execute("list-sessions");

      expect((await exit).reason).toBeUndefined();
      await expect(unanswered).rejects.toBeInstanceOf(TransportClosedError);
      await expect(unanswered).rejects.toMatchObject({ reason: undefined });
    });
  },
);
