// tests/integration/client.test.ts
// Integration tests for TmuxClient against a real tmux process.
//
// [LAW:verifiable-goals] Tests are gated behind TMUX_INTEGRATION=1 so CI does
// not fail when tmux is unavailable, but can be run explicitly to verify
// real-world behaviour against an actual tmux binary.

import { describe, it, afterEach, expect } from "vitest";
import { execSync } from "node:child_process";
import { spawnTmux } from "../../src/transport/spawn.js";
import { TmuxClient } from "../../src/client.js";
import type { CommandResponse } from "../../src/protocol/types.js";

// [LAW:verifiable-goals] Gate every test behind the env var so the suite is
// opt-in only; skipping rather than failing keeps the default test run green
// regardless of whether tmux is installed in the environment.
const RUN_INTEGRATION = process.env.TMUX_INTEGRATION === "1";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a session name that is unique per test invocation. */
function uniqueSession(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Kill a tmux session by name, ignoring errors (best-effort cleanup).
 * Safety-net used in afterEach hooks so sessions don't leak between runs.
 */
function killSession(name: string): void {
  try {
    execSync(`tmux kill-session -t ${name}`, { stdio: "ignore" });
  } catch {
    // Session may already be gone — not an error.
  }
}

/**
 * Create a detached tmux session and return a ready TmuxClient.
 *
 * Protocol detail: `attach-session` in control mode sends a startup
 * %begin/%end pair before any user commands. If execute() is called before
 * that pair is consumed, the startup pair steals the first pending entry and
 * the real response is dropped. We wait for "session-changed" — which tmux
 * emits immediately after the startup pair — before resolving, ensuring
 * the handshake is complete and the FIFO queue is empty.
 *
 * [LAW:dataflow-not-control-flow] Session creation and transport construction
 * always run unconditionally; variability lives in sessionName only.
 */
function createSession(sessionName: string): Promise<TmuxClient> {
  execSync(`tmux new-session -d -s ${sessionName}`, { stdio: "ignore" });
  const transport = spawnTmux(["attach-session", "-t", sessionName]);
  const client = new TmuxClient(transport);

  return new Promise<TmuxClient>((resolve) => {
    const handler = () => {
      client.off("session-changed", handler);
      resolve(client);
    };
    client.on("session-changed", handler);
  });
}

// ---------------------------------------------------------------------------
// 1. Command Correlation
// ---------------------------------------------------------------------------

describe.skipIf(!RUN_INTEGRATION)("Command Correlation", () => {
  let sessionName: string;
  let client: TmuxClient;

  afterEach(() => {
    client?.close();
    killSession(sessionName);
  });

  it(
    "execute(list-windows) resolves success with output",
    async () => {
      sessionName = uniqueSession("test-corr");
      client = await createSession(sessionName);

      const response: CommandResponse = await client.execute("list-windows");

      expect(response.success).toBe(true);
      expect(typeof response.commandNumber).toBe("number");
      expect(typeof response.timestamp).toBe("number");
      expect(Array.isArray(response.output)).toBe(true);
      // list-windows always produces at least one line for the initial window
      expect(response.output.length).toBeGreaterThan(0);
    },
    15000,
  );

  it(
    "execute(invalid-command-xyz) resolves with success: false",
    async () => {
      sessionName = uniqueSession("test-corr");
      client = await createSession(sessionName);

      // TmuxClient calls entry.reject on %error — the promise rejects with a
      // CommandResponse whose success field is false. We catch it and assert.
      const response = await client
        .execute("invalid-command-xyz")
        .then(
          (r) => r,
          (r: CommandResponse) => r,
        );

      expect(response.success).toBe(false);
    },
    15000,
  );

  it(
    "concurrent execute() calls all resolve (FIFO ordering)",
    async () => {
      sessionName = uniqueSession("test-corr");
      client = await createSession(sessionName);

      // [LAW:dataflow-not-control-flow] All three commands are enqueued
      // unconditionally; the FIFO queue decides when each resolves.
      const [r1, r2, r3] = await Promise.all([
        client.execute("list-windows"),
        client.execute("list-panes"),
        client.execute("list-windows"),
      ]);

      // All must resolve (not hang or reject)
      expect(r1.success).toBe(true);
      expect(r2.success).toBe(true);
      expect(r3.success).toBe(true);

      // Each response carries the correlation fields
      for (const r of [r1, r2, r3]) {
        expect(typeof r.commandNumber).toBe("number");
        expect(typeof r.timestamp).toBe("number");
        expect(Array.isArray(r.output)).toBe(true);
      }
    },
    15000,
  );
});

// ---------------------------------------------------------------------------
// 2. Lifecycle events
// ---------------------------------------------------------------------------

describe.skipIf(!RUN_INTEGRATION)("Lifecycle events", () => {
  let sessionName: string;

  afterEach(() => {
    killSession(sessionName);
  });

  it(
    "exit event fires when transport is closed",
    async () => {
      sessionName = uniqueSession("test-lifecycle");
      const client = await createSession(sessionName);

      // Wrap the exit event in a promise so we can await it deterministically.
      const exitPromise = new Promise<void>((resolve) => {
        client.on("exit", () => resolve());
      });

      // Execute a command first to verify the client is live, then close.
      await client.execute("list-windows");
      client.close();

      // The exit event must fire within the timeout window.
      await exitPromise;
    },
    15000,
  );
});
