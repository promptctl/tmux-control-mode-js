// tests/integration/keymap.test.ts
// End-to-end test: bindKeymap drives a real tmux server via TmuxClient.
// Fires synthetic KeyEvents and asserts observable tmux state changes.

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { execSync } from "node:child_process";
import { spawnTmux } from "../../src/transport/spawn.js";
import { TmuxClient } from "../../src/client.js";
import {
  bindKeymap,
  defaultTmuxKeymap,
  parseChord,
} from "../../src/keymap/index.js";

const RUN_INTEGRATION = process.env.TMUX_INTEGRATION === "1";

// [LAW:single-enforcer] Socket/session helpers mirror client.test.ts so the
// isolation model is identical — each test gets its own tmux server.
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
function createSession(
  socketName: string,
  sessionName: string,
): Promise<TmuxClient> {
  execSync(`tmux -L ${socketName} new-session -d -s ${sessionName}`, {
    stdio: "ignore",
  });
  const transport = spawnTmux(["attach-session", "-t", sessionName], {
    socketPath: socketName,
  });
  const client = new TmuxClient(transport);
  return new Promise((resolve) => {
    const handler = () => {
      client.off("session-changed", handler);
      resolve(client);
    };
    client.on("session-changed", handler);
  });
}

// Wait for an event type, with timeout.
function waitFor<T extends { type: string }>(
  client: TmuxClient,
  type: T["type"],
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client.off(type as any, handler);
      reject(new Error(`timeout waiting for ${type}`));
    }, timeoutMs);
    const handler = () => {
      clearTimeout(timer);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client.off(type as any, handler);
      resolve();
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client.on(type as any, handler);
  });
}

describe.skipIf(!RUN_INTEGRATION)("keymap integration", () => {
  let socketName: string;
  let client: TmuxClient | null = null;

  beforeEach(() => {
    socketName = uniqueSocket("keymap");
  });

  afterEach(() => {
    client?.close();
    client = null;
    killServer(socketName);
  });

  it(
    "C-b c creates a new window (window-add observed, list-windows shows 2)",
    async () => {
      client = await createSession(socketName, uniqueSession("test-keymap"));
      const bound = bindKeymap(client, defaultTmuxKeymap());

      const windowAdded = waitFor(client, "window-add", 5000);
      expect(bound.handleKey(parseChord("C-b"))).toBe(true);
      expect(bound.handleKey(parseChord("c"))).toBe(true);
      await windowAdded;

      const list = await client.execute("list-windows");
      expect(list.success).toBe(true);
      expect(list.output.length).toBe(2);
    },
    15000,
  );

  it(
    "C-b % splits the window (layout-change observed, 2 panes)",
    async () => {
      client = await createSession(socketName, uniqueSession("test-keymap"));
      const bound = bindKeymap(client, defaultTmuxKeymap());

      const layoutChanged = waitFor(client, "layout-change", 5000);
      bound.handleKey(parseChord("C-b"));
      bound.handleKey(parseChord("%"));
      await layoutChanged;

      const list = await client.execute("list-panes");
      expect(list.success).toBe(true);
      expect(list.output.length).toBe(2);
    },
    15000,
  );

  it(
    "C-b <digit> selects the window at that index",
    async () => {
      client = await createSession(socketName, uniqueSession("test-keymap"));
      const bound = bindKeymap(client, defaultTmuxKeymap());

      // Create two extra windows so we have three total.
      for (let i = 0; i < 2; i++) {
        const added = waitFor(client, "window-add", 5000);
        bound.handleKey(parseChord("C-b"));
        bound.handleKey(parseChord("c"));
        await added;
      }

      // Learn the actual indices — tmux's base-index may be 0 or 1 depending
      // on config. Use the first index from list-windows as our target.
      // [LAW:verifiable-goals] The test asserts "digit chord selects window
      // at that index", not "base-index is 0" — so it reads the real indices.
      const before = await client.execute("list-windows");
      const indices = before.output
        .map((line) => /^(\d+):/.exec(line)?.[1])
        .filter((x): x is string => x !== undefined);
      expect(indices.length).toBe(3);
      const targetIdx = indices[0];
      const activeLineBefore = before.output.find((l) => /^\d+:.*\*/.test(l));
      expect(activeLineBefore?.startsWith(`${targetIdx}:`)).toBe(false);

      bound.handleKey(parseChord("C-b"));
      bound.handleKey(parseChord(targetIdx));

      for (let attempts = 0; attempts < 20; attempts++) {
        const list = await client.execute("list-windows");
        const active = list.output.find((line) => /^\d+:.*\*/.test(line));
        if (active && active.startsWith(`${targetIdx}:`)) return;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error(`window ${targetIdx} never became active`);
    },
    15000,
  );

  it(
    "non-prefix key in root mode returns handled=false and does not dispatch",
    async () => {
      client = await createSession(socketName, uniqueSession("test-keymap"));
      const bound = bindKeymap(client, defaultTmuxKeymap());

      expect(bound.handleKey(parseChord("a"))).toBe(false);

      // Confirm no tmux state changed: still one window, one pane.
      const windows = await client.execute("list-windows");
      expect(windows.output.length).toBe(1);
      const panes = await client.execute("list-panes");
      expect(panes.output.length).toBe(1);
    },
    15000,
  );

  it(
    "unbound chord in prefix mode is swallowed (handled=true, no dispatch)",
    async () => {
      client = await createSession(socketName, uniqueSession("test-keymap"));
      const bound = bindKeymap(client, defaultTmuxKeymap());

      expect(bound.handleKey(parseChord("C-b"))).toBe(true);
      expect(bound.handleKey(parseChord("Z"))).toBe(true);

      const windows = await client.execute("list-windows");
      expect(windows.output.length).toBe(1);
    },
    15000,
  );
});
