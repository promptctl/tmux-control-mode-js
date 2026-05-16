// packages/pane-terminal/tests/bench/g1-attach-paint.bench.ts
//
// GATE 1 — Visibility toggle → first paint p99 < 100ms.
//
// What this gate measures:
//
//   The wall-clock latency from `stream.attach(sink)` to the first sink-side
//   callback (`sink.seed()`), against a real tmux process. This is the
//   producer-side budget PaneStream + the sink contract own. Xterm's own
//   render-tick latency is bounded by xterm itself (one frame at 60fps,
//   already counted in gate 2), and this gate's threshold has been chosen so
//   that the producer-side measurement leaves comfortable headroom for that
//   second hop.
//
// Why BufferingSink and not XtermSink:
//
//   The "first-paint" event from PaneStream's perspective is `sink.seed()` —
//   that's when the renderer-shaped data has crossed the seam and become
//   the consumer's responsibility. XtermSink wraps that callback in DOM
//   work (writing into a Terminal, ANSI cursor placement) but does not
//   delay the seed. Measuring at the sink boundary keeps this gate about
//   PaneStream + tmux RTT — the part of "first paint" the library actually
//   owns. XtermSink's correctness is gated by the unit tests
//   (xterm-sink.test.ts) and by gates 4 (re-mount = 0 capture-pane) and
//   6 (dispose reclaim).
//
// Status: GREEN as of 8w9.6 (was a stub awaiting full sink stack in 8w9.4–6).
// Skipped without TMUX_INTEGRATION=1.

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { execSync } from "node:child_process";
import { spawnTmux } from "../../../../src/transport/spawn.js";
import { TmuxClient } from "../../../../src/client.js";
import { PaneStream } from "../../src/stream/index.js";
import type { TerminalSink, SeedCursor } from "../../src/sink/index.js";

const P99_BUDGET_MS = 100;
const ITERATIONS = 50; // Real tmux RTT × 50 keeps the bench under ~3 s wall time.
const integrationOn = process.env.TMUX_INTEGRATION === "1";

function uniqueSocket(): string {
  return `tmux-js-g1-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}
function uniqueSession(): string {
  return `g1-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
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
  execSync(tmuxCmd(socket, `new-session -d -s ${session} -x 80 -y 24`), {
    stdio: "ignore",
  });
  const transport = spawnTmux(["attach-session", "-t", session], {
    socketPath: socket,
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

async function getPrimaryPaneId(client: TmuxClient): Promise<number> {
  const r = await client.execute("display-message -p '#{pane_id}'");
  const line = r.output[0] ?? "";
  const m = line.match(/^%(\d+)$/);
  if (m === null) throw new Error(`unexpected pane id reply: ${line}`);
  return Number(m[1]);
}

class TimingSink implements TerminalSink {
  seedAt = 0;
  hasSeed = false;
  seed(_t: string, _c: SeedCursor | null): void {
    this.seedAt = performance.now();
    this.hasSeed = true;
  }
  write(_b: Uint8Array): void {
    /* unused for first-paint timing */
  }
  resize(_c: number, _r: number): void {
    /* unused */
  }
  clear(): void {
    /* unused */
  }
  isVisible(): boolean {
    return true;
  }
  dispose(): void {
    /* no-op */
  }
}

function p99(samples: number[]): number {
  const sorted = samples.slice().sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99));
  return sorted[idx];
}

describe.skipIf(!integrationOn)(
  "Gate 1 — visibility toggle → first paint",
  () => {
    // Initialise to a sentinel so a beforeEach that throws BEFORE the
    // socket assignment doesn't make afterEach run
    // `tmux -L undefined kill-server` against an unrelated tmux server
    // (one literally named `undefined`). Today `uniqueSocket()` can't
    // fail, but a future edit that slips a throwing line above it would
    // expose this footgun without the sentinel.
    let socket = "";
    let session: string;
    let client: TmuxClient;
    let paneId: number;

    beforeEach(async () => {
      socket = uniqueSocket();
      session = uniqueSession();
      client = await createSession(socket, session);
      paneId = await getPrimaryPaneId(client);
    });

    afterEach(() => {
      client?.close();
      if (socket !== "") killServer(socket);
    });

    it(`p99 attach → first sink seed < ${P99_BUDGET_MS}ms across ${ITERATIONS} iterations`, async () => {
      const samples: number[] = [];
      for (let i = 0; i < ITERATIONS; i++) {
        const sink = new TimingSink();
        const stream = new PaneStream({
          client,
          paneId,
        });
        const t0 = performance.now();
        stream.attach(sink);
        // The seed promise resolves once capture-pane + display-message
        // round-trip; the sink's seed() callback is the visible event.
        // Poll on a microtask boundary until the sink has been seeded.
        while (!sink.hasSeed) {
          await new Promise<void>((r) => setTimeout(r, 0));
        }
        samples.push(sink.seedAt - t0);
        stream.dispose();
      }
      const measured = p99(samples);
      expect(
        measured,
        `p99 first-seed latency ${measured.toFixed(2)}ms (budget ${P99_BUDGET_MS}ms)`,
      ).toBeLessThan(P99_BUDGET_MS);
    }, 30_000);
  },
);
