// tests/integration/tmux-model.test.ts
// Integration tests for TmuxModel against a real tmux process.
//
// [LAW:behavior-not-structure] Tests assert the contract of TmuxModel:
// `ready` fires once a populated snapshot exists; structural changes
// fire `change` with the right diff payload; the resize fast-path
// surfaces `panes.dimChanged` within the fast-path window; dispose
// cleans up; two instances on one client don't collide.

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { execSync } from "node:child_process";
import { spawnTmux } from "../../src/transport/spawn.js";
import { TmuxClient } from "../../src/client.js";
import { TmuxModel } from "../../src/model/tmux-model.js";
import type { TmuxDiff, TmuxSnapshot } from "../../src/model/types.js";

const RUN_INTEGRATION = process.env.TMUX_INTEGRATION === "1";

// ---------------------------------------------------------------------------
// Test harness — same pattern as tests/integration/client.test.ts
// ---------------------------------------------------------------------------

function uniqueSocket(prefix: string): string {
  return `tmux-js-test-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
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
    // Already gone.
  }
}

function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

function createSession(
  socketName: string,
  sessionName: string,
): Promise<TmuxClient> {
  execSync(
    tmuxCmd(socketName, `new-session -d -s ${shellQuote(sessionName)}`),
    { stdio: "ignore" },
  );
  const transport = spawnTmux(["attach-session", "-t", sessionName], {
    socketPath: socketName,
  });
  const client = new TmuxClient(transport);
  return new Promise<TmuxClient>((resolve) => {
    const handler = () => {
      client.off("session-changed", handler);
      resolve(client);
    };
    client.on("session-changed", handler);
  });
}

/**
 * Wait for the model's first `ready` event. Resolves with the snapshot at
 * ready time. Times out via the per-test timeout.
 */
function waitReady(model: TmuxModel): Promise<TmuxSnapshot> {
  return new Promise((resolve) => {
    const handle = model.on("ready", () => {
      handle.dispose();
      resolve(model.snapshot());
    });
  });
}

/** Wait for the next `change` event whose diff predicate returns true. */
function waitForDiff(
  model: TmuxModel,
  predicate: (d: TmuxDiff) => boolean,
): Promise<TmuxDiff> {
  return new Promise((resolve) => {
    const handle = model.on("change", (d) => {
      if (predicate(d)) {
        handle.dispose();
        resolve(d);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// 1. Bootstrap & ready
// ---------------------------------------------------------------------------

describe.skipIf(!RUN_INTEGRATION)("TmuxModel — bootstrap", () => {
  let sessionName: string;
  let socketName: string;
  let client: TmuxClient | null = null;
  let model: TmuxModel | null = null;

  beforeEach(() => {
    socketName = uniqueSocket("model-boot");
  });

  afterEach(() => {
    model?.dispose();
    model = null;
    client?.close();
    client = null;
    killServer(socketName);
  });

  it(
    "ready fires once with sessions/windows/panes populated",
    async () => {
      sessionName = uniqueSession("test-model-ready");
      client = await createSession(socketName, sessionName);
      model = new TmuxModel(client);

      const snap = await waitReady(model);
      expect(snap.sessions.length).toBeGreaterThan(0);
      const sess = snap.sessions[0];
      expect(sess.name).toBe(sessionName);
      expect(sess.windows.length).toBeGreaterThan(0);
      const win = sess.windows[0];
      expect(win.panes.length).toBeGreaterThan(0);
      expect(snap.clientSessionId).toBe(sess.id);
    },
    15000,
  );
});

// ---------------------------------------------------------------------------
// 2. Structural change events
// ---------------------------------------------------------------------------

describe.skipIf(!RUN_INTEGRATION)("TmuxModel — structural events", () => {
  let sessionName: string;
  let socketName: string;
  let client: TmuxClient | null = null;
  let model: TmuxModel | null = null;

  beforeEach(() => {
    socketName = uniqueSocket("model-struct");
  });

  afterEach(() => {
    model?.dispose();
    model = null;
    client?.close();
    client = null;
    killServer(socketName);
  });

  it(
    "kill-pane fires panes.removed and the next snapshot excludes the pane",
    async () => {
      sessionName = uniqueSession("test-kill-pane");
      client = await createSession(socketName, sessionName);
      model = new TmuxModel(client);
      await waitReady(model);
      // Split the window so we have at least two panes; killing the only
      // pane in a session would also kill the session (a bigger event).
      await client.execute("split-window -h");
      const splitDiff = await waitForDiff(
        model,
        (d) => d.panes.added.length > 0,
      );
      expect(splitDiff.panes.added.length).toBeGreaterThan(0);
      // Kill the new pane (the one that just got added).
      const newPaneId = splitDiff.panes.added[0];
      await client.execute(`kill-pane -t %${newPaneId}`);
      const killDiff = await waitForDiff(
        model,
        (d) => d.panes.removed.includes(newPaneId),
      );
      expect(killDiff.panes.removed).toContain(newPaneId);
      // Snapshot no longer contains the pane.
      const snap = model.snapshot();
      const allPaneIds: number[] = [];
      for (const s of snap.sessions) {
        for (const w of s.windows) {
          for (const p of w.panes) allPaneIds.push(p.id);
        }
      }
      expect(allPaneIds).not.toContain(newPaneId);
    },
    20000,
  );

  it(
    "new-window populates windows.added (and panes.added for the new pane)",
    async () => {
      sessionName = uniqueSession("test-new-window");
      client = await createSession(socketName, sessionName);
      model = new TmuxModel(client);
      await waitReady(model);
      const beforeWindowIds = model.snapshot().sessions[0].windows.map(
        (w) => w.id,
      );
      await client.execute("new-window");
      const diff = await waitForDiff(model, (d) => d.windows.added.length > 0);
      expect(diff.windows.added.length).toBeGreaterThan(0);
      const addedWindowId = diff.windows.added[0];
      expect(beforeWindowIds).not.toContain(addedWindowId);
      // The new window must materialise in the snapshot, with at least one pane.
      const snap = model.snapshot();
      const addedWindow = snap.sessions[0].windows.find(
        (w) => w.id === addedWindowId,
      );
      expect(addedWindow).toBeDefined();
      expect(addedWindow!.panes.length).toBeGreaterThan(0);
    },
    20000,
  );

  it(
    "rename-session populates sessions.renamed with old and new names",
    async () => {
      sessionName = uniqueSession("test-rename");
      client = await createSession(socketName, sessionName);
      model = new TmuxModel(client);
      await waitReady(model);
      const newName = `${sessionName}-renamed`;
      await client.execute(`rename-session -t ${shellQuote(sessionName)} ${shellQuote(newName)}`);
      const diff = await waitForDiff(
        model,
        (d) => d.sessions.renamed.length > 0,
      );
      expect(diff.sessions.renamed[0].oldName).toBe(sessionName);
      expect(diff.sessions.renamed[0].newName).toBe(newName);
    },
    20000,
  );
});

// ---------------------------------------------------------------------------
// 3. Resize fast-path
// ---------------------------------------------------------------------------

describe.skipIf(!RUN_INTEGRATION)("TmuxModel — resize fast-path", () => {
  let sessionName: string;
  let socketName: string;
  let client: TmuxClient | null = null;
  let model: TmuxModel | null = null;

  beforeEach(() => {
    socketName = uniqueSocket("model-resize");
  });

  afterEach(() => {
    model?.dispose();
    model = null;
    client?.close();
    client = null;
    killServer(socketName);
  });

  it(
    "resize-pane causes panes.dimChanged via the layout-change fast-path",
    async () => {
      sessionName = uniqueSession("test-resize");
      client = await createSession(socketName, sessionName);
      // Make the client window large enough that resize-pane has room to
      // grow/shrink panes.
      await client.setSize(200, 60);
      // Split so we have a non-fullscreen pane to resize.
      await client.execute("split-window -h");
      model = new TmuxModel(client);
      await waitReady(model);
      const before = model.snapshot();
      const win = before.sessions[0].windows.find((w) => w.active) ?? before.sessions[0].windows[0];
      const targetPane = win.panes.find((p) => p.active) ?? win.panes[0];
      const startWidth = targetPane.width;
      expect(startWidth).not.toBe(null);
      const newWidth = (startWidth ?? 80) - 10;
      await client.execute(
        `resize-pane -t %${targetPane.id} -x ${newWidth}`,
      );
      const diff = await waitForDiff(
        model,
        (d) => d.panes.dimChanged.includes(targetPane.id),
      );
      expect(diff.panes.dimChanged).toContain(targetPane.id);
      const after = model.snapshot();
      const afterPane = after.sessions[0].windows
        .flatMap((w) => w.panes)
        .find((p) => p.id === targetPane.id);
      expect(afterPane).toBeDefined();
      expect(afterPane!.width).toBe(newWidth);
    },
    20000,
  );
});

// ---------------------------------------------------------------------------
// 4. Robustness
// ---------------------------------------------------------------------------

describe.skipIf(!RUN_INTEGRATION)("TmuxModel — robustness", () => {
  let socketName: string;
  let client: TmuxClient | null = null;
  let model: TmuxModel | null = null;

  beforeEach(() => {
    socketName = uniqueSocket("model-rob");
  });

  afterEach(() => {
    model?.dispose();
    model = null;
    client?.close();
    client = null;
    killServer(socketName);
  });

  it(
    "session names containing `|` parse correctly (separator-collision regression)",
    async () => {
      // RS/US separators are C0 controls — `|` (the demo's old field
      // separator) in a session name no longer breaks the parser.
      const sessionName = `weird|name|${Date.now().toString(36)}`;
      client = await createSession(socketName, sessionName);
      model = new TmuxModel(client);
      const snap = await waitReady(model);
      const sess = snap.sessions.find((s) => s.name === sessionName);
      expect(sess).toBeDefined();
      expect(sess!.name).toBe(sessionName);
    },
    15000,
  );

  it(
    "two TmuxModel instances on one client both reach ready independently",
    async () => {
      const sessionName = uniqueSession("test-two-models");
      client = await createSession(socketName, sessionName);
      const a = new TmuxModel(client);
      const b = new TmuxModel(client);
      try {
        const [snapA, snapB] = await Promise.all([waitReady(a), waitReady(b)]);
        expect(snapA.sessions.length).toBeGreaterThan(0);
        expect(snapB.sessions.length).toBeGreaterThan(0);
        // Both see the same topology.
        expect(snapA.sessions[0].id).toBe(snapB.sessions[0].id);
      } finally {
        a.dispose();
        b.dispose();
      }
    },
    15000,
  );

  it(
    "dispose stops further snapshot/change emissions",
    async () => {
      const sessionName = uniqueSession("test-dispose");
      client = await createSession(socketName, sessionName);
      model = new TmuxModel(client);
      await waitReady(model);
      let changes = 0;
      model.on("change", () => changes++);
      const callsAtDispose = changes;
      model.dispose();
      // Trigger topology activity that would otherwise fire a change.
      await client.execute("split-window -h");
      await new Promise((r) => setTimeout(r, 300));
      await client.execute("kill-pane -t :.+");
      await new Promise((r) => setTimeout(r, 300));
      expect(changes).toBe(callsAtDispose);
    },
    15000,
  );
});
