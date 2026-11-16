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
import { killTmuxServer } from "../helpers/reap-test-sockets.js";
import {
  uniqueSocket,
  uniqueName,
  readUntil,
  attachSession,
  attachClient,
  recordingTransport,
} from "../helpers/integration.js";
import type { TmuxClient, TmuxClientOptions } from "../../src/client.js";
import {
  serverScope,
  windowScope,
  paneScope,
  parsePaneListLine,
  type BytesSink,
} from "../../src/pane-output.js";
import { PaneAction } from "../../src/protocol/types.js";

const RUN_INTEGRATION = process.env.TMUX_INTEGRATION === "1";

interface Recorded {
  client: TmuxClient;
  sent: string[];
}

/** Create a session on the isolated socket and return a recorded ready client. */
async function createClient(
  socketName: string,
  sessionName: string,
  clientOptions?: TmuxClientOptions,
): Promise<Recorded> {
  const sent: string[] = [];
  const client = await attachSession(socketName, sessionName, {
    clientOptions,
    wrapTransport: (inner) => recordingTransport(inner, sent),
  });
  return { client, sent };
}

/** Attach a recorded (possibly second) control-mode client to a session. */
async function attachRecorded(
  socketName: string,
  sessionName: string,
): Promise<Recorded> {
  const sent: string[] = [];
  const client = await attachClient(socketName, sessionName, {
    wrapTransport: (inner) => recordingTransport(inner, sent),
  });
  return { client, sent };
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

function sendOutputToPane(
  client: TmuxClient,
  paneId: number,
): Promise<unknown> {
  return client.execute(
    `send-keys -t %${paneId} 'echo idle-test-${paneId}' Enter`,
  );
}

function makeRecordingSink(arrived: number[]): BytesSink {
  return {
    write: (msg) => arrived.push(msg.paneId),
    end: () => undefined,
  };
}

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
  const isNew = (p: { paneId: number }) => !knownIds.includes(p.paneId);
  const panes = await readUntil(
    () => listAllPanes(client),
    (listing) => listing.some(isNew),
    "waitForNewPane: no new pane appeared",
    timeoutMs,
  );
  // readUntil resolved only on a listing holding a new pane.
  return panes.find(isNew)!;
}

// Did this pause / continue for this pane reach the wire?
const sentAction = (sent: string[], paneId: number, action: PaneAction) =>
  sent.some((c) => c.includes(`%${paneId}:${action}`));

// Resolve once it has; a timeout quotes every pause / continue sent for the pane.
const waitForAction = (sent: string[], paneId: number, action: PaneAction) =>
  readUntil(
    () => sent.filter((c) => c.includes(`%${paneId}:`)),
    (forPane) => sentAction(forPane, paneId, action),
    `%${paneId} was never sent ${action}`,
  );

const waitForArrival = (arrived: number[], paneId: number) =>
  readUntil(
    () => [...new Set(arrived)],
    (panes) => panes.includes(paneId),
    `no output from %${paneId} arrived`,
  );

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
    if (socketName !== "") killTmuxServer(socketName);
    socketName = "";
  });

  // ── #27: Suppression activates on idle ──────────────────────────────────
  it("IDLE-27: pauses an idle pane that has no consumers", async () => {
    const { client, sent } = await createClient(
      socketName,
      uniqueName("idle27"),
      { idlePaneSuppression: true },
    );
    clients.push(client);

    const panes = await listAllPanes(client);
    const paneX = panes[0].paneId;
    // Bootstrap learns %X, finds no admitting attachment, pauses it.
    await waitForAction(sent, paneX, PaneAction.Pause);
  }, 15000);

  // ── #28: Suppression releases on attach ─────────────────────────────────
  it("IDLE-28: continues a paused pane when a sink attaches, then delivers bytes", async () => {
    const { client, sent } = await createClient(
      socketName,
      uniqueName("idle28"),
      { idlePaneSuppression: true },
    );
    clients.push(client);

    const paneX = (await listAllPanes(client))[0].paneId;
    await waitForAction(sent, paneX, PaneAction.Pause);

    sent.length = 0;
    const arrived: number[] = [];
    const dispose = client.attachBytesSink(makeRecordingSink(arrived), {
      scope: paneScope(paneX),
    });
    await waitForAction(sent, paneX, PaneAction.Continue);

    await sendOutputToPane(client, paneX);
    await waitForArrival(arrived, paneX);
    dispose();
  }, 15000);

  // ── #29: Suppression re-activates on detach ─────────────────────────────
  it("IDLE-29: re-pauses a pane when its last sink detaches", async () => {
    const { client, sent } = await createClient(
      socketName,
      uniqueName("idle29"),
      { idlePaneSuppression: true },
    );
    clients.push(client);

    const paneX = (await listAllPanes(client))[0].paneId;
    const dispose = client.attachBytesSink(makeRecordingSink([]), {
      scope: paneScope(paneX),
    });
    await waitForAction(sent, paneX, PaneAction.Continue);

    sent.length = 0;
    dispose();
    await waitForAction(sent, paneX, PaneAction.Pause);
  }, 15000);

  // ── #30: Cross-scope interaction (serverScope admits everything) ─────────
  it("IDLE-30: serverScope keeps new panes unpaused; detach re-pauses them", async () => {
    const { client, sent } = await createClient(
      socketName,
      uniqueName("idle30"),
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
    await waitForAction(sent, paneY, PaneAction.Continue);
    expect(sentAction(sent, paneY, PaneAction.Pause)).toBe(false);

    // Detaching the serverScope sink leaves %Y with no admitting attachment.
    sent.length = 0;
    serverDispose();
    await waitForAction(sent, paneY, PaneAction.Pause);
  }, 20000);

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
  it("IDLE-31: a new pane in an admitting window is continued; moving it to another window pauses it", async () => {
    const { client, sent } = await createClient(
      socketName,
      uniqueName("idle31"),
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
    await waitForAction(sent, paneNew, PaneAction.Continue);
    expect(sentAction(sent, paneNew, PaneAction.Pause)).toBe(false);

    // Create a second window in the same session and move the pane into it.
    await client.execute("new-window");
    const knownIds = [...initial.map((p) => p.paneId), paneNew];
    const windowB = (await waitForNewPane(client, knownIds)).windowId;
    expect(windowB).not.toBe(windowA);

    sent.length = 0;
    await client.execute(`move-pane -s %${paneNew} -t @${windowB}`);
    // Now in window B, no longer admitted by windowScope(A): paused.
    await waitForAction(sent, paneNew, PaneAction.Pause);
  }, 25000);

  // ── #32: No effect on the user's other tmux clients ─────────────────────
  it("IDLE-32: pausing on one control-mode client does not pause output for another", async () => {
    const session = uniqueName("idle32");
    // Client 1: suppression on, no sinks → it pauses every idle pane (for itself).
    const c1 = await createClient(socketName, session, {
      idlePaneSuppression: true,
    });
    clients.push(c1.client);

    // Client 2: a SECOND control-mode client on the same session, no
    // suppression, with a serverScope sink that records arrivals.
    const c2 = await attachRecorded(socketName, session);
    clients.push(c2.client);
    const arrived: number[] = [];
    c2.client.attachBytesSink(makeRecordingSink(arrived), {
      scope: serverScope,
    });

    const paneX = (await listAllPanes(c1.client))[0].paneId;
    // Client 1 pauses %X for itself.
    await waitForAction(c1.sent, paneX, PaneAction.Pause);

    // Drive output; client 2 (which never paused) must still receive it.
    await sendOutputToPane(c2.client, paneX);
    await waitForArrival(arrived, paneX);
  }, 20000);
});
