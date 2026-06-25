// tests/integration/conformance.test.ts
// The LIVE column of the conformance dashboard: the same catalogue that runs
// deterministically against a MockTmuxServer (src/conformance) is here held
// against a REAL tmux. The deterministic suite certifies the client surfaces an
// exact wire line; this certifies that real tmux actually PRODUCES messages of
// the catalogue's shape and the client surfaces them — so the two columns cannot
// silently disagree about what a notification looks like.
//
// [LAW:one-source-of-truth] Shape expectations come from MESSAGE_SAMPLES (the
// catalogue), not a second hand-written list — a sample whose field set drifts
// from real tmux fails here. [LAW:verifiable-goals] Gated behind TMUX_INTEGRATION
// like the rest of the integration suite; skipped, not failed, without tmux.

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { execSync } from "node:child_process";
import { spawnTmux } from "../../src/transport/spawn.js";
import { TmuxClient } from "../../src/client.js";
import { TmuxCommandError } from "../../src/errors.js";
import { MESSAGE_SAMPLES } from "../../src/conformance/samples.js";
import type { TmuxMessage } from "../../src/protocol/types.js";
import type { TmuxEventMap } from "../../src/emitter.js";

const RUN_INTEGRATION = process.env.TMUX_INTEGRATION === "1";

// [LAW:single-enforcer] The only place this file builds a `tmux -L <socket>`
// line, mirroring client.test.ts's isolation discipline: each test gets its own
// server so nothing reaches the developer's tmux.
function uniqueSocket(prefix: string): string {
  return `tmux-js-conf-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
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
    // Already gone — not an error.
  }
}

function createSession(
  socketName: string,
  sessionName: string,
): Promise<TmuxClient> {
  execSync(tmuxCmd(socketName, `new-session -d -s ${sessionName}`), {
    stdio: "ignore",
  });
  const transport = spawnTmux(["attach-session", "-t", sessionName], {
    socketPath: socketName,
  });
  const client = new TmuxClient(transport);
  // Wait for the post-attach handshake (see client.test.ts) before resolving.
  return new Promise<TmuxClient>((resolve) => {
    const handler = () => {
      client.off("session-changed", handler);
      resolve(client);
    };
    client.on("session-changed", handler);
  });
}

function nextMessage<K extends keyof TmuxEventMap>(
  client: TmuxClient,
  type: K,
): Promise<TmuxEventMap[K]> {
  return new Promise((resolve) => {
    const handler = (ev: TmuxEventMap[K]) => {
      client.off(type, handler);
      resolve(ev);
    };
    client.on(type, handler);
  });
}

// The catalogue's field set for a variant — the shape real tmux must reproduce.
function sampleKeys(type: TmuxMessage["type"]): string[] {
  return Object.keys(MESSAGE_SAMPLES[type]).sort();
}

describe.skipIf(!RUN_INTEGRATION)("conformance — live tmux column", () => {
  let socketName = "";
  let client: TmuxClient | null = null;

  beforeEach(() => {
    socketName = uniqueSocket("live");
  });
  afterEach(() => {
    client?.close();
    client = null;
    if (socketName !== "") killServer(socketName);
    socketName = "";
  });

  // A causable notification subset: each is triggered by one reliable command
  // and is non-flaky (proven by client.test.ts's Notification coverage block).
  // The check is SHAPE conformance against the catalogue — field set + the
  // discriminant — since real ids/names differ from the sample's literals.
  const CAUSABLE: ReadonlyArray<{
    readonly type: keyof TmuxEventMap & TmuxMessage["type"];
    readonly cause: string;
  }> = [
    { type: "window-add", cause: "new-window" },
    { type: "window-renamed", cause: "rename-window conformance-target" },
    { type: "layout-change", cause: "split-window -h" },
  ];

  for (const { type, cause } of CAUSABLE) {
    it(
      `live %${type} surfaces with the catalogue's field shape`,
      async () => {
        const c = await createSession(socketName, uniqueSession(`conf-${type}`));
        client = c;
        const evt = nextMessage(c, type);
        await c.execute(cause);
        const ev = await evt;
        expect(ev.type).toBe(type);
        expect(Object.keys(ev).sort()).toEqual(sampleKeys(type));
      },
      15000,
    );
  }

  it(
    "live command-correlation contract: resolve on success, reject on error",
    async () => {
      const c = await createSession(socketName, uniqueSession("conf-cmd"));
      client = c;

      // %begin/%end → resolve with success.
      const ok = await c.execute("list-sessions");
      expect(ok.success).toBe(true);

      // %begin/%error → reject with a TmuxCommandError carrying success=false.
      await expect(c.execute("definitely-not-a-command")).rejects.toBeInstanceOf(
        TmuxCommandError,
      );
    },
    15000,
  );
});
