// examples/web-multiplexer/web/electron-bridge.test.ts
//
// The ElectronBridge keeps the TmuxBridge contract the WebSocket bridge keeps:
// a tmux %error rejects with TmuxCommandError and is logged as the response it
// is; only a bridge failure reaches onError; the bridge is ready while main's
// tmux client is. The library's renderer proxy runs for real over a fake IPC.
// Over the in-memory IPC hub to a real main bridge, a page's pane streams
// follow every move the library does and re-route against the new server
// after a socket swap; those cases drive real tmux and are gated behind
// TMUX_INTEGRATION=1.
//
// The file reads the package's built dist/ as the demo does: run
// `pnpm run build` first.

import { describe, it, expect } from "vitest";
import { TmuxClient, spawnTmux } from "@promptctl/tmux-control-mode-js";
import {
  TmuxCommandError,
  windowScope,
} from "@promptctl/tmux-control-mode-js/browser";
import { createMainBridge } from "@promptctl/tmux-control-mode-js/electron/main";
import type {
  IpcEventMessage,
  IpcRendererLike,
  IpcRendererEventLike,
  IpcRendererOnListener,
} from "@promptctl/tmux-control-mode-js/electron/renderer";
import type { CommandResponse } from "@promptctl/tmux-control-mode-js/protocol";
import { IPC } from "../../../src/connectors/electron/types.ts";
import { createIpcHub } from "../../../tests/unit/_helpers/ipc-hub.ts";
import {
  readUntil,
  tmux,
  waitForEvent,
  uniqueName,
  uniqueSocket,
} from "../../../tests/helpers/integration.ts";
import { killTmuxServer } from "../../../tests/helpers/reap-test-sockets.ts";
import {
  describeTopologyMoves,
  listAllPanesOn,
  makeRecordingSink,
  sendOutputToPane,
  textOf,
  type ArrivedChunk,
} from "../../../tests/helpers/topology-moves.ts";
import type { ConnState, WireEntry } from "./bridge.ts";
import type { DemoIpc } from "./demo-ipc.ts";
import { ElectronBridge } from "./electron-bridge.ts";
import { BridgePaneStreamClient } from "./pane-stream-bridge.ts";

const unused = (): Promise<never> =>
  Promise.reject(new Error("not used by these cases"));

const demoIpc: DemoIpc = {
  listSockets: unused,
  currentSocket: unused,
  switchSocket: unused,
  startFirehose: unused,
  stopFirehose: unused,
  onFirehose: () => () => undefined,
};

/** A bridge connected over a fake IPC: main answers every invoke with
 *  `envelope`, and answers the proxy's registration with `onRegister`, as it
 *  happens, before `send` returns. */
function connectedBridge(
  envelope: unknown = { status: "ok" },
  onRegister: readonly IpcEventMessage[] = [],
): {
  bridge: ElectronBridge;
  errors: string[];
  wire: WireEntry["dir"][];
  states: ConnState[];
  fromMain(msg: IpcEventMessage): void;
} {
  const listeners: IpcRendererOnListener[] = [];
  const fromMain = (msg: IpcEventMessage): void =>
    listeners.forEach((l) => l({} as IpcRendererEventLike, msg));
  const ipc: IpcRendererLike = {
    invoke: () => Promise.resolve(envelope),
    send: (channel) => {
      if (channel === IPC.register) onRegister.forEach(fromMain);
    },
    on: (_channel, listener) => listeners.push(listener),
    removeListener: () => undefined,
  };
  const bridge = new ElectronBridge(ipc, demoIpc);
  const errors: string[] = [];
  const wire: WireEntry["dir"][] = [];
  const states: ConnState[] = [];
  bridge.onError((message) => errors.push(message));
  bridge.onWire((entry) => wire.push(entry.dir));
  bridge.onState((s) => states.push(s));
  bridge.connect("");
  return {
    bridge,
    errors,
    wire,
    states,
    fromMain,
  };
}

const READY: IpcEventMessage = {
  type: "connection-state",
  state: { status: "ready" },
};

const settle = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

describe("ElectronBridge command contract", () => {
  it("rejects a tmux %error with TmuxCommandError, logged as a response and not as a bridge error", async () => {
    const failed: CommandResponse = {
      commandNumber: 0,
      timestamp: 0,
      output: ["can't find window: @9"],
      success: false,
    };
    const { bridge, errors, wire } = connectedBridge({
      status: "tmux-error",
      response: failed,
    });

    const p = bridge.execute("list-panes -t @9");
    await expect(p).rejects.toBeInstanceOf(TmuxCommandError);
    await expect(p).rejects.toMatchObject({ response: failed });
    expect(errors).toEqual([]);
    expect(wire).toEqual(["out", "in-response"]);
    bridge.disconnect();
  });

  it("rejects a bridge failure and reports it", async () => {
    const { bridge, errors, wire } = connectedBridge({
      status: "bridge-error",
      error: { code: "BRIDGE_CLOSED", message: "main went away" },
    });

    await expect(bridge.execute("list-panes")).rejects.toThrow(
      "main went away",
    );
    expect(errors).toHaveLength(1);
    expect(wire).toEqual(["out", "in-error"]);
    bridge.disconnect();
  });
});

describe("ElectronBridge state", () => {
  it("follows main's tmux client: connecting until main says ready, closed when it closes", async () => {
    const { bridge, states, fromMain } = connectedBridge();
    await settle();
    expect(states.at(-1)).toBe("connecting");

    fromMain(READY);
    await settle();
    expect(states.at(-1)).toBe("ready");

    fromMain({
      type: "connection-state",
      state: { status: "closed", reason: "transport-error" },
    });
    await settle();

    expect(states.at(-1)).toBe("closed");
    bridge.disconnect();
  });

  it("is ready when main's ready snapshot answers the registration before connect() returns", () => {
    const { bridge, states } = connectedBridge({ status: "ok" }, [READY]);

    expect(states.at(-1)).toBe("ready");
    bridge.disconnect();
  });
});

describe("BridgePaneStreamClient over ElectronBridge", () => {
  it("a BRIDGE_CLOSED reply that beats main's closed retires the router's connection, so it reports no topology error", async () => {
    const { bridge, fromMain } = connectedBridge({
      status: "bridge-error",
      error: { code: "BRIDGE_CLOSED", message: "main went away" },
    });
    fromMain(READY);
    await settle();
    const conn = new BridgePaneStreamClient(bridge);
    const reported: Error[] = [];
    conn.on("topology-error", (ev) => reported.push(ev.error));

    // A window sink needs topology, so the router bootstraps on the live
    // connection; main answers BRIDGE_CLOSED before its `closed` arrives.
    conn.attachBytesSink(
      { write: () => undefined, end: () => undefined },
      { scope: windowScope(1) },
    );
    await settle();

    expect(reported).toEqual([]);
    bridge.disconnect();
  });
});

// The demo's Electron main process, attached as electron/main.ts attaches it:
// a TmuxClient attached to `session`, exposed to renderers by the library's
// main bridge once tmux's attach handshake has settled. Every command main
// sends to tmux lands in `sent`. Swapping sockets there disposes both and
// installs a fresh pair.
async function attachMain(
  hub: ReturnType<typeof createIpcHub>,
  socketName: string,
  session: string,
): Promise<{ sent: string[]; close(): void }> {
  const sent: string[] = [];
  const inner = spawnTmux(["attach-session", "-t", session], {
    socketPath: socketName,
  });
  const client = new TmuxClient({
    send: (cmd) => {
      const result = inner.send(cmd);
      if (result.ok) sent.push(cmd);
      return result;
    },
    onData: (cb) => inner.onData(cb),
    onClose: (cb) => inner.onClose(cb),
    close: () => inner.close(),
  });
  const attached = waitForEvent(client, "session-changed");
  let handle: ReturnType<typeof createMainBridge>;
  try {
    await attached;
    handle = createMainBridge(client, hub.ipcMain);
  } catch (err) {
    client.close();
    throw new Error(`main never came up on ${session}`, { cause: err });
  }
  return {
    sent,
    close: () => {
      handle.dispose();
      client.close();
    },
  };
}

/** A page in the Electron demo: the renderer's bridge and the adapter every
 *  PaneStream on the page shares, over in-process IPC to a real main. */
async function electronPage(
  socketName: string,
  session: string,
): Promise<{
  conn: BridgePaneStreamClient;
  /** What each main the page has been connected to sent to tmux, in order. */
  sentByMain: string[][];
  swapMain(socketName: string, session: string): Promise<void>;
  close(): void;
}> {
  tmux(socketName, ["new-session", "-d", "-s", session]);
  const hub = createIpcHub();
  let main = await attachMain(hub, socketName, session);
  const sentByMain = [main.sent];
  const bridge = new ElectronBridge(hub.createRenderer().ipcRenderer, demoIpc);
  const conn = new BridgePaneStreamClient(bridge);
  bridge.connect("");
  const close = (): void => {
    bridge.disconnect();
    main.close();
  };
  try {
    await readUntil(
      () => conn.connectionState.status,
      (status) => status === "ready",
      "the Electron page never became ready",
    );
  } catch (err) {
    close();
    throw err;
  }
  return {
    conn,
    sentByMain,
    // SocketBadge's swap: the page lets go of main, main re-attaches to the
    // chosen server, the page connects again.
    swapMain: async (nextSocket, nextSession) => {
      bridge.disconnect();
      main.close();
      main = await attachMain(hub, nextSocket, nextSession);
      sentByMain.push(main.sent);
      bridge.connect("");
    },
    close,
  };
}

describeTopologyMoves("BridgePaneStreamClient over ElectronBridge", (s, n) =>
  electronPage(s, n),
);

describe.skipIf(process.env.TMUX_INTEGRATION !== "1")(
  "a socket swap on the Electron page",
  () => {
    it("re-learns the new server's topology: a window sink attached before the swap routes the new server's panes, and each main gets one list-panes bootstrap", async () => {
      const socketA = uniqueSocket("tmux-scope-test-", "electron-swap-a");
      const socketB = uniqueSocket("tmux-scope-test-", "electron-swap-b");
      const sessionB = uniqueName("swap-b");
      try {
        const page = await electronPage(socketA, uniqueName("swap-a"));
        try {
          // Pane %1 has a window of its own on A and shares %0's on B, so a
          // router still holding A's table after the swap misroutes it. The
          // page hears A's new window before any sink needs topology, so the
          // only query on each server is the bootstrap.
          const windowAdded = waitForEvent(page.conn, "window-add");
          tmux(socketA, ["new-window", "-d"]);
          await windowAdded;
          tmux(socketB, ["new-session", "-d", "-s", sessionB]);
          tmux(socketB, ["split-window", "-d"]);
          const onA = listAllPanesOn(socketA);
          const window = listAllPanesOn(socketB).find(
            (p) => p.paneId === 1,
          )!.windowId;
          expect(onA.find((p) => p.paneId === 1)!.windowId).not.toBe(window);
          const paneOnA = onA.find((p) => p.windowId === window)!.paneId;

          const arrived: ArrivedChunk[] = [];
          let ended = false;
          let reconnects = 0;
          page.conn.on("reconnected", () => reconnects++);
          page.conn.attachBytesSink(
            { ...makeRecordingSink(arrived), end: () => (ended = true) },
            { scope: windowScope(window) },
          );
          await sendOutputToPane(page.conn, paneOnA);
          await readUntil(
            () => textOf(arrived, paneOnA),
            (text) => text.includes(`scope-test-${paneOnA}`),
            `pane %${paneOnA}'s marker never reached the window sink on A`,
          );

          await page.swapMain(socketB, sessionB);
          await readUntil(
            () => page.conn.connectionState.status,
            (status) => status === "ready",
            "the page never became ready on B",
          );
          await sendOutputToPane(page.conn, 1);
          await readUntil(
            () => textOf(arrived, 1),
            (text) => text.includes("scope-test-1"),
            "pane %1's marker never reached the window sink on B",
          );

          expect(ended).toBe(false);
          expect(reconnects).toBe(1);
          // [LAW:one-source-of-truth] The page keeps one topology: one
          //   whole-server bootstrap per connection, where a second router
          //   needing topology would send its own.
          expect(
            page.sentByMain.map(
              (sent) =>
                sent.filter((c) => c.startsWith("list-panes -a ")).length,
            ),
          ).toEqual([1, 1]);
        } finally {
          page.close();
        }
      } finally {
        killTmuxServer(socketA);
        killTmuxServer(socketB);
      }
    }, 20000);
  },
);
