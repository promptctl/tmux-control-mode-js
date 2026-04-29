// tests/integration/pane-session.test.ts
// Integration tests for PaneSession against a real tmux process.
//
// Covers the architectural invariants the demo's PaneTerminal got wrong and
// PaneSession is meant to fix:
//   1. Seed→live without dropped or duplicated bytes (the demo could lose
//      events that arrived between attach() and the buffer drain).
//   2. Seed failure surfaces a typed `seed-error` event instead of being
//      console.error'd into oblivion.
//   3. dispose() halts sink writes immediately — no late callbacks land
//      after the consumer has torn down.

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { execSync } from "node:child_process";
import { spawnTmux } from "../../src/transport/spawn.js";
import { TmuxClient } from "../../src/client.js";
import { PaneSession, type TerminalSink } from "../../src/pane-session.js";

const RUN_INTEGRATION = process.env.TMUX_INTEGRATION === "1";

// ---------------------------------------------------------------------------
// Helpers — pattern matches tests/integration/client.test.ts
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
    /* already gone */
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
  return new Promise<TmuxClient>((resolve) => {
    const handler = (): void => {
      client.off("session-changed", handler);
      resolve(client);
    };
    client.on("session-changed", handler);
  });
}

/** Build a recording sink whose buffer can be inspected by the test. */
function recordingSink(): TerminalSink & {
  readonly chunks: Uint8Array[];
  readonly resizes: { cols: number; rows: number }[];
  text(): string;
} {
  const chunks: Uint8Array[] = [];
  const resizes: { cols: number; rows: number }[] = [];
  const decoder = new TextDecoder("utf-8", { fatal: false });
  return {
    chunks,
    resizes,
    write(bytes) {
      chunks.push(bytes);
    },
    resize(cols, rows) {
      resizes.push({ cols, rows });
    },
    onData() {
      // The recording sink doesn't synthesize keystrokes; return a no-op
      // disposable so PaneSession can still register a listener.
      return { dispose: () => undefined };
    },
    focus() {
      /* no-op for headless sink */
    },
    text() {
      // Concatenate captured chunks for easier substring assertions.
      const total = chunks.reduce((n, c) => n + c.byteLength, 0);
      const out = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) {
        out.set(c, off);
        off += c.byteLength;
      }
      return decoder.decode(out);
    },
  };
}

async function getActivePaneId(client: TmuxClient): Promise<number> {
  const list = await client.execute("list-panes");
  const match = list.output.join("\n").match(/%(\d+)/);
  if (match === null) throw new Error("no pane id in list-panes output");
  return parseInt(match[1], 10);
}

/** Wait until the next event-loop tick where the predicate becomes true. */
async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!RUN_INTEGRATION)("PaneSession seed→live", () => {
  let sessionName: string;
  let socketName: string;
  let client: TmuxClient | null = null;

  beforeEach(() => {
    socketName = uniqueSocket("pane-session");
  });

  afterEach(() => {
    client?.close();
    client = null;
    killServer(socketName);
  });

  it(
    "seed contains prior pane content and cursor lands at queried position",
    async () => {
      sessionName = uniqueSession("ps-seed");
      const c = await createSession(socketName, sessionName);
      client = c;
      const paneId = await getActivePaneId(c);

      // Plant some recognizable content in the pane BEFORE attach so it
      // shows up in the capture-pane snapshot.
      await c.execute(`send-keys -t %${paneId} 'echo SEED-MARKER' Enter`);
      // Tiny wait so the shell processes the keystroke and tmux's
      // capture-pane sees the result.
      await new Promise((r) => setTimeout(r, 200));

      const sink = recordingSink();
      const session = new PaneSession({ client: c, paneId, sink });
      await session.attach();

      const transcript = sink.text();
      expect(transcript).toContain("SEED-MARKER");

      // The seed write must include an ANSI CUP escape so the cursor
      // lands at tmux's reported position rather than at the bottom of
      // the captured snapshot.
      expect(transcript).toMatch(/\x1b\[\d+;\d+H/);

      session.dispose();
    },
    15000,
  );

  it(
    "live events flow to sink after attach completes",
    async () => {
      sessionName = uniqueSession("ps-live");
      const c = await createSession(socketName, sessionName);
      client = c;
      const paneId = await getActivePaneId(c);

      const sink = recordingSink();
      const session = new PaneSession({ client: c, paneId, sink });
      await session.attach();
      expect(session.currentState).toBe("live");

      const sizeBeforeLive = sink.chunks.length;
      await c.execute(`send-keys -t %${paneId} 'echo LIVE-MARKER' Enter`);
      await waitFor(
        () => sink.text().includes("LIVE-MARKER"),
        5000,
      );

      // Live bytes arrived AFTER the seed drain, so they must be additional
      // chunks not part of the snapshot batch.
      expect(sink.chunks.length).toBeGreaterThan(sizeBeforeLive);
      session.dispose();
    },
    15000,
  );

  it(
    "events that arrive during the seed window are not dropped or duplicated",
    async () => {
      sessionName = uniqueSession("ps-window");
      const c = await createSession(socketName, sessionName);
      client = c;
      const paneId = await getActivePaneId(c);

      const sink = recordingSink();
      const session = new PaneSession({ client: c, paneId, sink });

      // Kick off attach() but don't await yet — fire a marker BEFORE the
      // seed completes so the byte lands during the buffering window.
      const attachPromise = session.attach();
      await c.execute(`send-keys -t %${paneId} 'echo SEED-WINDOW-MARKER' Enter`);
      await attachPromise;

      // After the seed drain, the marker must be present exactly once
      // somewhere in the transcript — either inside the captured snapshot
      // (if the keystroke was processed before capture-pane returned) or
      // appended after the drain (if it arrived during the seed window).
      // [LAW:dataflow-not-control-flow] We don't care which path it took;
      // we care that the byte landed exactly once.
      await waitFor(
        () => sink.text().includes("SEED-WINDOW-MARKER"),
        5000,
      );
      const occurrences = sink.text().split("SEED-WINDOW-MARKER").length - 1;
      expect(occurrences).toBeGreaterThan(0);
      // Allow 1 or 2: the prompt rendering + the echo output is tmux
      // shell-dependent. The invariant is "no duplication of the same
      // byte event" — we'd see 3+ if the buffer drained AND the live path
      // wrote the same chunk.
      expect(occurrences).toBeLessThanOrEqual(2);

      session.dispose();
    },
    15000,
  );

  it(
    "seed-error fires when the pane id does not exist",
    async () => {
      sessionName = uniqueSession("ps-err");
      const c = await createSession(socketName, sessionName);
      client = c;

      const sink = recordingSink();
      // 99999 is comfortably outside any real paneId tmux will allocate.
      const session = new PaneSession({
        client: c,
        paneId: 99999,
        sink,
      });

      let seedError: unknown = null;
      session.on("seed-error", ({ cause }) => {
        seedError = cause;
      });

      await session.attach();
      expect(seedError).not.toBeNull();
      // Library transitions to live so subsequent real bytes (if any)
      // would still flow rather than getting silently buffered forever.
      expect(session.currentState).toBe("live");
      session.dispose();
    },
    15000,
  );

  it(
    "dispose() halts sink writes immediately",
    async () => {
      sessionName = uniqueSession("ps-dispose");
      const c = await createSession(socketName, sessionName);
      client = c;
      const paneId = await getActivePaneId(c);

      const sink = recordingSink();
      const session = new PaneSession({ client: c, paneId, sink });
      await session.attach();

      const writesAtDispose = sink.chunks.length;
      session.dispose();

      // Trigger a tmux output event after dispose; it must not reach the
      // sink. Wait long enough for the event to round-trip if it would.
      await c.execute(`send-keys -t %${paneId} 'echo POST-DISPOSE' Enter`);
      await new Promise((r) => setTimeout(r, 400));

      expect(sink.chunks.length).toBe(writesAtDispose);
      expect(sink.text()).not.toContain("POST-DISPOSE");
    },
    15000,
  );
});
