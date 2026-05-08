// tests/integration/pane-stream.test.ts
//
// Integration coverage for `PaneStream` against a real tmux process.
// Verifies the load-bearing pieces that the bench/unit suites cannot:
//
//  1. capture-pane + display-message round-trip during seed produces
//     a non-empty seed payload at the sink.
//  2. Per-pane format subscription (`pane_width;pane_height`) emits
//     a `subscription-changed` event whose value the stream parses into
//     a `sink.resize(cols, rows)` call when the pane geometry changes.
//
// [LAW:verifiable-goals] Both gates are bounded; both produce a deterministic
// pass/fail without operator intervention. Skipped when TMUX_INTEGRATION!=1.

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { execSync } from "node:child_process";
import { spawnTmux } from "../../src/transport/spawn.js";
import { TmuxClient } from "../../src/client.js";
import { PaneStream } from "../../packages/pane-terminal/src/stream/index.js";
import type {
  PaneStreamClient,
  TerminalSink,
} from "../../packages/pane-terminal/src/stream/index.js";
import type { SeedCursor } from "../../packages/pane-terminal/src/sink/index.js";

const RUN_INTEGRATION = process.env.TMUX_INTEGRATION === "1";

function uniqueSocket(prefix: string): string {
  return `tmux-js-pstream-${prefix}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 7)}`;
}

function uniqueSession(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function tmuxCmd(socket: string, args: string): string {
  return `tmux -L ${socket} ${args}`;
}

function killServer(socket: string): void {
  try {
    execSync(tmuxCmd(socket, "kill-server"), { stdio: "ignore" });
  } catch {
    /* already gone */
  }
}

function createSession(socket: string, session: string): Promise<TmuxClient> {
  // Start the session at a known geometry so the resize test has a clear
  // delta to assert against.
  execSync(tmuxCmd(socket, `new-session -d -s ${session} -x 80 -y 24`), {
    stdio: "ignore",
  });
  const transport = spawnTmux(["attach-session", "-t", session], {
    socketPath: socket,
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

async function getPrimaryPaneId(client: TmuxClient): Promise<number> {
  const r = await client.execute("display-message -p '#{pane_id}'");
  const line = r.output[0] ?? "";
  const m = line.match(/^%(\d+)$/);
  if (m === null) throw new Error(`unexpected pane id reply: ${line}`);
  return Number(m[1]);
}

class CollectorSink implements TerminalSink {
  seedCalls: { text: string; cursor: SeedCursor | null }[] = [];
  resizeCalls: { cols: number; rows: number }[] = [];
  writeCount = 0;
  seed(text: string, cursor: SeedCursor | null): void {
    this.seedCalls.push({ text, cursor });
  }
  write(_bytes: Uint8Array): void {
    this.writeCount += 1;
  }
  resize(cols: number, rows: number): void {
    this.resizeCalls.push({ cols, rows });
  }
  dispose(): void {
    /* no-op */
  }
}

describe.skipIf(!RUN_INTEGRATION)(
  "PaneStream — integration (tmux ≥3.2)",
  () => {
    let socket: string;
    let session: string;
    let client: TmuxClient;
    let stream: PaneStream | null;

    beforeEach(() => {
      socket = uniqueSocket("ps");
      stream = null;
    });

    afterEach(() => {
      stream?.dispose();
      client?.close();
      killServer(socket);
    });

    it("attach() seeds with capture-pane output + cursor", async () => {
      session = uniqueSession("seed");
      client = await createSession(socket, session);
      const paneId = await getPrimaryPaneId(client);

      // Put a known marker on the pane so the seed is non-empty.
      await client.sendKeys(`%${paneId}`, "echo HELLO_SEED_MARKER");
      await client.execute(`send-keys -t %${paneId} Enter`);
      // Give the shell a moment to render.
      await new Promise((r) => setTimeout(r, 200));

      const sink = new CollectorSink();
      stream = new PaneStream({
        client: client as unknown as PaneStreamClient,
        paneId,
      });
      stream.attach(sink);

      // Wait for capture + cursor responses + state transition.
      for (let i = 0; i < 20 && stream.state !== "live"; i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(stream.state).toBe("live");
      expect(sink.seedCalls).toHaveLength(1);
      expect(sink.seedCalls[0].text.length).toBeGreaterThan(0);
      // Cursor should be present and inside the 80x24 viewport.
      const cursor = sink.seedCalls[0].cursor;
      expect(cursor).not.toBeNull();
      expect(cursor!.x).toBeGreaterThanOrEqual(0);
      expect(cursor!.y).toBeGreaterThanOrEqual(0);
    }, 15000);

    it("per-pane subscribeRaw of pane_width;pane_height fires sink.resize on geometry change", async () => {
      session = uniqueSession("size");
      client = await createSession(socket, session);
      const paneId = await getPrimaryPaneId(client);

      const sink = new CollectorSink();
      stream = new PaneStream({
        client: client as unknown as PaneStreamClient,
        paneId,
      });
      stream.attach(sink);
      // Wait for live + the initial subscription-changed (tmux delivers
      // the current value on subscribe).
      for (let i = 0; i < 20 && stream.state !== "live"; i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      // Initial subscription delivery — at least one resize call.
      for (let i = 0; i < 20 && sink.resizeCalls.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(sink.resizeCalls.length).toBeGreaterThanOrEqual(1);
      const initial = sink.resizeCalls[sink.resizeCalls.length - 1];
      expect(initial.cols).toBe(80);
      expect(initial.rows).toBe(24);

      // Resize the client. tmux re-evaluates layout and the format
      // subscription fires with the new value.
      await client.setSize(120, 30);
      for (
        let i = 0;
        i < 30 &&
        (sink.resizeCalls.length === 1 ||
          sink.resizeCalls[sink.resizeCalls.length - 1].cols !== 120);
        i++
      ) {
        await new Promise((r) => setTimeout(r, 50));
      }
      const after = sink.resizeCalls[sink.resizeCalls.length - 1];
      expect(after.cols).toBe(120);
      expect(after.rows).toBe(30);
    }, 15000);
  },
);
