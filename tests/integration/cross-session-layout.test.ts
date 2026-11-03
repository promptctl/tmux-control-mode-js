// tests/integration/cross-session-layout.test.ts
// Real-tmux integration tests for the cross-session layout relay
// (tmux-server-events-6sp.1xs) — reproduces the ticket's exact repro
// ("zooming a window in another session delivers nothing to a client
// attached elsewhere") and the same-tick-burst fix.
//
// [LAW:verifiable-goals] Gated behind TMUX_INTEGRATION=1, same convention as
// tests/integration/client.test.ts.

import { describe, it, beforeEach, afterEach, expect, vi } from "vitest";
import { execSync } from "node:child_process";
import { spawnTmux } from "../../src/transport/spawn.js";
import { killTmuxServer } from "../helpers/reap-test-sockets.js";
import { TmuxClient } from "../../src/client.js";
import type { ConnectionStateMessage } from "../../src/connection-state.js";
import type {
  CrossSessionLayoutChangeMessage,
  CrossSessionLayoutDecodeErrorMessage,
  CrossSessionLayoutMessage,
} from "../../src/cross-session-layout.js";

const RUN_INTEGRATION = process.env.TMUX_INTEGRATION === "1";

function uniqueSocket(prefix: string): string {
  // [LAW:one-source-of-truth] Must start with a prefix registered in
  // tests/helpers/reap-test-sockets.ts's TEST_SOCKET_PREFIXES, or this
  // suite's sockets leak uncollected. "tmux-js-test-" is already registered.
  return `tmux-js-test-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function uniqueName(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function tmuxCmd(socketName: string, args: string): string {
  return `tmux -L ${socketName} ${args}`;
}

function exec(socketName: string, args: string): void {
  execSync(tmuxCmd(socketName, args), { stdio: "ignore" });
}

function waitReady(client: TmuxClient, ms = 12000): Promise<void> {
  return new Promise((resolve, reject) => {
    const h = (e: ConnectionStateMessage) => {
      if (e.state.status !== "ready") return;
      clearTimeout(timer);
      client.off("connection-state", h);
      resolve();
    };
    const timer = setTimeout(() => {
      client.off("connection-state", h);
      reject(new Error(`client did not reach ready state within ${ms}ms`));
    }, ms);
    client.on("connection-state", h);
  });
}

async function attachClient(
  socketName: string,
  sessionName: string,
): Promise<TmuxClient> {
  const client = new TmuxClient(
    spawnTmux(["attach-session", "-t", sessionName], {
      socketPath: socketName,
    }),
  );
  await waitReady(client);
  return client;
}

/**
 * Resolve with every `cross-session-layout-change` event observed within
 * `ms` after arming (armed synchronously so nothing fired between arming
 * and provoking can be missed), rather than resolving on the first one —
 * a same-tick burst across multiple windows must produce multiple events,
 * not just the first.
 */
function collectCrossSessionLayoutChanges(
  client: TmuxClient,
  ms: number,
): {
  events: CrossSessionLayoutChangeMessage[];
  settle: () => Promise<CrossSessionLayoutChangeMessage[]>;
} {
  const events: CrossSessionLayoutChangeMessage[] = [];
  const handler = (ev: CrossSessionLayoutChangeMessage): void => {
    events.push(ev);
  };
  client.on("cross-session-layout-change", handler);
  const settle = () =>
    new Promise<CrossSessionLayoutChangeMessage[]>((resolve) => {
      setTimeout(() => {
        client.off("cross-session-layout-change", handler);
        resolve(events);
      }, ms);
    });
  return { events, settle };
}

describe.skipIf(!RUN_INTEGRATION)("CrossSessionLayoutRelay (real tmux)", () => {
  let socketName: string;

  beforeEach(() => {
    socketName = uniqueSocket("xsl");
  });

  afterEach(() => {
    killTmuxServer(socketName);
  });

  it("delivers a layout change from a session the client is not attached to", async () => {
    const sessionA = uniqueName("a");
    const sessionB = uniqueName("b");
    exec(socketName, `new-session -d -s ${sessionA}`);
    exec(socketName, `new-session -d -s ${sessionB}`);

    const clientA = await attachClient(socketName, sessionA);
    try {
      await clientA.enableCrossSessionLayoutChange();

      const { settle } = collectCrossSessionLayoutChanges(clientA, 3000);

      // The ticket's exact repro: a layout change in a session this
      // client is NOT attached to. split-window triggers %layout-change,
      // which tmux never delivers to clientA at all (SPEC.md §6.2) since
      // the window isn't in clientA's session.
      exec(socketName, `split-window -t ${sessionB}`);

      const events = await settle();
      expect(events.length).toBeGreaterThanOrEqual(1);
      const sessionIds = await (async () => {
        const out = execSync(
          tmuxCmd(
            socketName,
            `display-message -p -t ${sessionB} "#{session_id}"`,
          ),
          { encoding: "utf8" },
        ).trim();
        return out;
      })();
      const expectedSessionId = Number(sessionIds.replace("$", ""));
      expect(events.some((e) => e.sessionId === expectedSessionId)).toBe(true);
      // Classic checksum-string format, matching native %layout-change —
      // never the tmux-3.8+ JSON `#{window_layout}` rendering.
      for (const e of events) {
        expect(e.windowLayout).toMatch(/^[0-9a-f]+,\d+x\d+,\d+,\d+/i);
      }
    } finally {
      await clientA.disableCrossSessionLayoutChange();
      clientA.close();
    }
  }, 20000);

  it("delivers every window's event from a same-tick burst, not just the last", async () => {
    const sessionA = uniqueName("a");
    const sessionB = uniqueName("b");
    const sessionC = uniqueName("c");
    exec(socketName, `new-session -d -s ${sessionA}`);
    exec(socketName, `new-session -d -s ${sessionB}`);
    exec(socketName, `new-session -d -s ${sessionC}`);

    const clientA = await attachClient(socketName, sessionA);
    try {
      await clientA.enableCrossSessionLayoutChange();
      const { settle } = collectCrossSessionLayoutChanges(clientA, 3000);

      // Two different sessions' windows change layout back-to-back —
      // this is the scenario that overwrote-and-lost an entry before the
      // append-queue fix (a single last-write-wins slot would only ever
      // report the second one).
      exec(socketName, `split-window -t ${sessionB}`);
      exec(socketName, `split-window -t ${sessionC}`);

      const events = await settle();
      const bySession = new Set(events.map((e) => e.sessionId));
      expect(bySession.size).toBeGreaterThanOrEqual(2);
    } finally {
      await clientA.disableCrossSessionLayoutChange();
      clientA.close();
    }
  }, 20000);

  it("delivers the same change to two clients on one server", async () => {
    // Every relay reads one shared buffer; neither may consume an entry
    // the other has not seen yet.
    const sessionA = uniqueName("a");
    const sessionB = uniqueName("b");
    const sessionC = uniqueName("c");
    exec(socketName, `new-session -d -s ${sessionA}`);
    exec(socketName, `new-session -d -s ${sessionB}`);
    exec(socketName, `new-session -d -s ${sessionC}`);

    const clientA = await attachClient(socketName, sessionA);
    const clientB = await attachClient(socketName, sessionB);
    try {
      await clientA.enableCrossSessionLayoutChange();
      await clientB.enableCrossSessionLayoutChange();
      const a = collectCrossSessionLayoutChanges(clientA, 3000);
      const b = collectCrossSessionLayoutChanges(clientB, 3000);

      exec(socketName, `split-window -t ${sessionC}`);

      const [eventsA, eventsB] = await Promise.all([a.settle(), b.settle()]);
      // One command can fire the hook more than once, on either side of a
      // subscription tick, so count windows rather than events.
      const windowsA = new Set(eventsA.map((e) => e.windowId));
      const windowsB = new Set(eventsB.map((e) => e.windowId));
      expect(windowsA.size).toBe(1);
      expect(windowsB).toEqual(windowsA);
    } finally {
      await clientA.disableCrossSessionLayoutChange();
      await clientB.disableCrossSessionLayoutChange();
      clientA.close();
      clientB.close();
    }
  }, 20000);

  it("never emits a decode-error diagnostic under normal (non-overflow) operation", async () => {
    const sessionA = uniqueName("a");
    const sessionB = uniqueName("b");
    exec(socketName, `new-session -d -s ${sessionA}`);
    exec(socketName, `new-session -d -s ${sessionB}`);

    const clientA = await attachClient(socketName, sessionA);
    try {
      await clientA.enableCrossSessionLayoutChange();
      const decodeErrors: CrossSessionLayoutDecodeErrorMessage[] = [];
      clientA.on("cross-session-layout-decode-error", (e) =>
        decodeErrors.push(e),
      );

      exec(socketName, `split-window -t ${sessionB}`);
      await new Promise((r) => setTimeout(r, 3000));

      expect(decodeErrors).toEqual([]);
    } finally {
      await clientA.disableCrossSessionLayoutChange();
      clientA.close();
    }
  }, 20000);

  it("restores a hook cleared by an index-less set-hook and keeps relaying", async () => {
    const sessionA = uniqueName("a");
    const sessionB = uniqueName("b");
    exec(socketName, `new-session -d -s ${sessionA}`);
    exec(socketName, `new-session -d -s ${sessionB}`);

    const clientA = await attachClient(socketName, sessionA);
    try {
      await clientA.enableCrossSessionLayoutChange();
      const diagnostics: CrossSessionLayoutMessage[] = [];
      clientA.on("cross-session-layout-hook-restored", (e) =>
        diagnostics.push(e),
      );
      clientA.on("cross-session-layout-uncovered", (e) => diagnostics.push(e));

      // A re-sourced tmux.conf: replaces the whole hook array.
      exec(socketName, `set-hook -g window-layout-changed "display-message x"`);
      // Every window reads uncovered until the repair lands; the latest
      // report is the truth.
      await vi.waitFor(
        () => {
          expect(
            diagnostics.filter(
              (e) => e.type === "cross-session-layout-hook-restored",
            ),
          ).toHaveLength(1);
          expect(
            diagnostics
              .filter((e) => e.type === "cross-session-layout-uncovered")
              .at(-1),
          ).toEqual({ type: "cross-session-layout-uncovered", windowIds: [] });
        },
        { timeout: 8000, interval: 100 },
      );

      const { settle } = collectCrossSessionLayoutChanges(clientA, 3000);
      exec(socketName, `split-window -t ${sessionB}`);
      expect((await settle()).length).toBeGreaterThanOrEqual(1);
    } finally {
      await clientA.disableCrossSessionLayoutChange();
      clientA.close();
    }
  }, 20000);

  it("reports a window a window-local hook shadows, and its return", async () => {
    const sessionA = uniqueName("a");
    const sessionB = uniqueName("b");
    exec(socketName, `new-session -d -s ${sessionA}`);
    exec(socketName, `new-session -d -s ${sessionB}`);
    const windowId = Number(
      execSync(
        tmuxCmd(socketName, `display-message -p -t ${sessionB} "#{window_id}"`),
        { encoding: "utf8" },
      )
        .trim()
        .replace("@", ""),
    );

    const clientA = await attachClient(socketName, sessionA);
    try {
      await clientA.enableCrossSessionLayoutChange();
      const reports: number[][] = [];
      clientA.on("cross-session-layout-uncovered", (e) =>
        reports.push([...e.windowIds]),
      );

      exec(
        socketName,
        `set-hook -w -t ${sessionB} window-layout-changed "display-message x"`,
      );
      // The first tick may land before the hook and report [] first; the
      // latest report is the truth.
      const latest = (expected: number[]) =>
        vi.waitFor(() => expect(reports.at(-1)).toEqual(expected), {
          timeout: 8000,
          interval: 100,
        });
      await latest([windowId]);

      exec(socketName, `set-hook -wu -t ${sessionB} window-layout-changed`);
      await latest([]);
    } finally {
      await clientA.disableCrossSessionLayoutChange();
      clientA.close();
    }
  }, 20000);
});
