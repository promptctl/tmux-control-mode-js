// tests/integration/bytes-sink.test.ts
// Integration tests 19, 22, 23 for BytesSink destinations against real tmux.
//
// INT-19: attachXtermSink delivers real tmux output bytes to a fake terminal.
// INT-22: attachWebContentsSink delivers real tmux bytes as PaneOutputMessage
//         on IPC.event to a fake WebContents.
// INT-23: Disposer is idempotent; double-dispose does not throw or re-deliver.
//
// [LAW:verifiable-goals] Gated behind TMUX_INTEGRATION=1. All tests use
// ephemeral tmux servers — the developer's default server is never touched.
// [LAW:behavior-not-structure] Assertions target observable wire behavior
// (bytes arriving, IPC messages sent) not implementation internals.

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { execSync } from "node:child_process";
import { spawnTmux } from "../../src/transport/spawn.js";
import { TmuxClient } from "../../src/client.js";
import { paneScope, parsePaneListLine } from "../../src/pane-output.js";
import type { BytesSink } from "../../src/pane-output.js";
import {
  attachWebContentsSink,
  WebContentsSink,
} from "../../src/connectors/electron/main.js";
import { IPC } from "../../src/connectors/electron/types.js";
import type { WebContentsLike } from "../../src/connectors/electron/types.js";
import {
  attachXtermSink,
  XtermBytesSink,
} from "../../packages/pane-terminal/src/xterm-sink/index.js";

const RUN_INTEGRATION = process.env.TMUX_INTEGRATION === "1";

// ---------------------------------------------------------------------------
// Isolation helpers (mirrors pane-scope.test.ts)
// ---------------------------------------------------------------------------

function uniqueSocket(prefix: string): string {
  return `tmux-bytes-sink-test-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

// [LAW:single-enforcer] Only place that builds `tmux -L <socket> …` strings.
function tmuxCmd(socketName: string, args: string): string {
  return `tmux -L ${socketName} ${args}`;
}

function killServer(socketName: string): void {
  try {
    execSync(tmuxCmd(socketName, "kill-server"), { stdio: "ignore" });
  } catch {
    // already gone
  }
}

function createClient(socketName: string, sessionName: string): Promise<TmuxClient> {
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

async function getFirstPaneId(client: TmuxClient): Promise<number> {
  const response = await client.execute(
    "list-panes -a -F '#{pane_id} #{window_id} #{session_id}'",
  );
  for (const line of response.output) {
    const parsed = parsePaneListLine(line);
    if (parsed !== null) return parsed.paneId;
  }
  throw new Error("no panes found");
}

function waitFor(pred: () => boolean, timeoutMs = 8000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      if (pred()) { resolve(); return; }
      if (Date.now() >= deadline) {
        reject(new Error(`waitFor: condition not met within ${timeoutMs}ms`));
        return;
      }
      setTimeout(check, 10);
    };
    check();
  });
}

// ---------------------------------------------------------------------------
// INT-19: XtermBytesSink round-trip
// ---------------------------------------------------------------------------

describe.skipIf(!RUN_INTEGRATION)("INT-19: attachXtermSink — xterm round-trip", () => {
  let socketName = "";
  let client: TmuxClient | null = null;

  beforeEach(async () => {
    socketName = uniqueSocket("xterm");
    client = await createClient(socketName, "xterm-test");
  });

  afterEach(async () => {
    client?.close();
    client = null;
    killServer(socketName);
  });

  it(
    "INT-19: bytes from echo arrive in the fake xterm terminal",
    async () => {
      const received: Uint8Array[] = [];
      const fakeTerm = {
        write(data: Uint8Array): void {
          received.push(data.slice());
        },
      };

      const paneId = await getFirstPaneId(client!);
      const dispose = attachXtermSink(client!, fakeTerm, {
        scope: paneScope(paneId),
      });

      await client!.execute(`send-keys -t %${paneId} 'echo int19-hello' Enter`);

      await waitFor(() => {
        const all = Buffer.concat(received).toString();
        return all.includes("int19-hello");
      });

      const text = Buffer.concat(received).toString();
      expect(text).toContain("int19-hello");
      dispose();
    },
    15_000,
  );

  it(
    "INT-19b: XtermBytesSink.write passes data directly to term.write",
    () => {
      const received: Uint8Array[] = [];
      const fakeTerm = { write: (d: Uint8Array) => { received.push(d.slice()); } };
      const sink: BytesSink = new XtermBytesSink(fakeTerm);
      const data = new Uint8Array([0x68, 0x65, 0x6c, 0x6c, 0x6f]);
      sink.write({ paneId: 1, data });
      expect(received).toHaveLength(1);
      expect(Array.from(received[0])).toEqual([0x68, 0x65, 0x6c, 0x6c, 0x6f]);
    },
  );
});

// ---------------------------------------------------------------------------
// INT-22: WebContentsSink — Electron IPC forwarder against real tmux
// ---------------------------------------------------------------------------

describe.skipIf(!RUN_INTEGRATION)(
  "INT-22: attachWebContentsSink — Electron IPC forwarder",
  () => {
    let socketName = "";
    let client: TmuxClient | null = null;

    beforeEach(async () => {
      socketName = uniqueSocket("electron");
      client = await createClient(socketName, "electron-test");
    });

    afterEach(async () => {
      client?.close();
      client = null;
      killServer(socketName);
    });

    it(
      "INT-22: PaneOutputMessage arrives on IPC.event when tmux produces output",
      async () => {
        // Fake WebContents that records messages sent on any channel.
        const ipcMessages: { channel: string; payload: unknown }[] = [];
        let destroyed = false;
        const fakeWc: WebContentsLike = {
          send(channel: string, ...args: unknown[]) {
            if (!destroyed) ipcMessages.push({ channel, payload: args[0] });
          },
          isDestroyed() { return destroyed; },
          once(_event: string, _listener: () => void) {},
          removeListener(_event: string, _listener: () => void) {},
        };

        const paneId = await getFirstPaneId(client!);
        const dispose = attachWebContentsSink(client!, fakeWc, {
          scope: paneScope(paneId),
        });

        await client!.execute(`send-keys -t %${paneId} 'echo int22-hello' Enter`);

        await waitFor(() =>
          ipcMessages.some(
            (m) =>
              m.channel === IPC.event &&
              typeof m.payload === "object" &&
              m.payload !== null &&
              (m.payload as { type: string }).type === "output",
          ),
        );

        const outputMsg = ipcMessages.find(
          (m) =>
            m.channel === IPC.event &&
            typeof m.payload === "object" &&
            m.payload !== null &&
            (m.payload as { type: string }).type === "output",
        );
        expect(outputMsg).toBeDefined();
        const msg = outputMsg!.payload as {
          type: string;
          paneId: number;
          data: Uint8Array;
        };
        expect(msg.type).toBe("output");
        expect(msg.paneId).toBe(paneId);

        // Concatenate all output chunks for this pane and check for marker.
        const allChunks = ipcMessages
          .filter(
            (m) =>
              m.channel === IPC.event &&
              typeof m.payload === "object" &&
              m.payload !== null &&
              (m.payload as { paneId: number }).paneId === paneId,
          )
          .map((m) => (m.payload as { data: Uint8Array }).data);
        const text = Buffer.concat(allChunks).toString();
        expect(text).toContain("int22-hello");

        dispose();
      },
      15_000,
    );

    it(
      "INT-22b: WebContentsSink is a no-op when isDestroyed() returns true",
      () => {
        const sent: string[] = [];
        let destroyed = false;
        const fakeWc: WebContentsLike = {
          send(channel: string) { sent.push(channel); },
          isDestroyed() { return destroyed; },
          once() {},
          removeListener() {},
        };

        const sink = new WebContentsSink(fakeWc);
        destroyed = true;
        sink.write({ paneId: 1, data: new Uint8Array([0xab]) });
        expect(sent).toHaveLength(0);
      },
    );
  },
);

// ---------------------------------------------------------------------------
// INT-23: Disposer idempotency — double-dispose does not throw or re-deliver
// ---------------------------------------------------------------------------

describe.skipIf(!RUN_INTEGRATION)("INT-23: disposer idempotency", () => {
  let socketName = "";
  let client: TmuxClient | null = null;

  beforeEach(async () => {
    socketName = uniqueSocket("disposer");
    client = await createClient(socketName, "disposer-test");
  });

  afterEach(async () => {
    client?.close();
    client = null;
    killServer(socketName);
  });

  it(
    "INT-23: disposing an attachXtermSink twice does not throw and stops delivery",
    async () => {
      const received: Uint8Array[] = [];
      const endCalls: number[] = [];
      const fakeTerm = { write: (d: Uint8Array) => { received.push(d.slice()); } };

      const paneId = await getFirstPaneId(client!);

      // Wrap in a sink that tracks end() calls so we can assert idempotency.
      const inner = new XtermBytesSink(fakeTerm);
      let endCount = 0;
      const wrappedSink: BytesSink = {
        write(msg) { inner.write(msg); },
        end() {
          endCount++;
          endCalls.push(endCount);
        },
      };

      const dispose = client!.attachBytesSink(wrappedSink, {
        scope: paneScope(paneId),
      });

      // Confirm the sink is live — drive output and wait.
      await client!.execute(`send-keys -t %${paneId} 'echo int23-before' Enter`);
      await waitFor(() => {
        const all = Buffer.concat(received).toString();
        return all.includes("int23-before");
      });

      // Dispose twice — must not throw.
      dispose();
      expect(() => dispose()).not.toThrow();

      const countAfterDispose = received.length;

      // Any output after dispose must not arrive.
      await client!.execute(`send-keys -t %${paneId} 'echo int23-after' Enter`);
      // Brief wait — if the sink is truly detached, nothing new arrives.
      await new Promise<void>((r) => setTimeout(r, 400));
      expect(received.length).toBe(countAfterDispose);
    },
    15_000,
  );
});
