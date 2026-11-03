// tests/integration/watch-server.test.ts
// Real-tmux integration tests for watching a server without disturbing it
// (tmux-server-events-6sp.s3u).
//
// [LAW:verifiable-goals] Gated behind TMUX_INTEGRATION=1, same convention as
// tests/integration/client.test.ts.

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { execSync } from "node:child_process";
import { spawnTmux } from "../../src/transport/spawn.js";
import { killTmuxServer } from "../helpers/reap-test-sockets.js";
import { TmuxClient } from "../../src/client.js";
import type { TmuxEventMap } from "../../src/emitter.js";
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

function uniqueSocket(prefix: string): string {
  // [LAW:one-source-of-truth] "tmux-js-test-" is registered in
  // tests/helpers/reap-test-sockets.ts's TEST_SOCKET_PREFIXES.
  return `tmux-js-test-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function tmux(socketName: string, args: string): string {
  // -f /dev/null: the developer's tmux.conf must not shape the test server.
  return execSync(`tmux -f /dev/null -L ${socketName} ${args}`, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function waitFor<K extends keyof TmuxEventMap, T>(
  client: TmuxClient,
  event: K,
  pick: (e: TmuxEventMap[K]) => T | undefined,
  ms = 12000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const h = (e: TmuxEventMap[K]) => {
      const v = pick(e);
      if (v === undefined) return;
      clearTimeout(timer);
      client.off(event, h);
      resolve(v);
    };
    const timer = setTimeout(() => {
      client.off(event, h);
      reject(new Error(`no matching ${event} within ${ms}ms`));
    }, ms);
    client.on(event, h);
  });
}

const closed = (client: TmuxClient) =>
  waitFor(client, "connection-state", (e) =>
    e.state.status === "closed" ? e.state : undefined,
  );

describe.skipIf(!RUN_INTEGRATION)("watchServerArgs (real tmux)", () => {
  let socketName: string;
  let watcher: TmuxClient;

  beforeEach(async () => {
    socketName = uniqueSocket("watch");
    tmux(socketName, "new-session -d -s a -x 120 -y 40");
    tmux(socketName, "new-session -d -s b -x 120 -y 40");
    watcher = new TmuxClient(
      spawnTmux(watchServerArgs("a"), { socketPath: socketName }),
      { idlePaneSuppression: true },
    );
    await waitFor(watcher, "connection-state", (e) =>
      e.state.status === "ready" ? true : undefined,
    );
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
      const rows = tmux(
        socketName,
        "list-clients -F '#{client_name} #{client_pid}'",
      );
      expect(rows.split("\n")).toContain(`${own.name} ${own.pid}`);
    },
  );

  it("does not resize the user's client's windows, even when it sets a size of its own", async () => {
    // The user's client: a second control client that takes part in sizing by
    // setting a size (spawnTmux always adds -C, so it is not a terminal). Under
    // window-size smallest, any client that takes part in sizing would shrink
    // it to the watcher's 50x20 — that is what ignore-size must prevent.
    tmux(socketName, "set -g window-size smallest");
    const user = new TmuxClient(
      spawnTmux(["attach-session", "-t", "a"], { socketPath: socketName }),
    );
    try {
      await waitFor(user, "connection-state", (e) =>
        e.state.status === "ready" ? true : undefined,
      );
      await setSize(user, 120, 40);
      await setSize(watcher, 50, 20);
      await getOwnClient(watcher);
      expect(
        tmux(socketName, "display -p -t a '#{window_width}x#{window_height}'"),
      ).toBe("120x40");
    } finally {
      user.close();
    }
  });

  it.skipIf(!TMUX_SUPPORTS_NO_DETACH_ON_DESTROY)(
    "outlives its attached session by moving to another one",
    async () => {
      const moved = waitFor(watcher, "session-changed", (e) =>
        e.name === "b" ? e.name : undefined,
      );
      tmux(socketName, "kill-session -t a");
      expect(await moved).toBe("b");
      const own = await getOwnClient(watcher);
      const rows = tmux(
        socketName,
        "list-clients -F '#{client_name} #{session_name}'",
      );
      expect(rows.split("\n")).toContain(`${own.name} b`);
    },
  );

  it("ends, and reports it, when the last session closes — the server does not stay up", async () => {
    const exit = waitFor(watcher, "exit", () => true);
    const state = closed(watcher);
    tmux(socketName, "kill-session -t a");
    tmux(socketName, "kill-session -t b");
    await exit;
    expect((await state).status).toBe("closed");
    expect(() => tmux(socketName, "list-sessions")).toThrow();
  });

  it("ends, and reports it, when another client detaches it", async () => {
    const own = await getOwnClient(watcher);
    const exit = waitFor(watcher, "exit", () => true);
    const state = closed(watcher);
    tmux(socketName, `detach-client -t ${own.name}`);
    await exit;
    expect((await state).status).toBe("closed");
  });
});
