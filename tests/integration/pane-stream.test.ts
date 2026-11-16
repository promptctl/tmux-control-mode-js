// tests/integration/pane-stream.test.ts
//
// Integration coverage for `PaneStream` against a real tmux process.
// Verifies the load-bearing pieces that the bench/unit suites cannot:
//
//  1. The seed's command line produces a non-empty seed payload at the sink.
//  2. Per-pane format subscription (`pane_width;pane_height`) emits
//     a `subscription-changed` event whose value the stream parses into
//     a `sink.resize(cols, rows)` call when the pane geometry changes.
//  3. A seed taken while the pane prints draws each line once — over a
//     direct client and over a WebSocket bridge.
//
// [LAW:verifiable-goals] Every gate is bounded and produces a deterministic
// pass/fail without operator intervention. Skipped when TMUX_INTEGRATION!=1.

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { createServer } from "node:http";
import { WebSocket as WsClient, WebSocketServer } from "ws";
import { killTmuxServer } from "../helpers/reap-test-sockets.js";
import {
  uniqueSocket,
  uniqueName,
  attachSession,
  getPrimaryPaneId,
  readUntil,
  waitForPaneText,
} from "../helpers/integration.js";
import type { TmuxClient } from "../../src/client.js";
import { sendKeys } from "../../src/commands/index.js";
import { createWebSocketBridge } from "../../src/connectors/websocket/server.js";
import { WebSocketTmuxClient } from "../../src/connectors/websocket/client.js";
import type {
  BrowserWebSocketLike,
  ServerWebSocketLike,
} from "../../src/connectors/websocket/types.js";
import {
  PaneStream,
  type TerminalConnection,
} from "../../src/window-terminal/engine/pane-stream.js";
import type {
  TerminalSink,
  SeedCursor,
} from "../../src/window-terminal/engine/terminal-sink.js";

const RUN_INTEGRATION = process.env.TMUX_INTEGRATION === "1";

// Start sessions at a known geometry so the resize test has a clear delta to
// assert against.
function createSession(socket: string, session: string): Promise<TmuxClient> {
  return attachSession(socket, session, {
    newSessionFlags: ["-x", "80", "-y", "24"],
  });
}

async function paneSize(
  client: TmuxClient,
  paneId: number,
): Promise<{ cols: number; rows: number }> {
  const r = await client.execute(
    `display-message -p -t %${paneId} '#{pane_width} #{pane_height}'`,
  );
  const m = (r.output[0] ?? "").match(/^(\d+) (\d+)$/);
  if (m === null) throw new Error(`unexpected pane size reply: ${r.output}`);
  return { cols: Number(m[1]), rows: Number(m[2]) };
}

class CollectorSink implements TerminalSink {
  seedCalls: { byteLength: number; cursor: SeedCursor | null }[] = [];
  resizeCalls: { cols: number; rows: number }[] = [];
  writeCount = 0;
  seed(captured: Uint8Array, cursor: SeedCursor | null): void {
    // seed carries raw terminal bytes (may include 0x80-0xFF / invalid UTF-8),
    // so assert on byteLength rather than a lossy UTF-8 decode.
    this.seedCalls.push({ byteLength: captured.byteLength, cursor });
  }
  write(_bytes: Uint8Array): void {
    this.writeCount += 1;
  }
  resize(cols: number, rows: number): void {
    this.resizeCalls.push({ cols, rows });
  }
  clear(): void {
    this.seedCalls.length = 0;
    this.resizeCalls.length = 0;
    this.writeCount = 0;
  }
  isVisible(): boolean {
    return true;
  }
  dispose(): void {
    /* no-op */
  }
}

// What each seed draws as text, one transcript per seed: the screen's rows
// down to the cursor's, then every byte written after it. Escapes are
// stripped, so a pane printing plain lines reads back as those lines.
class TranscriptSink implements TerminalSink {
  readonly transcripts: string[] = [];
  private readonly decoder = new TextDecoder();
  seed(
    captured: Uint8Array,
    cursor: SeedCursor | null,
    trailing: readonly Uint8Array[],
  ): void {
    if (cursor === null) throw new Error("a seed arrived without a cursor");
    const rows = this.decoder
      .decode(captured)
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b(\[[0-9;?]*[A-Za-z]|[=>]|\([0-9A-Z])/g, "")
      .split("\r\n")
      .map((row) => row.trimEnd());
    const settled = rows.slice(0, cursor.row).filter((row) => row !== "");
    this.transcripts.push(
      settled.map((row) => `${row}\n`).join("") + (rows[cursor.row] ?? ""),
    );
    for (const chunk of trailing) this.write(chunk);
  }
  write(bytes: Uint8Array): void {
    const last = this.transcripts.length - 1;
    if (last < 0) return;
    this.transcripts[last] += this.decoder.decode(bytes).replace(/\r/g, "");
  }
  resize(): void {}
  isVisible(): boolean {
    return true;
  }
  dispose(): void {}
}

// Seeds `paneId` 20 times while it counts, and asserts each seed's
// transcript is an unbroken run of integers: a byte drawn twice repeats a
// number, a byte lost skips one.
async function expectSeedsDrawEachLineOnce(
  conn: TerminalConnection,
  paneId: number,
): Promise<void> {
  // The visible screen only, so the cursor row indexes the captured rows.
  const stream = new PaneStream({ client: conn, paneId, historyLines: 0 });
  try {
    const sink = new TranscriptSink();
    stream.attach(sink);
    await readUntil(
      () => stream.state,
      (state) => state === "live",
      "PaneStream never went live",
    );
    for (let i = 0; i < 20; i++) {
      await stream.reseed();
      await new Promise((r) => setTimeout(r, 15));
    }
    expect(stream.lastError).toBeNull();
    expect(sink.transcripts).toHaveLength(21);
    for (const transcript of sink.transcripts) {
      // The last line may still be printing.
      const lines = transcript.split("\n").slice(0, -1);
      expect(lines.length).toBeGreaterThan(1);
      const numbers = lines.map(Number);
      const breaks = numbers.flatMap((n, i) =>
        i > 0 && n !== numbers[i - 1] + 1 ? [`${numbers[i - 1]}→${n}`] : [],
      );
      expect(breaks).toEqual([]);
    }
  } finally {
    stream.dispose();
  }
}

// A pane counting up, one integer per line, as fast as the shell goes.
const COUNTER = "i=0; while [ $i -lt 2000000 ]; do echo $i; i=$((i+1)); done";

describe.skipIf(!RUN_INTEGRATION)(
  "PaneStream — integration (tmux ≥3.2)",
  () => {
    // Sentinel + per-test reset: socket is "" between tests so a beforeEach
    // that throws BEFORE assignment never makes afterEach run
    // `tmux -L <stale-or-undefined> list-sessions`/`kill-session` against an unrelated tmux
    // server (worst case: the user's real server, one literally named
    // `undefined`). The reset in afterEach below restores the invariant per
    // test — without it, a successful test would leave the previous socket
    // name visible to the next test's afterEach.
    let socket = "";
    let session: string;
    let client: TmuxClient;
    let stream: PaneStream | null;

    // Further teardown a test registers, run before the client closes.
    let teardown: (() => void | Promise<void>)[] = [];

    beforeEach(() => {
      socket = uniqueSocket("ps");
      stream = null;
      teardown = [];
    });

    afterEach(async () => {
      stream?.dispose();
      for (const step of teardown.reverse()) await step();
      client?.close();
      if (socket !== "") killTmuxServer(socket);
      socket = "";
    });

    // A browser client of `tmux` across a WebSocket bridge on a loopback
    // port, torn down with the test.
    async function bridgeTo(tmux: TmuxClient): Promise<WebSocketTmuxClient> {
      const bridge = createWebSocketBridge({ createClient: () => tmux });
      const http = createServer();
      const wss = new WebSocketServer({ server: http, path: "/tmux" });
      wss.on("connection", (ws, req) => {
        void bridge.handleConnection(ws as unknown as ServerWebSocketLike, {
          url: req.url,
          headers: {},
          remoteAddress: undefined,
        });
      });
      const port = await new Promise<number>((resolve) => {
        http.listen(0, "127.0.0.1", () => {
          const addr = http.address();
          resolve(typeof addr === "object" && addr !== null ? addr.port : 0);
        });
      });
      teardown.push(async () => {
        await bridge.shutdown(1_000);
        await new Promise<void>((r) => wss.close(() => r()));
        await new Promise<void>((r) => http.close(() => r()));
      });
      const browser = new WebSocketTmuxClient({
        url: `ws://127.0.0.1:${port}/tmux`,
        createWebSocket: (u) =>
          new WsClient(u) as unknown as BrowserWebSocketLike,
        heartbeatIntervalMs: 0,
      });
      teardown.push(() => browser.close());
      await readUntil(
        () => browser.connectionState.status,
        (status) => status === "ready",
        "the bridge never connected",
      );
      return browser;
    }

    // A session whose one pane is counting, once the count is on screen.
    async function countingPane(): Promise<number> {
      session = uniqueName("count");
      client = await attachSession(socket, session, {
        newSessionFlags: ["-x", "80", "-y", "24", COUNTER],
      });
      const paneId = await getPrimaryPaneId(client);
      await waitForPaneText(client, paneId, "1000");
      return paneId;
    }

    it("a seed taken while the pane prints draws each line once", async () => {
      const paneId = await countingPane();
      await expectSeedsDrawEachLineOnce(client, paneId);
    }, 30000);

    it("a seed taken while the pane prints draws each line once over a WebSocket bridge", async () => {
      const paneId = await countingPane();
      await expectSeedsDrawEachLineOnce(await bridgeTo(client), paneId);
    }, 30000);

    it("attach() seeds with capture-pane output + cursor", async () => {
      session = uniqueName("seed");
      client = await createSession(socket, session);
      const paneId = await getPrimaryPaneId(client);

      // Put a known marker on the pane so the seed is non-empty. printf
      // assembles it, so only the command's output, not the typed command
      // line, carries the whole marker.
      await sendKeys(client, `%${paneId}`, "printf 'HELLO_%s\\n' SEED_MARKER");
      await client.execute(`send-keys -t %${paneId} Enter`);
      await waitForPaneText(client, paneId, "HELLO_SEED_MARKER");

      const sink = new CollectorSink();
      stream = new PaneStream({
        client,
        paneId,
      });
      stream.attach(sink);

      // Wait for capture + cursor responses + state transition.
      await readUntil(
        () => stream!.state,
        (state) => state === "live",
        "PaneStream never went live",
      );
      expect(sink.seedCalls).toHaveLength(1);
      expect(sink.seedCalls[0].byteLength).toBeGreaterThan(0);
      // Cursor should be present and inside the 80x24 viewport.
      const cursor = sink.seedCalls[0].cursor;
      expect(cursor).not.toBeNull();
      expect(cursor!.col).toBeGreaterThanOrEqual(0);
      expect(cursor!.row).toBeGreaterThanOrEqual(0);
    }, 15000);

    it("per-pane subscribeRaw of pane_width;pane_height fires sink.resize on geometry change", async () => {
      session = uniqueName("size");
      client = await createSession(socket, session);
      const paneId = await getPrimaryPaneId(client);

      const sink = new CollectorSink();
      stream = new PaneStream({
        client,
        paneId,
      });
      stream.attach(sink);
      // Wait for live + the initial subscription-changed (tmux delivers
      // the current value on subscribe).
      await readUntil(
        () => stream!.state,
        (state) => state === "live",
        "PaneStream never went live",
      );
      // Initial subscription delivery — at least one resize call.
      await readUntil(
        () => sink.resizeCalls,
        (calls) => calls.length > 0,
        "no resize reached the sink",
      );
      // The expected geometry is what tmux reports for the pane, not the
      // requested size: tmux 3.2 gives an 80x24 session a 23-row pane.
      expect(sink.resizeCalls[sink.resizeCalls.length - 1]).toEqual(
        await paneSize(client, paneId),
      );

      // Resize the client. tmux re-evaluates layout and the format
      // subscription fires with the new value.
      const priorCalls = sink.resizeCalls.length;
      await client.setSize(120, 30);
      // The requested height lands, less at most the status line's row
      // (tmux 3.2 takes it from the initial session but not after setSize).
      const since = await readUntil(
        () => sink.resizeCalls.slice(priorCalls),
        (seen) => {
          const last = seen.at(-1);
          return last !== undefined && last.cols === 120 && last.rows >= 30 - 1;
        },
        "the sink never saw the 120x30 resize",
      );
      const after = since[since.length - 1];
      expect(after.rows).toBeLessThanOrEqual(30);
      expect(after).toEqual(await paneSize(client, paneId));
    }, 15000);
  },
);
