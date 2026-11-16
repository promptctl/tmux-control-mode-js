// tests/bench/g1-attach-paint.bench.ts
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
import type { TmuxClient } from "../../src/index.js";
import { PaneStream } from "../../src/window-terminal/engine/pane-stream.js";
import type {
  TerminalSink,
  SeedCursor,
} from "../../src/window-terminal/engine/terminal-sink.js";
import { killTmuxServer } from "../helpers/reap-test-sockets.js";
import {
  attachSession,
  getPrimaryPaneId,
  readUntil,
  uniqueName,
  uniqueSocket,
} from "../helpers/integration.js";

const P99_BUDGET_MS = 100;
const ITERATIONS = 50; // Real tmux RTT × 50 keeps the bench under ~3 s wall time.
const integrationOn = process.env.TMUX_INTEGRATION === "1";

class TimingSink implements TerminalSink {
  seedAt = 0;
  hasSeed = false;
  seed(
    _captured: Uint8Array,
    _c: SeedCursor | null,
    _trailing: readonly Uint8Array[],
  ): void {
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
    // socket assignment doesn't make afterEach run teardown against a
    // socket literally named "undefined" (an unrelated, real tmux server
    // if one happens to exist under that name). Today `uniqueSocket(...)`
    // can't fail, but a future edit that slips a throwing line above it
    // would expose this footgun without the sentinel.
    let socket = "";
    let client: TmuxClient;
    let paneId: number;

    beforeEach(async () => {
      socket = uniqueSocket("tmux-js-bench-", "g1");
      client = await attachSession(socket, uniqueName("g1"), {
        newSessionFlags: ["-x", "80", "-y", "24"],
      });
      paneId = await getPrimaryPaneId(client);
    });

    afterEach(() => {
      client?.close();
      if (socket !== "") killTmuxServer(socket);
    });

    it(`p99 attach → first sink seed < ${P99_BUDGET_MS}ms across ${ITERATIONS} iterations`, async () => {
      const samples: number[] = [];
      for (let i = 0; i < ITERATIONS; i++) {
        const sink = new TimingSink();
        const stream = new PaneStream({
          client,
          paneId,
        });
        try {
          const t0 = performance.now();
          stream.attach(sink);
          // The seed lands once capture-pane + display-message round-trip;
          // seedAt is stamped inside the sink's seed() callback, so the poll
          // interval never enters the sample.
          await readUntil(
            () => sink.hasSeed,
            (seeded) => seeded,
            "the sink never received its seed",
            2000,
          );
          samples.push(sink.seedAt - t0);
        } finally {
          stream.dispose();
        }
      }
      const measured = p99(samples);
      expect(
        measured,
        `p99 first-seed latency ${measured.toFixed(2)}ms (budget ${P99_BUDGET_MS}ms)`,
      ).toBeLessThan(P99_BUDGET_MS);
    }, 30_000);
  },
);
