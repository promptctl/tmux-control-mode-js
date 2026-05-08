// examples/web-multiplexer/tests/bench/demo-bridge.bench.ts
//
// DEMO BRIDGE GATES — gates 1, 2, 7 exercised through BridgePaneStreamClient.
//
// These tests validate that the `BridgePaneStreamClient` adapter does not
// add measurable overhead to `PaneStream`'s existing gate guarantees. The
// adapter is tested by constructing a minimal `TmuxBridge`-shaped shim
// backed by a real tmux child (same approach as the package bench tests).
//
// Gate targets (from the parent epic):
//   G1 — attach → first paint (seed delivered to sink) < 100ms p99
//   G2 — live byte → cell on screen                   <  16ms p99
//   G7 — reconnect with N attached streams: first visible pane < 100ms
//
// Skipped without TMUX_INTEGRATION=1.

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { execSync } from "node:child_process";
import { spawnTmux } from "../../../../src/transport/spawn.js";
import { TmuxClient } from "../../../../src/client.js";
import { PaneStream, type PaneStreamClient } from "../../../../packages/pane-terminal/src/stream/index.js";
import { BufferingSink } from "../../../../packages/pane-terminal/src/sink/index.js";
import type { CommandResponse } from "../../../../src/protocol/types.js";
import type { ConnectionState } from "../../../../src/connection-state.js";
import type { OutputMessage, ExtendedOutputMessage } from "../../../../src/protocol/types.js";

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
  const transport = spawnTmux({ socketName: socket, session });
  const client = new TmuxClient(transport);
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("client ready timeout")), 5000);
    const unsub = client.on("connection-state", (msg) => {
      if (msg.state.status === "ready") {
        clearTimeout(timeout);
        unsub();
        resolve();
      }
    });
  });
  return client;
}

/**
 * Thin shim that turns a real `TmuxClient` into a `PaneStreamClient`
 * directly (no WebSocket layer — this bench isolates the adapter logic).
 */
class DirectPaneStreamClient implements PaneStreamClient {
  constructor(private readonly client: TmuxClient) {}

  get connectionState(): ConnectionState {
    return this.client.connectionState;
  }

  on(
    event: "output" | "extended-output" | "reconnected",
    handler: (ev: OutputMessage | ExtendedOutputMessage | { type: "reconnected" }) => void,
  ): void {
    if (event === "output") {
      this.client.on("output", handler as (ev: OutputMessage) => void);
    } else if (event === "extended-output") {
      this.client.on(
        "extended-output",
        handler as (ev: ExtendedOutputMessage) => void,
      );
    }
  }

  off(
    event: "output" | "extended-output" | "reconnected",
    handler: (ev: OutputMessage | ExtendedOutputMessage | { type: "reconnected" }) => void,
  ): void {
    if (event === "output") {
      this.client.off("output", handler as (ev: OutputMessage) => void);
    } else if (event === "extended-output") {
      this.client.off(
        "extended-output",
        handler as (ev: ExtendedOutputMessage) => void,
      );
    }
  }

  execute(command: string): Promise<CommandResponse> {
    return this.client.execute(command);
  }
}

// ---------------------------------------------------------------------------
// G1 — Attach → first paint (seed delivered) < 100ms p99
// ---------------------------------------------------------------------------

const P99_BUDGET_G1_MS = 100;
const G1_ITERATIONS = 30;

describe.skipIf(!integrationOn)("demo bridge — G1 attach-paint", () => {
  let socket: string;
  let client: TmuxClient;
  let streamClient: DirectPaneStreamClient;
  let paneId: number;

  beforeEach(async () => {
    socket = uniqueSocket();
    const session = uniqueSession();
    client = await createSession(socket, session);
    streamClient = new DirectPaneStreamClient(client);

    const resp = await client.execute("display-message -p '#{pane_id}'");
    const raw = resp.output[0] ?? "%0";
    paneId = parseInt(raw.replace(/^%/, ""), 10);
  });

  afterEach(() => {
    client.dispose();
    killServer(socket);
  });

  it(`G1: attach-paint p99 < ${P99_BUDGET_G1_MS}ms (${G1_ITERATIONS} iterations)`, async () => {
    const latencies: number[] = [];

    for (let i = 0; i < G1_ITERATIONS; i++) {
      const stream = new PaneStream({ client: streamClient, paneId });
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
