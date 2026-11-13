// tests/integration/unsolicited-response.test.ts
// Real-tmux integration tests for the replies tmux writes to commands no
// caller wrote (tmux-server-events-6sp.lgu): each command of the command line
// it was started with, and each after-hook. Every execute() still gets its own
// reply, and those replies arrive as `unsolicited-response` events.
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
  tmux,
} from "../helpers/integration.js";
import { TmuxClient } from "../../src/client.js";
import type { CommandResponse } from "../../src/protocol/types.js";

const RUN_INTEGRATION = process.env.TMUX_INTEGRATION === "1";

describe.skipIf(!RUN_INTEGRATION)(
  "replies to commands no caller wrote (real tmux)",
  { timeout: 15000 },
  () => {
    let socketName: string;
    let client: TmuxClient | undefined;

    const connect = (args: string[]) => {
      const connected = new TmuxClient(
        spawnTmux(["-f", "/dev/null", ...args], { socketPath: socketName }),
      );
      client = connected;
      const unsolicited: CommandResponse[] = [];
      connected.on("unsolicited-response", (ev) =>
        unsolicited.push(ev.response),
      );
      return { client: connected, unsolicited };
    };

    beforeEach(() => {
      socketName = uniqueSocket("tmux-js-test-", "unsolicited");
      client = undefined;
      tmux(socketName, ["new-session", "-d", "-s", "a"]);
    });

    afterEach(() => {
      client?.close();
      killTmuxServer(socketName);
    });

    it("a startup list whose second command fails: each caller gets its own reply, and the failure is an event, not why the connection ends", async () => {
      const { client, unsolicited } = connect([
        "attach-session",
        "-t",
        "=a",
        ";",
        "kill-session",
        "-t",
        "=nope",
      ]);
      const exit = waitForEvent(client, "exit");

      const [first, second] = await Promise.all([
        client.execute("display-message -p first"),
        client.execute("display-message -p second"),
      ]);

      expect(first.output).toEqual(["first"]);
      expect(second.output).toEqual(["second"]);
      expect(
        unsolicited.map(({ success, output }) => ({ success, output })),
      ).toEqual([
        { success: true, output: [] },
        { success: false, output: ["can't find session: nope"] },
      ]);

      client.detach();
      expect((await exit).reason).toBeUndefined();
    });

    it("an after-hook that prints: the command that set it off and the next one each get their own reply", async () => {
      tmux(socketName, [
        "set-hook",
        "-g",
        "after-rename-window",
        "display-message -p hook-ran",
      ]);
      const { client, unsolicited } = connect(["attach-session", "-t", "=a"]);
      await waitReady(client);
      unsolicited.length = 0;

      const [rename, next] = await Promise.all([
        client.execute("rename-window renamed"),
        client.execute("display-message -p next"),
      ]);

      expect(rename.output).toEqual([]);
      expect(next.output).toEqual(["next"]);
      expect(
        unsolicited.map(({ success, output }) => ({ success, output })),
      ).toEqual([{ success: true, output: ["hook-ran"] }]);
    });

    it("the startup command's own output is in its event", async () => {
      const { client } = connect(["list-sessions"]);

      const { response } = await waitForEvent(client, "unsolicited-response");

      expect(response.success).toBe(true);
      expect(response.output).toHaveLength(1);
      expect(response.output[0]).toMatch(/^a: 1 windows/);
    });
  },
);
