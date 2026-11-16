// examples/web-multiplexer/web/electron-bridge.test.ts
//
// The ElectronBridge keeps the TmuxBridge contract the WebSocket bridge keeps:
// a tmux %error rejects with TmuxCommandError and is logged as the response it
// is; only a bridge failure reaches onError; the bridge is ready while main's
// tmux client is. The library's renderer proxy runs for real over a fake IPC.
// Over the in-memory IPC hub to a real main bridge, a page's pane streams
// follow every move the library does and survive a socket swap; those cases
// drive real tmux and are gated behind TMUX_INTEGRATION=1.
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
  IpcRendererLike,
  IpcRendererEventLike,
} from "@promptctl/tmux-control-mode-js/electron/renderer";
import type { CommandResponse } from "@promptctl/tmux-control-mode-js/protocol";
import { createIpcHub } from "../../../tests/unit/_helpers/ipc-hub.ts";
import {
  pollUntil,
  tmux,
  uniqueName,
  uniqueSocket,
} from "../../../tests/helpers/integration.ts";
import { killTmuxServer } from "../../../tests/helpers/reap-test-sockets.ts";
import {
  describeTopologyMoves,
  listAllPanes,
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

function connectedBridge(envelope: unknown = { status: "ok" }): {
  bridge: ElectronBridge;
  errors: string[];
  wire: WireEntry["dir"][];
  states: ConnState[];
  fromMain(msg: unknown): void;
} {
  const listeners: ((e: IpcRendererEventLike, ...args: unknown[]) => void)[] =
    [];
  const ipc: IpcRendererLike = {
    invoke: () => Promise.resolve(envelope),
    send: () => undefined,
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
    fromMain: (msg) =>
      listeners.forEach((l) => l({} as IpcRendererEventLike, msg)),
  };
}

const READY = { type: "connection-state", state: { status: "ready" } };

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

// The demo's Electron main process, as electron/main.ts runs it: a TmuxClient
// attached to `session`, exposed to renderers by the library's main bridge.
// Swapping sockets there disposes both and installs a fresh pair.
function attachMain(
  hub: ReturnType<typeof createIpcHub>,
  socketName: string,
  session: string,
): () => void {
  const client = new TmuxClient(
    spawnTmux(["attach-session", "-t", session], { socketPath: socketName }),
  );
  const handle = createMainBridge(client, hub.ipcMain);
  return () => {
    handle.dispose();
    client.close();
  };
}

/** A page in the Electron demo: the renderer's bridge and the adapter every
 *  PaneStream on the page shares, over in-process IPC to a real main. */
async function electronPage(
  socketName: string,
  session: string,
): Promise<{
  bridge: ElectronBridge;
  conn: BridgePaneStreamClient;
  swapMain(): void;
  close(): void;
}> {
  tmux(socketName, ["new-session", "-d", "-s", session]);
  const hub = createIpcHub();
  let closeMain = attachMain(hub, socketName, session);
  const bridge = new ElectronBridge(hub.createRenderer().ipcRenderer, demoIpc);
  const conn = new BridgePaneStreamClient(bridge);
  bridge.connect("");
  const close = (): void => {
    bridge.disconnect();
    closeMain();
  };
  try {
    await pollUntil(() => conn.connectionState.status === "ready");
  } catch (err) {
    close();
    throw new Error("the Electron page never became ready", { cause: err });
  }
  return {
    bridge,
    conn,
    // SocketBadge's swap: the page lets go of main, main re-attaches, the
    // page connects again.
    swapMain: () => {
      bridge.disconnect();
      closeMain();
      closeMain = attachMain(hub, socketName, session);
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
    it("keeps a window sink attached before it receiving its window's output after it", async () => {
      const socketName = uniqueSocket("tmux-scope-test-", "electron-swap");
      const page = await electronPage(socketName, uniqueName("swap"));
      try {
        const [pane] = await listAllPanes(page.conn);
        const arrived: ArrivedChunk[] = [];
        let ended = false;
        page.conn.attachBytesSink(
          { ...makeRecordingSink(arrived), end: () => (ended = true) },
          { scope: windowScope(pane.windowId) },
        );

        page.swapMain();
        await pollUntil(() => page.conn.connectionState.status === "ready");
        await sendOutputToPane(page.conn, pane.paneId);

        await pollUntil(() =>
          textOf(arrived, pane.paneId).includes(`scope-test-${pane.paneId}`),
        );
        expect(ended).toBe(false);
      } finally {
        page.close();
        killTmuxServer(socketName);
      }
    });
  },
);
