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
import { PaneStream } from "../../src/window-terminal/engine/pane-stream.js";
import type { TerminalConnection } from "../../src/window-terminal/engine/pane-stream.js";
import { createServer } from "node:http";
import { WebSocket as WsClient, WebSocketServer } from "ws";
import { createWebSocketBridge } from "../../src/connectors/websocket/server.js";
import { WebSocketTmuxClient } from "../../src/connectors/websocket/client.js";
import type {
  BrowserWebSocketLike,
  ServerWebSocketLike,
} from "../../src/connectors/websocket/types.js";
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

    beforeEach(() => {
      socket = uniqueSocket("ps");
      stream = null;
    });

    afterEach(() => {
      stream?.dispose();
      client?.close();
      if (socket !== "") killTmuxServer(socket);
      socket = "";
    });

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

    // A seed on a pane printing while the capture is in flight draws every
    // byte once: the captured screen, then `trailing`, then live writes read
    // as one unbroken run of the pane's output. The pane counts up one integer
    // per line, so a byte drawn twice shows as a repeated number.
    async function expectSeedsDrawNothingTwice(
      conn: TerminalConnection,
      paneId: number,
    ): Promise<void> {
      const sink = new TranscriptSink();
      stream = new PaneStream({ client: conn, paneId, historyLines: 0 });
      stream.attach(sink);
      await readUntil(
        () => stream!.state,
        (state) => state === "live",
        "PaneStream never went live",
      );

      await sendKeys(
        conn,
        `%${paneId}`,
        "i=0; while [ $i -lt 2000000 ]; do i=$((i+1)); echo $i; done",
      );
      await conn.execute(`send-keys -t %${paneId} Enter`);
      // The counter has filled the screen once the bottom rows are numbers.
      await readUntil(
        () => sink.transcripts.at(-1) ?? "",
        (text) => /\n\d+\n\d+\n\d+\n/.test(text),
        "the counter never started",
      );

      for (let i = 0; i < 20; i += 1) {
        await stream.reseed();
        await readUntil(
          () => stream!.state,
          (state) => state === "live",
          "PaneStream never went live after a reseed",
        );
      }
      // Read before stopping the counter, whose `^C` and prompt would follow.
      // The first transcript starts before the counter; the rest each begin
      // at a seed taken mid-count.
      const seeded = sink.transcripts.slice(1);
      await conn.execute(`send-keys -t %${paneId} C-c`);

      expect(stream.lastError).toBeNull();
      expect(seeded.length).toBeGreaterThanOrEqual(20);
      for (const transcript of seeded) {
        // Whole lines only: the screen's top row may be cut by the capture's
        // edge and the last line by the next seed.
        const lines = transcript.split("\n").slice(1, -1);
        const breaks = lines.flatMap((line, k) =>
          k > 0 && Number(line) !== Number(lines[k - 1]) + 1
            ? [lines.slice(Math.max(0, k - 3), k + 3).join(" ")]
            : [],
        );
        expect(breaks).toEqual([]);
      }
    }

    it("a seed taken while the pane prints draws no output twice", async () => {
      session = uniqueName("race");
      client = await createSession(socket, session);
      await expectSeedsDrawNothingTwice(client, await getPrimaryPaneId(client));
    }, 60000);

    // A bridge carries pane bytes and the reply's `begin` on separate frames
    // of one socket; the cut holds only if it keeps them in tmux's order.
    it("a seed over a WebSocket bridge, taken while the pane prints, draws no output twice", async () => {
      session = uniqueName("race-ws");
      client = await createSession(socket, session);
      const paneId = await getPrimaryPaneId(client);
      const bridged = await bridgeTo(client);
      try {
        await expectSeedsDrawNothingTwice(bridged.client, paneId);
      } finally {
        stream?.dispose();
        stream = null;
        await bridged.close();
      }
    }, 60000);
  },
);

// A WebSocketTmuxClient reaching `tmux` through a real bridge server.
async function bridgeTo(tmux: TmuxClient): Promise<{
  client: WebSocketTmuxClient;
  close(): Promise<void>;
}> {
  const bridge = createWebSocketBridge({
    createClient: () => tmux,
    authenticate: () => ({ ok: true, identity: undefined }),
  });
  const httpServer = createServer();
  const wss = new WebSocketServer({ server: httpServer, path: "/tmux" });
  wss.on("connection", (ws, req) => {
    void bridge.handleConnection(ws as unknown as ServerWebSocketLike, {
      url: req.url,
      headers: req.headers,
      remoteAddress: req.socket.remoteAddress,
    });
  });
  const port = await new Promise<number>((resolve) => {
    httpServer.listen(0, "127.0.0.1", () => {
      const addr = httpServer.address();
      resolve(typeof addr === "object" && addr !== null ? addr.port : 0);
    });
  });
  const client = new WebSocketTmuxClient({
    url: `ws://127.0.0.1:${port}/tmux`,
    createWebSocket: (u) => new WsClient(u) as unknown as BrowserWebSocketLike,
    autoConnect: true,
  });
  await readUntil(
    () => client.connectionState.status,
    (status) => status === "ready",
    "the bridged client never became ready",
  );
  return {
    client,
    async close() {
      client.close();
      await bridge.shutdown(1_000);
      await new Promise<void>((r) => wss.close(() => r()));
      await new Promise<void>((r) => httpServer.close(() => r()));
    },
  };
}

// Each `seed()` starts a transcript: the captured screen as the text a reader
// sees (rows above the cursor as whole lines, the cursor's row as a line still
// being written), then every byte drawn after it — `trailing`, then `write`s —
// until the next seed.
class TranscriptSink implements TerminalSink {
  transcripts: string[] = [];
  private readonly decoder = new TextDecoder();
  seed(
    captured: Uint8Array,
    cursor: SeedCursor | null,
    trailing: readonly Uint8Array[],
  ): void {
    if (cursor === null) throw new Error("seed arrived without a cursor");
    const rows = this.decoder
      .decode(captured)
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b(\[[0-9;?]*[A-Za-z]|[=>]|\([0-9A-Z])/g, "")
      .split("\r\n")
      .map((row) => row.trimEnd());
    const above = rows.slice(0, cursor.row).filter((row) => row !== "");
    this.transcripts.push(
      above.map((row) => `${row}\n`).join("") + rows[cursor.row],
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
