// tests/integration/ensure-session.test.ts
// Drives a real tmux server through TmuxClient + ensureSession to assert
// both branches of the helper:
//   - create branch: ensureSession on an absent name reports created=true
//   - attach branch: ensureSession on a pre-existing name reports created=false
// Both branches must surface a real `session_id` from tmux (the helper
// never assumes the requested name maps to the id verbatim).

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { execSync } from "node:child_process";

import { spawnTmux } from "../../src/transport/spawn.js";
import { TmuxClient } from "../../src/client.js";
import { ensureSession } from "../../src/ensure-session.js";

const RUN_INTEGRATION = process.env.TMUX_INTEGRATION === "1";

function uniqueSocket(prefix: string): string {
  return `tmux-js-test-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}
function uniqueSession(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}
function killServer(socketName: string): void {
  try {
    execSync(`tmux -L ${socketName} kill-server`, { stdio: "ignore" });
  } catch {
    // already gone
  }
}

// Bootstrap a control-mode client by attaching to a known session. The
// test server has a `bootstrap` session created in beforeEach.
function attachClient(socketName: string): Promise<TmuxClient> {
  const transport = spawnTmux(["attach-session", "-t", "bootstrap"], {
    socketPath: socketName,
  });
  const client = new TmuxClient(transport);
  return new Promise((resolve) => {
    const handler = (): void => {
      client.off("session-changed", handler);
      resolve(client);
    };
    client.on("session-changed", handler);
  });
}

describe.skipIf(!RUN_INTEGRATION)("ensureSession integration", () => {
  let socketName: string;
  let client: TmuxClient | null = null;

  beforeEach(() => {
    socketName = uniqueSocket("ensure");
    execSync(`tmux -L ${socketName} new-session -d -s bootstrap`, {
      stdio: "ignore",
    });
  });

  afterEach(() => {
    client?.close();
    client = null;
    killServer(socketName);
  });

  it("create branch: absent session is created and reported as created=true", async () => {
    client = await attachClient(socketName);
    const target = uniqueSession("created");

    const result = await ensureSession(client, { name: target });

    expect(result.created).toBe(true);
    expect(result.sessionId).toMatch(/^\$\d+$/);

    // Session is real on the server.
    const verify = execSync(
      `tmux -L ${socketName} has-session -t ${target} && echo OK`,
      { encoding: "utf8" },
    );
    expect(verify.trim()).toBe("OK");
  });

  it("attach branch: pre-existing session is reported as created=false", async () => {
    const target = uniqueSession("preexist");
    execSync(`tmux -L ${socketName} new-session -d -s ${target}`, {
      stdio: "ignore",
    });
    // Capture the canonical session_id tmux assigned, so we can compare.
    const expectedId = execSync(
      `tmux -L ${socketName} display-message -p -t ${target} '#{session_id}'`,
      { encoding: "utf8" },
    ).trim();

    client = await attachClient(socketName);

    const result = await ensureSession(client, { name: target });

    expect(result.created).toBe(false);
    expect(result.sessionId).toBe(expectedId);
  });

  it("idempotent on repeat calls: second call sees created=false", async () => {
    client = await attachClient(socketName);
    const target = uniqueSession("repeat");

    const first = await ensureSession(client, { name: target });
    const second = await ensureSession(client, { name: target });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.sessionId).toBe(first.sessionId);
  });

});
