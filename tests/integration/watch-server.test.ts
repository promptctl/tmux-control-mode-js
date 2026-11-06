// tests/integration/watch-server.test.ts
// Real-tmux integration tests for watching a server without disturbing it
// (tmux-server-events-6sp.s3u).
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
  withSecondClient,
  tmux,
} from "../helpers/integration.js";
import { TmuxClient } from "../../src/client.js";
import { getOwnClient, setSize } from "../../src/commands/index.js";
import { watchServerArgs } from "../../src/watch-server.js";
import {
  NO_DETACH_ON_DESTROY_MIN_VERSION,
  meetsTmuxVersion,
} from "../../src/tmux-compat.js";
import { runningTmuxVersion } from "../helpers/running-tmux.js";

const RUN_INTEGRATION = process.env.TMUX_INTEGRATION === "1";

// Tests that rely on no-detach-on-destroy skip on tmux that ignores it.
const TMUX_SUPPORTS_NO_DETACH_ON_DESTROY = (() => {
  if (!RUN_INTEGRATION) return false;
  return meetsTmuxVersion(
    runningTmuxVersion(),
    NO_DETACH_ON_DESTROY_MIN_VERSION,
  );
})();

const closed = (client: TmuxClient) =>
  waitForEvent(client, "connection-state", (e) => e.state.status === "closed");

// Above the shared waiters' 12s default, so their named rejection — not
// vitest's 5s default — is what a hang reports.
describe.skipIf(!RUN_INTEGRATION)(
  "watchServerArgs (real tmux)",
  { timeout: 15000 },
  () => {
    let socketName: string;
    let watcher: TmuxClient;

    beforeEach(async () => {
      socketName = uniqueSocket("tmux-js-test-", "watch");
      for (const s of ["a", "b"]) {
        tmux(socketName, [
          "new-session",
          "-d",
          "-s",
          s,
          "-x",
          "120",
          "-y",
          "40",
        ]);
      }
      watcher = new TmuxClient(
        spawnTmux(watchServerArgs("a"), { socketPath: socketName }),
        { idlePaneSuppression: true },
      );
      await waitReady(watcher);
    });

    afterEach(() => {
      watcher.close();
      killTmuxServer(socketName);
    });

    it.skipIf(!TMUX_SUPPORTS_NO_DETACH_ON_DESTROY)(
      "identifies itself, with the preset's flags in effect",
      async () => {
        const own = await getOwnClient(watcher);
        expect(own.flags).toEqual(
          expect.arrayContaining([
            "control-mode",
            "ignore-size",
            "no-detach-on-destroy",
          ]),
        );
        const rows = tmux(socketName, [
          "list-clients",
          "-F",
          "#{client_name} #{client_pid}",
        ]);
        expect(rows.split("\n")).toContain(`${own.name} ${own.pid}`);
      },
    );

    it("does not resize the user's client's windows, even when it sets a size of its own", async () => {
      // The user's client: a second control client that takes part in sizing by
      // setting a size (spawnTmux always adds -C, so it is not a terminal). Under
      // window-size smallest, any client that takes part in sizing would shrink
      // it to the watcher's 50x20 — that is what ignore-size must prevent.
      tmux(socketName, ["set", "-g", "window-size", "smallest"]);
      await withSecondClient(socketName, "a", async (user) => {
        await setSize(user, 120, 40);
        await setSize(watcher, 50, 20);
        await getOwnClient(watcher);
        expect(
          tmux(socketName, [
            "display",
            "-p",
            "-t",
            "a",
            "#{window_width}x#{window_height}",
          ]),
        ).toBe("120x40");
      });
    });

    it.skipIf(!TMUX_SUPPORTS_NO_DETACH_ON_DESTROY)(
      "outlives its attached session by moving to another one",
      async () => {
        const moved = waitForEvent(
          watcher,
          "session-changed",
          (e) => e.name === "b",
        );
        tmux(socketName, ["kill-session", "-t", "a"]);
        expect((await moved).name).toBe("b");
        const own = await getOwnClient(watcher);
        const rows = tmux(socketName, [
          "list-clients",
          "-F",
          "#{client_name} #{session_name}",
        ]);
        expect(rows.split("\n")).toContain(`${own.name} b`);
      },
    );

    it("ends, and reports it, when the last session closes — the server does not stay up", async () => {
      const exit = waitForEvent(watcher, "exit");
      const state = closed(watcher);
      tmux(socketName, ["kill-session", "-t", "a"]);
      tmux(socketName, ["kill-session", "-t", "b"]);
      await exit;
      expect((await state).state.status).toBe("closed");
      expect(() => tmux(socketName, ["list-sessions"])).toThrow();
    });

    it("ends, and reports it, when another client detaches it", async () => {
      const own = await getOwnClient(watcher);
      const exit = waitForEvent(watcher, "exit");
      const state = closed(watcher);
      tmux(socketName, ["detach-client", "-t", own.name]);
      await exit;
      expect((await state).state.status).toBe("closed");
    });
  },
);
