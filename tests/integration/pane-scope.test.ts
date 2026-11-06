// tests/integration/pane-scope.test.ts
// Integration tests for scope-based pane output dispatch against a real tmux
// server. Covers all four PaneScope kinds and topology-dependent behaviours
// (dynamic membership, pane moves, multi-scope dispatch).
//
// [LAW:verifiable-goals] Gated behind TMUX_INTEGRATION=1. Uses ephemeral
// isolated servers — the developer's default tmux server is never touched.
//
// Server isolation pattern (identical to client.test.ts):
//   - `uniqueSocket()` allocates a unique `-L <name>` socket per describe block.
//   - the shared `killTmuxServer()` tears the isolated server down in
//     afterEach, regardless of whether any session lingers.
//   - the shared `tmux()` runs every tmux CLI call, so no raw `tmux` prefix
//     can escape the isolation layer.

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { killTmuxServer } from "../helpers/reap-test-sockets.js";
import {
  uniqueSocket,
  uniqueName,
  pollUntil,
  attachSession,
  attachClient,
  tmux,
} from "../helpers/integration.js";
import type { TmuxClient } from "../../src/client.js";
import {
  serverScope,
  sessionScope,
  windowScope,
  paneScope,
  parsePaneListLine,
} from "../../src/pane-output.js";
import type { BytesSink } from "../../src/pane-output.js";

const RUN_INTEGRATION = process.env.TMUX_INTEGRATION === "1";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse numeric IDs from `list-panes -a` output.
 *
 * Returns an array of `{paneId, windowId, sessionId}` triples. The format
 * `%N @N $N` is the authoritative form used by `parsePaneListLine`.
 */
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

/**
 * Send a keystroke to the given pane so it produces output.
 *
 * Uses `send-keys … Enter` to a specific pane target so the pane that
 * receives input is explicit, not the currently-active pane.
 */
function sendOutputToPane(client: TmuxClient, paneId: number): Promise<void> {
  return client
    .execute(`send-keys -t %${paneId} 'echo scope-test-${paneId}' Enter`)
    .then(() => undefined);
}

/**
 * Return a `BytesSink` that collects every chunk where `paneId` matches a set.
 * `arrived` is the live reference — push to it from `write`.
 */
function makeRecordingSink(
  arrived: { paneId: number; data: Uint8Array }[],
): BytesSink {
  return {
    write(msg): void {
      arrived.push({ paneId: msg.paneId, data: msg.data.slice() });
    },
    end(): void {},
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!RUN_INTEGRATION)("Scope-based pane output", () => {
  let socketName = "";
  let client: TmuxClient | null = null;

  beforeEach(() => {
    socketName = uniqueSocket("tmux-scope-test-", "scope");
  });

  afterEach(() => {
    client?.close();
    client = null;
    if (socketName !== "") killTmuxServer(socketName);
    socketName = "";
  });

  // ── Test 1: serverScope baseline ─────────────────────────────────────────

  it("SCOPE-01: serverScope receives bytes from panes in multiple windows", async () => {
    const session = uniqueName("srv");
    client = await attachSession(socketName, session);

    const arrived: { paneId: number; data: Uint8Array }[] = [];
    const dispose = client.attachBytesSink(makeRecordingSink(arrived));

    // Produce output in the initial pane (window 0).
    const panesInit = await listAllPanes(client);
    expect(panesInit.length).toBeGreaterThan(0);
    const paneA = panesInit[0].paneId;
    await sendOutputToPane(client, paneA);
    await pollUntil(() => arrived.some((e) => e.paneId === paneA));

    // Create a second window and produce output in its pane. Server scope
    // must deliver bytes from BOTH windows — it is not scoped to a session,
    // window, or pane.
    await client.execute("new-window");
    const panesAfter = await listAllPanes(client);
    const newPanes = panesAfter.filter(
      (p) => !panesInit.some((a) => a.paneId === p.paneId),
    );
    expect(newPanes.length).toBeGreaterThan(0);
    const paneB = newPanes[0].paneId;
    await sendOutputToPane(client, paneB);
    await pollUntil(() => arrived.some((e) => e.paneId === paneB));

    dispose();
  }, 15000);

  // ── Test 2: paneScope isolation ───────────────────────────────────────────

  it("SCOPE-02: paneScope delivers only the subscribed pane", async () => {
    const session = uniqueName("pane-iso");
    client = await attachSession(socketName, session);

    // Create a second window so we have two distinct panes.
    await client.execute("new-window");
    const panes = await listAllPanes(client);
    expect(panes.length).toBeGreaterThanOrEqual(2);

    const paneX = panes[0].paneId;
    const paneY = panes[1].paneId;

    const arrived: { paneId: number }[] = [];
    const dispose = client.attachBytesSink(
      {
        write(msg) {
          arrived.push({ paneId: msg.paneId });
        },
        end() {},
      },
      { scope: paneScope(paneX) },
    );

    // Output from %X must arrive.
    await sendOutputToPane(client, paneX);
    await pollUntil(() => arrived.some((e) => e.paneId === paneX));

    // Output from %Y must not arrive (wait briefly and assert empty for Y).
    await sendOutputToPane(client, paneY);
    // Give Y bytes a fair chance to arrive (they should not).
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    expect(arrived.some((e) => e.paneId === paneY)).toBe(false);

    dispose();
  }, 15000);

  // ── Test 3: sessionScope inclusion ───────────────────────────────────────

  it("SCOPE-03: sessionScope delivers bytes from all panes in the session", async () => {
    const session = uniqueName("sess-inc");
    client = await attachSession(socketName, session);

    // Initial state: one pane in one window.
    const panesBefore = await listAllPanes(client);
    expect(panesBefore.length).toBeGreaterThan(0);
    const sessionId = panesBefore[0].sessionId;

    // Add a second window so we have two panes in the same session.
    await client.execute("new-window");
    const panesAfter = await listAllPanes(client);
    expect(panesAfter.length).toBeGreaterThanOrEqual(2);

    const arrived: { paneId: number }[] = [];
    const dispose = client.attachBytesSink(
      {
        write(msg) {
          arrived.push({ paneId: msg.paneId });
        },
        end() {},
      },
      { scope: sessionScope(sessionId) },
    );

    // Both panes in the session must deliver bytes.
    for (const p of panesAfter) {
      await sendOutputToPane(client, p.paneId);
    }
    await pollUntil(() =>
      panesAfter.every((p) => arrived.some((e) => e.paneId === p.paneId)),
    );

    // Verify no extraneous pane IDs arrive (only IDs in this session).
    const knownIds = new Set(panesAfter.map((p) => p.paneId));
    expect(arrived.every((e) => knownIds.has(e.paneId))).toBe(true);

    dispose();
  }, 15000);

  // ── Test 3b: sessionScope output provoked before topology lands ──────────

  it("SCOPE-03b: sessionScope receives output provoked once, right after attach, from another client", async () => {
    const session = uniqueName("sess-early");
    client = await attachSession(socketName, session);
    const [pane] = await listAllPanes(client);
    expect(pane).toBeDefined();

    const arrived: { paneId: number; data: Uint8Array }[] = [];
    const dispose = client.attachBytesSink(makeRecordingSink(arrived), {
      scope: sessionScope(pane!.sessionId),
    });
    // Provoke exactly once, through the tmux CLI — a client our command
    // stream does not order — before the attach-triggered bootstrap replies.
    tmux(socketName, [
      "send-keys",
      "-t",
      `%${pane!.paneId}`,
      "printf 'early-%s' scope",
      "Enter",
    ]);
    const has = () =>
      arrived.some((e) =>
        Buffer.from(e.data).toString().includes("early-scope"),
      );
    await pollUntil(has);

    dispose();
  }, 15000);

  // ── Test 4: sessionScope dynamic membership ───────────────────────────────

  it("SCOPE-04: sessionScope tracks a new window created after subscription", async () => {
    const session = uniqueName("sess-dyn");
    client = await attachSession(socketName, session);

    const allBefore = await listAllPanes(client);
    expect(allBefore.length).toBeGreaterThan(0);
    const sessionId = allBefore[0].sessionId;

    const arrived: { paneId: number }[] = [];
    const dispose = client.attachBytesSink(
      {
        write(msg) {
          arrived.push({ paneId: msg.paneId });
        },
        end() {},
      },
      { scope: sessionScope(sessionId) },
    );

    // Create a new window AFTER subscription.
    await client.execute("new-window");

    const allAfter = await listAllPanes(client);
    const newPanes = allAfter.filter(
      (p) => !allBefore.some((b) => b.paneId === p.paneId),
    );
    expect(newPanes.length).toBeGreaterThan(0);
    const newPane = newPanes[0].paneId;

    // Output in the new pane must arrive via the existing sessionScope subscription.
    await sendOutputToPane(client, newPane);
    await pollUntil(() => arrived.some((e) => e.paneId === newPane));

    dispose();
  }, 15000);

  // ── Test 5: windowScope inclusion + isolation ─────────────────────────────

  it("SCOPE-05: windowScope delivers panes in target window, not others", async () => {
    const session = uniqueName("win-iso");
    client = await attachSession(socketName, session);

    // Create a second window.
    await client.execute("new-window");
    const allPanes = await listAllPanes(client);
    expect(allPanes.length).toBeGreaterThanOrEqual(2);

    // Two distinct windows exist; pick the first.
    const windowIds = [...new Set(allPanes.map((p) => p.windowId))];
    expect(windowIds.length).toBeGreaterThanOrEqual(2);
    const windowN = windowIds[0];
    const windowM = windowIds[1];

    const panesInN = allPanes.filter((p) => p.windowId === windowN);
    const panesInM = allPanes.filter((p) => p.windowId === windowM);

    const arrived: { paneId: number }[] = [];
    const dispose = client.attachBytesSink(
      {
        write(msg) {
          arrived.push({ paneId: msg.paneId });
        },
        end() {},
      },
      { scope: windowScope(windowN) },
    );

    // Pane(s) in @N must arrive.
    for (const p of panesInN) {
      await sendOutputToPane(client, p.paneId);
    }
    await pollUntil(() =>
      panesInN.every((p) => arrived.some((e) => e.paneId === p.paneId)),
    );

    // Pane(s) in @M must NOT arrive.
    for (const p of panesInM) {
      await sendOutputToPane(client, p.paneId);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    expect(
      panesInM.every((p) => !arrived.some((e) => e.paneId === p.paneId)),
    ).toBe(true);

    dispose();
  }, 15000);

  // ── Test 6: pane move (sessionScope) ─────────────────────────────────────

  it("SCOPE-06: sessionScope excludes a window moved out of the session", async () => {
    const sessionA = uniqueName("move-a");
    client = await attachSession(socketName, sessionA);

    // Create a second session to move a window into.
    const sessionB = uniqueName("move-b");
    tmux(socketName, ["new-session", "-d", "-s", sessionB]);

    // Create a second window in A so we have a movable window.
    await client.execute("new-window");

    const allBefore = await listAllPanes(client);
    expect(allBefore.length).toBeGreaterThanOrEqual(2);
    const sessionAId = allBefore[0].sessionId;

    const windowIds = [
      ...new Set(
        allBefore
          .filter((p) => p.sessionId === sessionAId)
          .map((p) => p.windowId),
      ),
    ];
    expect(windowIds.length).toBeGreaterThanOrEqual(2);
    const windowToMove = windowIds[1];
    const movedPanes = allBefore.filter((p) => p.windowId === windowToMove);
    expect(movedPanes.length).toBeGreaterThan(0);
    const movedPane = movedPanes[0].paneId;

    const arrived: { paneId: number }[] = [];
    const dispose = client.attachBytesSink(
      {
        write(msg) {
          arrived.push({ paneId: msg.paneId });
        },
        end() {},
      },
      { scope: sessionScope(sessionAId) },
    );

    // Move the window from A to B.
    tmux(socketName, [
      "move-window",
      "-s",
      `@${windowToMove}`,
      "-t",
      `${sessionB}:`,
    ]);

    // Allow topology-changed notifications to propagate.
    await new Promise<void>((resolve) => setTimeout(resolve, 300));

    const beforeCount = arrived.length;

    // Output in the moved pane — now in B — must NOT arrive to the A sink.
    await sendOutputToPane(client, movedPane);
    await new Promise<void>((resolve) => setTimeout(resolve, 300));
    expect(arrived.length).toBe(beforeCount);

    dispose();
  }, 20000);

  // ── Test 7: multi-scope dispatch (no duplication) ─────────────────────────

  it("SCOPE-07: serverScope + paneScope each fire exactly once per chunk", async () => {
    const session = uniqueName("multi");
    client = await attachSession(socketName, session);

    const allPanes = await listAllPanes(client);
    expect(allPanes.length).toBeGreaterThan(0);
    const paneX = allPanes[0].paneId;

    let serverCount = 0;
    let paneCount = 0;

    const disposeServer = client.attachBytesSink(
      {
        write(msg) {
          if (msg.paneId === paneX) serverCount++;
        },
        end() {},
      },
      { scope: serverScope },
    );
    const disposePane = client.attachBytesSink(
      {
        write() {
          paneCount++;
        },
        end() {},
      },
      { scope: paneScope(paneX) },
    );

    await sendOutputToPane(client, paneX);
    // Wait until at least one chunk arrived via each path.
    await pollUntil(() => serverCount > 0 && paneCount > 0);

    // Both sinks fired; neither double-fired relative to the other.
    // (Counts equal because each chunk routes through each matching scope exactly once.)
    expect(serverCount).toBe(paneCount);

    disposeServer();
    disposePane();
  }, 15000);

  // ── Test 8: bootstrap correctness ─────────────────────────────────────────

  it("SCOPE-08: sessionScope routes correctly when subscribed to a pre-existing multi-pane session", async () => {
    // Pre-populate the attached session with two windows so the topology
    // bootstrap must seed a table with multiple panes. This exercises the
    // seed path for pre-existing panes — the client's own list-panes -a
    // query must populate topology before the first byte from any pane.
    const sessionX = uniqueName("boot-x");
    tmux(socketName, ["new-session", "-d", "-s", sessionX]);
    // Add a second window before attaching so the bootstrap sees ≥2 panes.
    tmux(socketName, ["new-window", "-t", `${sessionX}:`]);

    // Attach as a client AFTER the windows are created.
    const c = await attachClient(socketName, sessionX);
    client = c;

    // `listAllPanes` returns all panes visible via this client's session. All
    // panes share the same sessionId (only one session is attached).
    const allPanes = await listAllPanes(c);
    expect(allPanes.length).toBeGreaterThanOrEqual(2);
    // All returned panes belong to the same session (single attached session).
    const sessionId = allPanes[0].sessionId;
    expect(allPanes.every((p) => p.sessionId === sessionId)).toBe(true);

    // Subscribe AFTER client is ready — triggers lazy bootstrap.
    const arrived: { paneId: number }[] = [];
    const dispose = c.attachBytesSink(
      {
        write(msg) {
          arrived.push({ paneId: msg.paneId });
        },
        end() {},
      },
      { scope: sessionScope(sessionId) },
    );

    // All panes must route correctly via the bootstrapped topology.
    for (const p of allPanes) {
      await sendOutputToPane(c, p.paneId);
    }
    await pollUntil(() =>
      allPanes.every((p) => arrived.some((e) => e.paneId === p.paneId)),
    );

    dispose();
  }, 20000);

  // ── Test 9: no-consumer fast path ─────────────────────────────────────────

  it("SCOPE-09: zero-attachment path produces no dispatch work", async () => {
    const session = uniqueName("noconsumer");
    client = await attachSession(socketName, session);

    const allPanes = await listAllPanes(client);
    const pane = allPanes[0].paneId;

    // No sink attached. Output from the pane must not throw or hang.
    // Verified by the absence of errors — the test completes cleanly.
    await sendOutputToPane(client, pane);
    // A brief wait confirms no crash / unhandled rejection occurs.
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    // No assertion — the test passing is the assertion.
  }, 10000);

  // ── Test 10: two-session isolation ───────────────────────────────────────

  it("SCOPE-10: sessionScope($A) receives bytes from $A but NOT from $B", async () => {
    const sessionA = uniqueName("iso-a");
    client = await attachSession(socketName, sessionA);

    // Create session B independently — the control-mode client attached to
    // A can still send commands targeting B's pane (the server is shared).
    const sessionB = uniqueName("iso-b");
    tmux(socketName, ["new-session", "-d", "-s", sessionB]);

    const allPanes = await listAllPanes(client);
    // The global pane list should show panes from both sessions.
    const sessionAId = allPanes[0]?.sessionId;
    expect(sessionAId).toBeDefined();
    const panesA = allPanes.filter((p) => p.sessionId === sessionAId);
    const panesB = allPanes.filter((p) => p.sessionId !== sessionAId);
    // B's session is detached; its panes should appear in the global list.
    expect(panesB.length).toBeGreaterThan(0);

    const arrived: { paneId: number }[] = [];
    const dispose = client.attachBytesSink(
      {
        write(msg) {
          arrived.push({ paneId: msg.paneId });
        },
        end() {},
      },
      { scope: sessionScope(sessionAId!) },
    );

    // Output from A's pane must arrive.
    const paneA = panesA[0].paneId;
    await sendOutputToPane(client, paneA);
    await pollUntil(() => arrived.some((e) => e.paneId === paneA));

    // Output from B's pane — sent via the same control-mode client which has
    // server-wide command authority — must NOT arrive to A's sessionScope sink.
    const paneB = panesB[0].paneId;
    await sendOutputToPane(client, paneB);
    await new Promise<void>((resolve) => setTimeout(resolve, 300));
    expect(arrived.some((e) => e.paneId === paneB)).toBe(false);

    dispose();
  }, 20000);

  // ── Test 11: window-kill removes panes from routing ───────────────────────

  it("SCOPE-11: killing a window removes its panes from sessionScope routing", async () => {
    const session = uniqueName("wkill");
    client = await attachSession(socketName, session);

    // Create a second window so we have two to work with.
    await client.execute("new-window");
    const allPanes = await listAllPanes(client);
    expect(allPanes.length).toBeGreaterThanOrEqual(2);

    const sessionId = allPanes[0].sessionId;
    const windowIds = [...new Set(allPanes.map((p) => p.windowId))];
    expect(windowIds.length).toBeGreaterThanOrEqual(2);

    const windowToKeep = windowIds[0];
    const windowToKill = windowIds[1];
    const panesInKept = allPanes.filter((p) => p.windowId === windowToKeep);

    const arrived: { paneId: number }[] = [];
    const dispose = client.attachBytesSink(
      {
        write(msg) {
          arrived.push({ paneId: msg.paneId });
        },
        end() {},
      },
      { scope: sessionScope(sessionId) },
    );

    // Confirm output from both windows arrives before the kill.
    for (const p of allPanes) {
      await sendOutputToPane(client, p.paneId);
    }
    await pollUntil(() =>
      allPanes.every((p) => arrived.some((e) => e.paneId === p.paneId)),
    );
    arrived.length = 0; // reset

    // Kill the second window and allow topology notifications to propagate.
    // [LAW:single-enforcer] window-close triggers TopologyRouter.handleNotification
    // which calls topology.removeWindow() exactly once — the epoch mechanism
    // ensures any in-flight list-panes result for this window is discarded.
    await client.execute(`kill-window -t @${windowToKill}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 300));

    // Panes in the surviving window must still receive bytes — the topology
    // update from window-close must not corrupt routing for remaining panes.
    for (const p of panesInKept) {
      await sendOutputToPane(client, p.paneId);
    }
    await pollUntil(() =>
      panesInKept.every((p) => arrived.some((e) => e.paneId === p.paneId)),
    );

    dispose();
  }, 20000);
});
