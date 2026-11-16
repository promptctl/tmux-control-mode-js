// examples/web-multiplexer/web/electron-bridge.test.ts
//
// The ElectronBridge keeps the TmuxBridge command contract the WebSocket
// bridge keeps: a tmux %error resolves as `{success: false}`, and only a
// bridge failure rejects and reaches onError. The renderer proxy runs for
// real over an IPC whose invoke answers with a fixed envelope.
//
// The file reads the package's built dist/ as the demo does: run
// `pnpm run build` first.

import { describe, it, expect } from "vitest";
import type { IpcRendererLike } from "@promptctl/tmux-control-mode-js/electron/renderer";
import type { CommandResponse } from "@promptctl/tmux-control-mode-js/protocol";
import type { WireEntry } from "./bridge.ts";
import type { DemoIpc } from "./demo-ipc.ts";
import { ElectronBridge } from "./electron-bridge.ts";

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

function connectedBridge(envelope: unknown): {
  bridge: ElectronBridge;
  errors: string[];
  wire: WireEntry["dir"][];
} {
  const ipc: IpcRendererLike = {
    invoke: () => Promise.resolve(envelope),
    send: () => undefined,
    on: () => undefined,
    removeListener: () => undefined,
  };
  const bridge = new ElectronBridge(ipc, demoIpc);
  const errors: string[] = [];
  const wire: WireEntry["dir"][] = [];
  bridge.onError((message) => errors.push(message));
  bridge.onWire((entry) => wire.push(entry.dir));
  bridge.connect("");
  return { bridge, errors, wire };
}

describe("ElectronBridge command contract", () => {
  it("resolves a tmux %error as a failed reply, logged as a response and not as a bridge error", async () => {
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

    await expect(bridge.execute("list-panes -t @9")).resolves.toEqual(failed);
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
