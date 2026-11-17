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
  browserOverBridge,
  getPrimaryPaneId,
  readUntil,
  waitForPaneText,
} from "../helpers/integration.js";
import type { TmuxClient } from "../../src/client.js";
import { sendKeys } from "../../src/commands/index.js";
import {
  PaneStream,
  type TerminalConnection,
} from "../../src/window-terminal/engine/pane-stream.js";
import type { TerminalSink } from "../../src/window-terminal/engine/terminal-sink.js";

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
  // Latin-1: one char per raw byte, so no byte is lost to a decode.
  seedCalls: string[] = [];
  resizeCalls: { cols: number; rows: number }[] = [];
  writeCount = 0;
  seed(captured: Uint8Array): void {
    this.seedCalls.push(Buffer.from(captured).toString("latin1"));
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

    it("attach() seeds with capture-pane output, leaving the cursor where tmux has it", async () => {
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
      expect(sink.seedCalls[0]).toContain("HELLO_SEED_MARKER");
      // The seed ends with a CUP to tmux's cursor (1-indexed).
      const r = await client.execute(
        `display-message -p -t %${paneId} '#{cursor_y};#{cursor_x}'`,
      );
      expect(
        sink.seedCalls[0].endsWith(
          `\x1b[${r.output[0]
            .split(";")
            .map((n) => Number(n) + 1)
            .join(";")}H`,
        ),
      ).toBe(true);
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

    it("draws a pane outside the client's session at its size, which tmux never reports", async () => {
      // tmux sends a size subscription's values only for a pane whose window
      // is in the control client's session, so this pane's size can come
      // only with its seed.
      session = uniqueName("near");
      client = await createSession(socket, session);
      const far = uniqueName("far");
      await client.execute(`new-session -d -s ${far} -x 100 -y 30`);
      const r = await client.execute(
        `display-message -p -t ${far}: '#{pane_id}'`,
      );
      const paneId = Number((r.output[0] ?? "").replace(/^%/, ""));
      const size = await paneSize(client, paneId);
      expect(size.cols).toBe(100);

      const order: string[] = [];
      const sink = new CollectorSink();
      sink.resize = (cols, rows) => void order.push(`resize(${cols}x${rows})`);
      sink.seed = () => void order.push("seed");
      stream = new PaneStream({ client, paneId });
      stream.attach(sink);
      await readUntil(
        () => stream!.state,
        (state) => state === "live",
        "PaneStream never went live",
      );
      expect(order).toEqual([`resize(${size.cols}x${size.rows})`, "seed"]);
    }, 15000);
  },
);

// Every seed's picture as a sink first draws it: the snapshot, then the
// bytes behind it.
class SeedTranscripts implements TerminalSink {
  readonly seeds: string[] = [];
  seed(captured: Uint8Array, trailing: readonly Uint8Array[]): void {
    const latin1 = (b: Uint8Array): string => Buffer.from(b).toString("latin1");
    this.seeds.push([captured, ...trailing].map(latin1).join(""));
  }
  write(): void {}
  resize(): void {}
  clear(): void {}
  isVisible(): boolean {
    return true;
  }
  dispose(): void {}
}

// The counts a transcript draws at or below a count it already drew: a line
// drawn twice, or an older line replayed after the snapshot. (Capture pads
// each line to the pane's width; a line split across the snapshot and its
// trailing bytes is skipped, not misread.)
function drawnAgain(transcript: string): number[] {
  const again: number[] = [];
  let highest = -1;
  for (const [, n] of transcript.matchAll(/(?<=^|\n)N(\d+) *\r?\n/g)) {
    const count = Number(n);
    if (count <= highest) again.push(count);
    highest = Math.max(highest, count);
  }
  return again;
}

describe.skipIf(!RUN_INTEGRATION)(
  "PaneStream — a seed taken while the pane prints draws each line once (tmux ≥3.2)",
  () => {
    let socket = "";
    const teardown: (() => unknown)[] = [];

    beforeEach(() => {
      socket = uniqueSocket("psr");
    });

    afterEach(async () => {
      for (const t of teardown.splice(0).reverse()) await t();
      if (socket !== "") killTmuxServer(socket);
      socket = "";
    });

    // A pane printing N0, N1, … as fast as the shell can, then 20 reseeds of
    // one stream over `connection`, each checked for a count drawn again.
    async function reseedWhilePrinting(
      client: TmuxClient,
      connection: TerminalConnection,
    ): Promise<void> {
      const paneId = await getPrimaryPaneId(client);
      await sendKeys(
        client,
        `%${paneId}`,
        "i=0; while :; do echo N$i; i=$((i+1)); done",
      );
      await client.execute(`send-keys -t %${paneId} Enter`);
      await waitForPaneText(client, paneId, "N100");

      const sink = new SeedTranscripts();
      const stream = new PaneStream({ client: connection, paneId });
      teardown.push(() => stream.dispose());
      stream.attach(sink);
      await readUntil(
        () => stream.state,
        (state) => state === "live",
        "PaneStream never went live",
      );
      // One more seed each round. A reseed can resolve with no seed (a
      // capture tmux paused is dropped; `%continue` captures again), so each
      // round waits for the seed, not for the reseed.
      for (let seeds = 2; seeds <= 21; seeds++) {
        await stream.reseed();
        await readUntil(
          () => sink.seeds.length,
          (n) => n >= seeds,
          `seed ${seeds} never came`,
        );
      }

      expect(sink.seeds).toHaveLength(21);
      expect(sink.seeds.map(drawnAgain)).toEqual(sink.seeds.map(() => []));
      expect(stream.lastError).toBeNull();
    }

    it("over a TmuxClient", async () => {
      const client = await attachSession(socket, uniqueName("race"));
      teardown.push(() => client.close());
      await reseedWhilePrinting(client, client);
    }, 30000);

    it("over a WebSocket bridge", async () => {
      const client = await attachSession(socket, uniqueName("race"));
      teardown.push(() => client.close());
      const { browser } = await browserOverBridge(() => client, teardown);
      await readUntil(
        () => browser.connectionState.status,
        (status) => status === "ready",
        "the browser client never connected",
      );
      await reseedWhilePrinting(client, browser);
    }, 30000);
  },
);
