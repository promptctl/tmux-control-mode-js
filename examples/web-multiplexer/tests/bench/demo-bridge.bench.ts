// examples/web-multiplexer/tests/bench/demo-bridge.bench.ts
//
// DEMO BRIDGE GATES — exercise PaneStream against a spawn-mode TmuxClient so
// adapter logic is measured in isolation from any network/serialisation layer.
//
// `TmuxClient` structurally satisfies `TmuxConnection`, so it's passed to
// `new PaneStream({ client })` directly — no shim. Gate 7 (reconnect) is out
// of scope here — spawn-mode `TmuxClient` never emits `reconnected`, so
// reconnect gates belong in a separate bench that uses a WebSocket transport.
//
// Gate targets (from the parent epic):
//   G1 — attach → first paint (seed delivered to sink) < 100ms p99
//   G2 — live byte → cell on screen                   <  16ms p99
//   G7 — reconnect with N attached streams: first visible pane < 100ms
//
// Skipped without TMUX_INTEGRATION=1.

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { execSync } from "node:child_process";
import { spawnTmux, TmuxClient } from "@promptctl/tmux-control-mode-js";
import type { ConnectionState } from "@promptctl/tmux-control-mode-js";
import { PaneStream } from "@promptctl/pane-terminal/stream";
import { BufferingSink } from "@promptctl/pane-terminal/sink";

const integrationOn = process.env.TMUX_INTEGRATION === "1";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function uniqueSocket(): string {
  return `tmux-js-demo-bench-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}
function uniqueSession(): string {
  return `demo-bench-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
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

async function createSession(socket: string, session: string): Promise<TmuxClient> {
  execSync(tmuxCmd(socket, `new-session -d -s ${session} -x 80 -y 24`), {
    stdio: "ignore",
  });
  const transport = spawnTmux(["attach-session", "-t", session], {
    socketPath: socket,
  });
  const client = new TmuxClient(transport);
  await new Promise<void>((resolve, reject) => {
    // `TmuxClient.on()` returns void — register with `on`, unregister with
    // a named handler reference via `off`, on both branches, so the
    // listener never leaks past the awaited promise.
    const handler = (msg: { state: ConnectionState }): void => {
      if (msg.state.status !== "ready") return;
      clearTimeout(timeout);
      client.off("connection-state", handler);
      resolve();
    };
    const timeout = setTimeout(() => {
      client.off("connection-state", handler);
      reject(new Error("client ready timeout"));
    }, 5000);
    client.on("connection-state", handler);
  });
  return client;
}

// ---------------------------------------------------------------------------
// G1 — Attach → first paint (seed delivered) < 100ms p99
// ---------------------------------------------------------------------------

const P99_BUDGET_G1_MS = 100;
const G1_ITERATIONS = 30;

describe.skipIf(!integrationOn)("demo bridge — G1 attach-paint", () => {
  let socket: string;
  let client: TmuxClient;
  let paneId: number;

  beforeEach(async () => {
    socket = uniqueSocket();
    const session = uniqueSession();
    client = await createSession(socket, session);

    const resp = await client.execute("display-message -p '#{pane_id}'");
    const raw = resp.output[0] ?? "%0";
    paneId = parseInt(raw.replace(/^%/, ""), 10);
  });

  afterEach(() => {
    client.close();
    killServer(socket);
  });

  it(`G1: attach-paint p99 < ${P99_BUDGET_G1_MS}ms (${G1_ITERATIONS} iterations)`, async () => {
    const latencies: number[] = [];

    for (let i = 0; i < G1_ITERATIONS; i++) {
      const stream = new PaneStream({ client, paneId });
      const sink = new BufferingSink();
      const t0 = performance.now();
      const seedDone = new Promise<void>((resolve) => {
        const orig = sink.seed.bind(sink);
        sink.seed = (...args) => {
          orig(...args);
          resolve();
        };
      });
      stream.attach(sink);
      await seedDone;
      latencies.push(performance.now() - t0);
      stream.detach();
      stream.dispose();
    }

    latencies.sort((a, b) => a - b);
    const p99 = latencies[Math.floor(latencies.length * 0.99)] ?? latencies.at(-1) ?? 0;
    expect(p99, `G1 p99 ${p99.toFixed(1)}ms > ${P99_BUDGET_G1_MS}ms`).toBeLessThan(P99_BUDGET_G1_MS);
  });
});
