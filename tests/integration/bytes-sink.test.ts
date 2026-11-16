// tests/integration/bytes-sink.test.ts
// Integration test 22 for the Electron BytesSink destination against real tmux.
//
// INT-22: attachWebContentsSink delivers real tmux bytes as PaneOutputMessage
//         on IPC.event to a fake WebContents.
//
// [LAW:verifiable-goals] Gated behind TMUX_INTEGRATION=1. All tests use
// ephemeral tmux servers — the developer's default server is never touched.
// [LAW:behavior-not-structure] Assertions target observable wire behavior
// (bytes arriving, IPC messages sent) not implementation internals.

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { killTmuxServer } from "../helpers/reap-test-sockets.js";
import {
  uniqueSocket,
  readUntil,
  attachSession,
} from "../helpers/integration.js";
import type { TmuxClient } from "../../src/client.js";
import { paneScope, parsePaneListLine } from "../../src/pane-output.js";
import {
  attachWebContentsSink,
  WebContentsSink,
} from "../../src/connectors/electron/main.js";
import type {
  IpcEventMessage,
  WebContentsLike,
} from "../../src/connectors/electron/types.js";
import { isPaneOutput } from "../../src/protocol/types.js";

const RUN_INTEGRATION = process.env.TMUX_INTEGRATION === "1";

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

// ---------------------------------------------------------------------------
// INT-22: WebContentsSink — Electron IPC forwarder against real tmux
// ---------------------------------------------------------------------------

describe.skipIf(!RUN_INTEGRATION)(
  "INT-22: attachWebContentsSink — Electron IPC forwarder",
  () => {
    let socketName = "";
    let client: TmuxClient | null = null;

    beforeEach(async () => {
      socketName = uniqueSocket("tmux-bytes-sink-test-", "electron");
      client = await attachSession(socketName, "electron-test");
    });

    afterEach(async () => {
      client?.close();
      client = null;
      killTmuxServer(socketName);
    });

    it("INT-22: PaneOutputMessage arrives on IPC.event when tmux produces output", async () => {
      // Fake WebContents that records messages sent on any channel.
      const ipcMessages: IpcEventMessage[] = [];
      const fakeWc: Pick<WebContentsLike, "send" | "isDestroyed"> = {
        send(_channel, msg) {
          ipcMessages.push(msg);
        },
        isDestroyed() {
          return false;
        },
      };

      const paneId = await getFirstPaneId(client!);
      const dispose = attachWebContentsSink(client!, fakeWc, {
        scope: paneScope(paneId),
      });

      // The quotes vanish only when the shell runs the line, so "int22-hello"
      // appears in the command's output, never in the line editor's echo of
      // the typed `int22-''hello`.
      await client!.execute(
        `send-keys -t %${paneId} "echo int22-''hello" Enter`,
      );

      const outputs = () => ipcMessages.filter(isPaneOutput);

      // The wait keys on the marker itself: the first output message can be
      // the shell's prompt redraw, which arrives before the echo under load.
      await readUntil(
        () => Buffer.concat(outputs().map((o) => o.data)).toString(),
        (text) => text.includes("int22-hello"),
        "int22-hello never arrived on IPC.event",
      );
      expect(outputs().every((o) => o.paneId === paneId)).toBe(true);

      dispose();
    }, 15_000);

    it("INT-22b: WebContentsSink is a no-op when isDestroyed() returns true", () => {
      const sent: string[] = [];
      let destroyed = false;
      const fakeWc: Pick<WebContentsLike, "send" | "isDestroyed"> = {
        send(channel: string) {
          sent.push(channel);
        },
        isDestroyed() {
          return destroyed;
        },
      };

      const sink = new WebContentsSink(fakeWc);
      destroyed = true;
      sink.write({ paneId: 1, data: new Uint8Array([0xab]) });
      expect(sent).toHaveLength(0);
    });
  },
);
