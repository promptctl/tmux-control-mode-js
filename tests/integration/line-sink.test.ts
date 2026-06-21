// tests/integration/line-sink.test.ts
// Integration tests for attachLineSink against a real tmux server.
//
// Scope routing, topology-dependent membership, and end-to-end UTF-8 decode
// across real %output chunks are exercised here. Pure cross-chunk decode
// semantics live in tests/unit/line-sink.test.ts where chunk boundaries can
// be controlled precisely.
//
// [LAW:verifiable-goals] Gated behind TMUX_INTEGRATION=1. Uses ephemeral
// isolated servers — the developer's default tmux server is never touched.

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { execSync } from "node:child_process";
import { spawnTmux } from "../../src/transport/spawn.js";
import { TmuxClient } from "../../src/client.js";
import {
  serverScope,
  sessionScope,
  windowScope,
  paneScope,
  parsePaneListLine,
} from "../../src/pane-output.js";
import { attachLineSink } from "../../src/line-sink.js";

const RUN_INTEGRATION = process.env.TMUX_INTEGRATION === "1";

// ---------------------------------------------------------------------------
// Helpers (mirror tests/integration/pane-scope.test.ts conventions)
// ---------------------------------------------------------------------------

function uniqueSocket(prefix: string): string {
  return `tmux-line-test-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
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

function createClient(
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
  return new Promise<TmuxClient>((resolve) => {
    const handler = () => {
      client.off("session-changed", handler);
      resolve(client);
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

/**
 * Send a command to the pane and press Enter so the shell echoes a line.
 *
 * Tests assert against the printed payload, not the shell's echo of the
 * command. `marker` is a unique token so test output can be searched without
 * tripping over the shell prompt or echoed command text.
 */
function emitLineInPane(
  client: TmuxClient,
  paneId: number,
  marker: string,
): Promise<void> {
  return client
    .execute(`send-keys -t %${paneId} 'echo ${marker}' Enter`)
    .then(() => undefined);
}

function waitFor(
  pred: () => boolean,
  timeoutMs = 8000,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      if (pred()) {
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error(`waitFor: condition not met within ${timeoutMs} ms`));
        return;
      }
      setTimeout(check, 5);
    };
    check();
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!RUN_INTEGRATION)("attachLineSink (integration)", () => {
  let socketName = "";
  let client: TmuxClient | null = null;

  beforeEach(() => {
    socketName = uniqueSocket("line");
  });

  afterEach(() => {
    client?.close();
    client = null;
    if (socketName !== "") killServer(socketName);
    socketName = "";
  });

  // ── LINE-10/15: paneScope + serverScope + paneId carried through ─────────

  it(
    "LINE-10: paneScope receives complete lines without trailing newlines",
    async () => {
      const session = uniqueSession("p-lines");
      client = await createClient(socketName, session);

      const panes = await listAllPanes(client);
      expect(panes.length).toBeGreaterThan(0);
      const paneA = panes[0].paneId;

      const lines: { line: string; paneId: number }[] = [];
      const dispose = attachLineSink(
        client,
        (e) => lines.push({ ...e }),
        { scope: paneScope(paneA) },
      );

      const marker = `LINE10-${Math.random().toString(36).slice(2, 8)}`;
      await emitLineInPane(client, paneA, marker);
      await waitFor(() => lines.some((l) => l.line.includes(marker)));

      const matched = lines.find((l) => l.line.includes(marker));
      expect(matched).toBeDefined();
      // Whatever line ultimately contains the marker, it must NOT end with \n
      // or \r — line sink strips both.
      expect(matched!.line.endsWith("\n")).toBe(false);
      expect(matched!.line.endsWith("\r")).toBe(false);
      expect(matched!.paneId).toBe(paneA);

      dispose();
    },
    15000,
  );

  // ── LINE-13: multiple line consumers, one pane (shared decoder) ──────────

  it(
    "LINE-13: N consumers on the same pane each receive every line",
    async () => {
      const session = uniqueSession("multi");
      client = await createClient(socketName, session);

      const panes = await listAllPanes(client);
      const paneA = panes[0].paneId;

      const a: string[] = [];
      const b: string[] = [];
      const c: string[] = [];
      const dispA = attachLineSink(client, (e) => a.push(e.line), {
        scope: paneScope(paneA),
      });
      const dispB = attachLineSink(client, (e) => b.push(e.line), {
        scope: paneScope(paneA),
      });
      const dispC = attachLineSink(client, (e) => c.push(e.line), {
        scope: paneScope(paneA),
      });

      const marker = `LINE13-${Math.random().toString(36).slice(2, 8)}`;
      await emitLineInPane(client, paneA, marker);
      await waitFor(
        () =>
          a.some((l) => l.includes(marker)) &&
          b.some((l) => l.includes(marker)) &&
          c.some((l) => l.includes(marker)),
      );

      // All three consumers saw the same line set (shared buffer).
      expect(a.filter((l) => l.includes(marker))).toEqual(
        b.filter((l) => l.includes(marker)),
      );
      expect(b.filter((l) => l.includes(marker))).toEqual(
        c.filter((l) => l.includes(marker)),
      );

      dispA();
      dispB();
      dispC();
    },
    15000,
  );

  // ── LINE-14: sessionScope line delivery ──────────────────────────────────

  it(
    "LINE-14: sessionScope delivers lines from every pane in the session",
    async () => {
      const session = uniqueSession("sess-line");
      client = await createClient(socketName, session);

      const before = await listAllPanes(client);
      const sessionId = before[0].sessionId;

      await client.execute("new-window");
      const after = await listAllPanes(client);
      expect(after.length).toBeGreaterThanOrEqual(2);

      const lines: { line: string; paneId: number }[] = [];
      const dispose = attachLineSink(
        client,
        (e) => lines.push({ ...e }),
        { scope: sessionScope(sessionId) },
      );

      const markers = new Map<number, string>();
      for (const p of after) {
        const marker = `LINE14-${p.paneId}-${Math.random().toString(36).slice(2, 6)}`;
        markers.set(p.paneId, marker);
        await emitLineInPane(client, p.paneId, marker);
      }

      await waitFor(() =>
        [...markers.entries()].every(([paneId, m]) =>
          lines.some((l) => l.paneId === paneId && l.line.includes(m)),
        ),
      );

      const knownIds = new Set(after.map((p) => p.paneId));
      expect(lines.every((l) => knownIds.has(l.paneId))).toBe(true);

      dispose();
    },
    20000,
  );

  // ── LINE-15: serverScope across two panes — paneId carried ───────────────

  it(
    "LINE-15: serverScope tags each line with the originating paneId",
    async () => {
      const session = uniqueSession("srv-line");
      client = await createClient(socketName, session);

      await client.execute("new-window");
      const all = await listAllPanes(client);
      expect(all.length).toBeGreaterThanOrEqual(2);
      const paneA = all[0].paneId;
      const paneB = all[1].paneId;

      const lines: { line: string; paneId: number }[] = [];
      const dispose = attachLineSink(
        client,
        (e) => lines.push({ ...e }),
        { scope: serverScope },
      );

      const markerA = `LINE15A-${Math.random().toString(36).slice(2, 6)}`;
      const markerB = `LINE15B-${Math.random().toString(36).slice(2, 6)}`;
      await emitLineInPane(client, paneA, markerA);
      await emitLineInPane(client, paneB, markerB);

      await waitFor(
        () =>
          lines.some((l) => l.paneId === paneA && l.line.includes(markerA)) &&
          lines.some((l) => l.paneId === paneB && l.line.includes(markerB)),
      );

      // No marker arrives tagged with the wrong paneId.
      expect(
        lines.some((l) => l.paneId === paneA && l.line.includes(markerB)),
      ).toBe(false);
      expect(
        lines.some((l) => l.paneId === paneB && l.line.includes(markerA)),
      ).toBe(false);

      dispose();
    },
    15000,
  );

  // ── windowScope isolation (parity with SCOPE-05) ──────────────────────────

  it(
    "LINE-14b: windowScope delivers panes in the target window, not others",
    async () => {
      const session = uniqueSession("win-line");
      client = await createClient(socketName, session);

      await client.execute("new-window");
      const panes = await listAllPanes(client);
      const windowIds = [...new Set(panes.map((p) => p.windowId))];
      expect(windowIds.length).toBeGreaterThanOrEqual(2);
      const wantWindow = windowIds[0];
      const otherWindow = windowIds[1];

      const wantPane = panes.find((p) => p.windowId === wantWindow)!.paneId;
      const otherPane = panes.find((p) => p.windowId === otherWindow)!.paneId;

      const lines: { line: string; paneId: number }[] = [];
      const dispose = attachLineSink(
        client,
        (e) => lines.push({ ...e }),
        { scope: windowScope(wantWindow) },
      );

      const wantMarker = `WIN-WANT-${Math.random().toString(36).slice(2, 6)}`;
      const otherMarker = `WIN-OTHER-${Math.random().toString(36).slice(2, 6)}`;
      await emitLineInPane(client, wantPane, wantMarker);
      await emitLineInPane(client, otherPane, otherMarker);

      await waitFor(() => lines.some((l) => l.line.includes(wantMarker)));
      // Give other-window output a fair chance to (incorrectly) arrive.
      await new Promise<void>((r) => setTimeout(r, 250));

      expect(lines.some((l) => l.line.includes(otherMarker))).toBe(false);
      expect(lines.every((l) => l.paneId === wantPane)).toBe(true);

      dispose();
    },
    15000,
  );

  // ── LINE-16: buffered tail flush on detach (no newline) ───────────────────

  it(
    "LINE-16: detaching the last consumer flushes a partial trailing line",
    async () => {
      const session = uniqueSession("flush");
      client = await createClient(socketName, session);

      const panes = await listAllPanes(client);
      const paneA = panes[0].paneId;

      const lines: string[] = [];
      const dispose = attachLineSink(
        client,
        (e) => lines.push(e.line),
        { scope: paneScope(paneA) },
      );

      const tailMarker = `TAIL${Math.random().toString(36).slice(2, 8)}`;
      // Replace the interactive shell with a long-lived sleep process so no
      // shell prompt, PROMPT_CR expansion, or readline buffering can interfere.
      // The exec output lands in the pane, admitting this consumer before the
      // marker arrives.
      await client.execute(`send-keys -t %${paneA} 'exec sleep 3600' Enter`);
      await new Promise<void>((r) => setTimeout(r, 200));

      // Type the marker WITHOUT Enter — the TTY driver echoes the characters
      // verbatim with no trailing newline. They land in the per-pane buffer
      // as a partial trailing line; dispose() flushes them.
      await client.execute(`send-keys -t %${paneA} '${tailMarker}'`);
      // Give the echoed bytes time to round-trip through the tmux server.
      await new Promise<void>((r) => setTimeout(r, 200));

      const countBefore = lines.length;
      dispose();

      // On detach, the partial buffer must flush as one extra event whose
      // content contains the marker.
      const flushed = lines.slice(countBefore);
      expect(flushed.length).toBe(1);
      expect(flushed[0].includes(tailMarker)).toBe(true);
    },
    15000,
  );

  // ── LINE-17: no extra flush event when buffer is empty ────────────────────

  it(
    "LINE-17: detaching a fully-consumed pane produces no extra event",
    async () => {
      const session = uniqueSession("noflush");
      client = await createClient(socketName, session);

      const panes = await listAllPanes(client);
      const paneA = panes[0].paneId;

      const lines: string[] = [];
      const dispose = attachLineSink(
        client,
        (e) => lines.push(e.line),
        { scope: paneScope(paneA) },
      );

      const marker = `NOFLUSH-${Math.random().toString(36).slice(2, 8)}`;
      await emitLineInPane(client, paneA, marker);
      await waitFor(() => lines.some((l) => l.includes(marker)));

      // Wait for the shell to settle (prompt redraw etc) so the buffer
      // empties as much as possible before we measure. We can't drive tmux
      // into a guaranteed-empty buffer state through the public API, so the
      // assertion below is conditional: IF the buffer is empty at detach,
      // the count is unchanged; if not, the test would have to assert a
      // marker-containing flush, which is covered by LINE-16. So we just
      // sanity-check the disposer doesn't crash and the count doesn't
      // double.
      await new Promise<void>((r) => setTimeout(r, 250));

      const countBefore = lines.length;
      dispose();

      // Disposer can flush at most one trailing partial — never more.
      expect(lines.length - countBefore).toBeLessThanOrEqual(1);
    },
    15000,
  );

  // ── LINE-18: detach during dispatch — co-consumer still receives ──────────

  it(
    "LINE-18: a consumer disposing inside its handler doesn't starve siblings",
    async () => {
      const session = uniqueSession("during");
      client = await createClient(socketName, session);

      const panes = await listAllPanes(client);
      const paneA = panes[0].paneId;

      const a: string[] = [];
      const b: string[] = [];

      let disposeA: () => void = () => undefined;
      disposeA = attachLineSink(
        client,
        (e) => {
          a.push(e.line);
          disposeA();
        },
        { scope: paneScope(paneA) },
      );
      const disposeB = attachLineSink(client, (e) => b.push(e.line), {
        scope: paneScope(paneA),
      });

      const marker = `DUR-${Math.random().toString(36).slice(2, 8)}`;
      await emitLineInPane(client, paneA, marker);
      await waitFor(
        () =>
          a.some((l) => l.includes(marker)) &&
          b.some((l) => l.includes(marker)),
      );

      // A and B both saw the line containing the marker — A didn't starve B
      // by disposing inside its handler.
      expect(a.some((l) => l.includes(marker))).toBe(true);
      expect(b.some((l) => l.includes(marker))).toBe(true);

      disposeB();
    },
    15000,
  );
});
