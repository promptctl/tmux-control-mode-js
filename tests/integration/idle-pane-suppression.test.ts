// tests/integration/idle-pane-suppression.test.ts
// Integration tests for opt-in idle-pane suppression against a real tmux server.
// Covers acceptance tests #27–#32 from tmux-pane-output-i3m.5.
//
// [LAW:verifiable-goals] Gated behind TMUX_INTEGRATION=1. Uses ephemeral
//   isolated servers — the developer's default tmux server is never touched.
// [LAW:behavior-not-structure] Asserts the observable tmux-side effect: the
//   `refresh-client -A '%N:pause|continue'` command on the wire, and (for #32)
//   the per-control-mode-client isolation of pausing. A recording transport
//   wrapper captures outbound commands; nothing reaches into the suppressor.

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { execSync } from "node:child_process";
import { spawnTmux } from "../../src/transport/spawn.js";
import { TmuxClient } from "../../src/client.js";
import {
  serverScope,
  windowScope,
  paneScope,
  parsePaneListLine,
  type BytesSink,
} from "../../src/pane-output.js";
import { PaneAction } from "../../src/protocol/types.js";
import type { TmuxTransport } from "../../src/transport/types.js";

const RUN_INTEGRATION = process.env.TMUX_INTEGRATION === "1";

// ---------------------------------------------------------------------------
// Server-isolation helpers (same pattern as pane-scope.test.ts)
// ---------------------------------------------------------------------------

function uniqueSocket(prefix: string): string {
  return `tmux-idle-test-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function uniqueSession(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

// [LAW:single-enforcer] Only place that builds `tmux -L <socket> …` strings.
function tmuxCmd(socketName: string, args: string): string {
  return `tmux -L ${socketName} ${args}`;
}

function killServer(socketName: string): void {
  try {
    execSync(tmuxCmd(socketName, "kill-server"), { stdio: "ignore" });
  } catch {
    // already gone — not an error
  }
}

/**
 * A transport that records every command sent to tmux while delegating to the
 * real spawned transport. `sent` is the live capture used by assertions.
 */
function recordingTransport(inner: TmuxTransport): {
  transport: TmuxTransport;
  sent: string[];
} {
  const sent: string[] = [];
  return {
    sent,
    transport: {
      send: (cmd) => {
        sent.push(cmd);
        inner.send(cmd);
      },
      onData: (cb) => inner.onData(cb),
      onClose: (cb) => inner.onClose(cb),
      close: () => inner.close(),
    },
  };
}

/** Create a session on the isolated socket and return a ready client. */
function createClient(
  socketName: string,
  sessionName: string,
  options?: ConstructorParameters<typeof TmuxClient>[1],
): Promise<{ client: TmuxClient; sent: string[] }> {
  execSync(tmuxCmd(socketName, `new-session -d -s ${sessionName}`), {
    stdio: "ignore",
  });
  return attachClient(socketName, sessionName, options);
}

/** Attach a (possibly second) control-mode client to an existing session. */
function attachClient(
  socketName: string,
  sessionName: string,
  options?: ConstructorParameters<typeof TmuxClient>[1],
): Promise<{ client: TmuxClient; sent: string[] }> {
  const inner = spawnTmux(["attach-session", "-t", sessionName], {
    socketPath: socketName,
  });
  const { transport, sent } = recordingTransport(inner);
  const client = new TmuxClient(transport, options);
  return new Promise((resolve) => {
    const handler = () => {
      client.off("session-changed", handler);
      resolve({ client, sent });
    };
    client.on("session-changed", handler);
  });
}

async function listAllPanes(
  client: TmuxClient,
): Promise<{ paneId: number; windowId: number; sessionId: number }[]> {
  const response = await client.execute(
    "list-panes -a -F '#{pane_id} #{window_id} #{session_id}'",
  );
  return response.output.flatMap((line) => {
    const parsed = parsePaneListLine(line);
    return parsed !== null ? [parsed] : [];
  });
}

function sendOutputToPane(client: TmuxClient, paneId: number): Promise<unknown> {
  return client.execute(`send-keys -t %${paneId} 'echo idle-test-${paneId}' Enter`);
}

function makeRecordingSink(arrived: number[]): BytesSink {
  return {
    write: (msg) => arrived.push(msg.paneId),
    end: () => undefined,
  };
}

function waitFor(pred: () => boolean, timeoutMs = 8000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      if (pred()) return resolve();
      if (Date.now() >= deadline)
        return reject(new Error(`waitFor: condition not met within ${timeoutMs} ms`));
      setTimeout(check, 5);
    };
    check();
  });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Poll `list-panes -a` until a pane not in `knownIds` appears, returning it.
 * A single snapshot can race a freshly-created pane's registration under load;
 * polling removes that race.
 */
async function waitForNewPane(
  client: TmuxClient,
  knownIds: number[],
  timeoutMs = 8000,
): Promise<{ paneId: number; windowId: number; sessionId: number }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = (await listAllPanes(client)).find(
      (p) => !knownIds.includes(p.paneId),
    );
    if (found !== undefined) return found;
    if (Date.now() >= deadline)
      throw new Error("waitForNewPane: no new pane appeared in time");
    await sleep(20);
  }
}

// Did a pause / continue command for this pane reach the wire?
const pausePat = (paneId: number) => `%${paneId}:${PaneAction.Pause}`;
const continuePat = (paneId: number) => `%${paneId}:${PaneAction.Continue}`;
const paused = (sent: string[], paneId: number) =>
  sent.some((c) => c.includes(pausePat(paneId)));
const continued = (sent: string[], paneId: number) =>
  sent.some((c) => c.includes(continuePat(paneId)));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!RUN_INTEGRATION)("Idle pane suppression", () => {
  let socketName = "";
  const clients: TmuxClient[] = [];

  beforeEach(() => {
    socketName = uniqueSocket("idle");
  });

  afterEach(() => {
    for (const c of clients) c.close();
    clients.length = 0;
    if (socketName !== "") killServer(socketName);
    socketName = "";
  });

  // ── #27: Suppression activates on idle ──────────────────────────────────
  it(
    "IDLE-27: pauses an idle pane that has no consumers",
    async () => {
      const { client, sent } = await createClient(
        socketName,
        uniqueSession("idle27"),
        { idlePaneSuppression: true },
      );
      clients.push(client);

      const panes = await listAllPanes(client);
      const paneX = panes[0].paneId;
      // Bootstrap learns %X, finds no admitting attachment, pauses it.
      await waitFor(() => paused(sent, paneX));
      expect(paused(sent, paneX)).toBe(true);
    },
    15000,
  );

  // ── #28: Suppression releases on attach ─────────────────────────────────
  it(
    "IDLE-28: continues a paused pane when a sink attaches, then delivers bytes",
    async () => {
      const { client, sent } = await createClient(
        socketName,
        uniqueSession("idle28"),
        { idlePaneSuppression: true },
      );
      clients.push(client);

      const paneX = (await listAllPanes(client))[0].paneId;
      await waitFor(() => paused(sent, paneX));

      sent.length = 0;
      const arrived: number[] = [];
      const dispose = client.attachBytesSink(makeRecordingSink(arrived), {
        scope: paneScope(paneX),
      });
      await waitFor(() => continued(sent, paneX));
      expect(continued(sent, paneX)).toBe(true);

      await sendOutputToPane(client, paneX);
      await waitFor(() => arrived.includes(paneX));
      expect(arrived).toContain(paneX);
      dispose();
    },
    15000,
  );

  // ── #29: Suppression re-activates on detach ─────────────────────────────
  it(
    "IDLE-29: re-pauses a pane when its last sink detaches",
    async () => {
      const { client, sent } = await createClient(
        socketName,
        uniqueSession("idle29"),
        { idlePaneSuppression: true },
      );
      clients.push(client);

      const paneX = (await listAllPanes(client))[0].paneId;
      const dispose = client.attachBytesSink(makeRecordingSink([]), {
        scope: paneScope(paneX),
      });
      await waitFor(() => continued(sent, paneX));

      sent.length = 0;
      dispose();
      await waitFor(() => paused(sent, paneX));
      expect(paused(sent, paneX)).toBe(true);
    },
    15000,
  );

  // ── #30: Cross-scope interaction (serverScope admits everything) ─────────
  it(
    "IDLE-30: serverScope keeps new panes unpaused; detach re-pauses them",
    async () => {
      const { client, sent } = await createClient(
        socketName,
        uniqueSession("idle30"),
        { idlePaneSuppression: true },
      );
      clients.push(client);

      const initial = await listAllPanes(client);
      const serverDispose = client.attachBytesSink(makeRecordingSink([]), {
        scope: serverScope,
      });

      // Spawn a new pane %Y while serverScope is attached.
      sent.length = 0;
      await client.execute("new-window");
      const paneY = (
        await waitForNewPane(
          client,
          initial.map((p) => p.paneId),
        )
      ).paneId;

      // serverScope admits %Y: it must be continued, never paused.
      await waitFor(() => continued(sent, paneY));
      expect(paused(sent, paneY)).toBe(false);

      // Detaching the serverScope sink leaves %Y with no admitting attachment.
      sent.length = 0;
      serverDispose();
      await waitFor(() => paused(sent, paneY));
      expect(paused(sent, paneY)).toBe(true);
    },
    20000,
  );

  // ── #31: Topology-driven transitions ────────────────────────────────────
  //
  // The ticket frames this as a session-scope move to another session ($A → $B).
  // A control-mode client attached to $A does not receive layout notifications
  // for a foreign session's windows, so a pane moved fully into $B simply leaves
  // this client's observable topology — it cannot (and should not) be paused, as
  // its output is no longer delivered here. The scope-counting math for a
  // session move out of an admitting scope is proven deterministically in the
  // unit suite (pane-interest-tracker). Here we exercise the SAME mechanic — a
  // topology move flipping a pane out of an admitting scope → pause — in a form
  // tmux actually notifies the attached client about: a windowScope sink and an
  // intra-session move between two observable windows.
  it(
    "IDLE-31: a new pane in an admitting window is continued; moving it to another window pauses it",
    async () => {
      const { client, sent } = await createClient(
        socketName,
        uniqueSession("idle31"),
        { idlePaneSuppression: true },
      );
      clients.push(client);

      const initial = await listAllPanes(client);
      const windowA = initial[0].windowId;

      // Subscribe to all of window A.
      client.attachBytesSink(makeRecordingSink([]), {
        scope: windowScope(windowA),
      });

      // Split the initial pane → a new pane in window A.
      sent.length = 0;
      await client.execute(`split-window -t %${initial[0].paneId}`);
      const paneNew = (
        await waitForNewPane(
          client,
          initial.map((p) => p.paneId),
        )
      ).paneId;

      // The new pane is admitted by windowScope(A): continued immediately,
      // never paused-then-unpaused.
      await waitFor(() => continued(sent, paneNew));
      expect(paused(sent, paneNew)).toBe(false);

      // Create a second window in the same session and move the pane into it.
      await client.execute("new-window");
      const knownIds = [...initial.map((p) => p.paneId), paneNew];
      const windowB = (await waitForNewPane(client, knownIds)).windowId;
      expect(windowB).not.toBe(windowA);

      sent.length = 0;
      await client.execute(`move-pane -s %${paneNew} -t @${windowB}`);
      // Now in window B, no longer admitted by windowScope(A): paused.
      await waitFor(() => paused(sent, paneNew));
      expect(paused(sent, paneNew)).toBe(true);
    },
    25000,
  );

  // ── #32: No effect on the user's other tmux clients ─────────────────────
  it(
    "IDLE-32: pausing on one control-mode client does not pause output for another",
    async () => {
      const session = uniqueSession("idle32");
      // Client 1: suppression on, no sinks → it pauses every idle pane (for itself).
      const c1 = await createClient(socketName, session, {
        idlePaneSuppression: true,
      });
      clients.push(c1.client);

      // Client 2: a SECOND control-mode client on the same session, no
      // suppression, with a serverScope sink that records arrivals.
      const c2 = await attachClient(socketName, session);
      clients.push(c2.client);
      const arrived: number[] = [];
      c2.client.attachBytesSink(makeRecordingSink(arrived), {
        scope: serverScope,
      });

      const paneX = (await listAllPanes(c1.client))[0].paneId;
      // Client 1 pauses %X for itself.
      await waitFor(() => paused(c1.sent, paneX));

      // Drive output; client 2 (which never paused) must still receive it.
      await sendOutputToPane(c2.client, paneX);
      await waitFor(() => arrived.includes(paneX));
      expect(arrived).toContain(paneX);
    },
    20000,
  );
});
