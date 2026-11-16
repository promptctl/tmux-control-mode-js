// tests/unit/electron-invoke-pipeline.test.ts
// Isolation tests for InvokePipeline — the parse→dispatch→encode collaborator
// extracted from createMainBridge (GM3). Driven here directly (no ipcMain):
// the pipeline is constructed standalone over a real BridgeConnection +
// SenderRegistry + TmuxClient (fake transport), proving the decomposition seam
// holds. Full dispatch/abort/timeout behavior through the shell is covered by
// electron-bridge.test.ts; these assert the pipeline's own surface — the
// RpcError→envelope mapping and drain tracking — in isolation.

import { describe, expect, it } from "vitest";

import { TmuxClient } from "../../src/client.js";
import type { TmuxTransport } from "../../src/transport/types.js";
import { createBridgeConnection } from "../../src/connectors/bridge-connection.js";
import { SenderRegistry } from "../../src/connectors/electron/sender-registry.js";
import { InvokePipeline } from "../../src/connectors/electron/invoke-pipeline.js";
import {
  IPC,
  type InvokeResultEnvelope,
  type IpcMainEventLike,
  type IpcRendererOnListener,
} from "../../src/connectors/electron/types.js";
import { createIpcHub, type FakeRenderer } from "./_helpers/ipc-hub.js";
import { STARTUP_GREETING } from "./_helpers/greeting.js";
import { replyTo } from "./_helpers/wire.js";

interface Rig {
  readonly pipeline: InvokePipeline;
  readonly registry: SenderRegistry;
  readonly renderer: FakeRenderer;
  readonly event: IpcMainEventLike;
  readonly sent: string[];
  /** Feed a raw control-mode chunk (e.g. a command's %begin/%end reply). */
  feed(chunk: string): void;
}

function makeRig(): Rig {
  const sent: string[] = [];
  let dataCb: ((chunk: string) => void) | null = null;
  const transport: TmuxTransport = {
    send(cmd) {
      sent.push(cmd);
      return { ok: true };
    },
    onData(cb) {
      dataCb = cb;
    },
    onClose() {
      // No close handling needed — these tests never close the transport.
    },
    close() {
      // No-op: the pipeline surface under test never closes the transport.
    },
  };
  const feed = (chunk: string): void => dataCb?.(chunk);
  const client = new TmuxClient(transport);
  // Feed the startup greeting so the client is ready to dispatch commands.
  feed(STARTUP_GREETING);
  const bridge = createBridgeConnection({
    client,
    forwardsLifecycle: false,
    reportResumeFailure: () => {
      // No stranded-resume surfacing asserted by these tests.
    },
    reportCoverageReleaseFailure: () => {},
  });
  const registry = new SenderRegistry({ bridge, client });
  const pipeline = new InvokePipeline({ bridge, client, registry });
  const renderer = createIpcHub().createRenderer();
  return { pipeline, registry, renderer, event: renderer.event, sent, feed };
}

let lastId = 0;

// Hand `req` to the pipeline as `renderer`'s invoke, and resolve with the reply
// wherever main put it: on `IPC.event` under the invoke's id, or in the
// handler's return.
function answer(
  pipeline: InvokePipeline,
  renderer: FakeRenderer,
  req: unknown,
): Promise<InvokeResultEnvelope> {
  const id = ++lastId;
  const ipc = renderer.ipcRenderer;
  return new Promise((resolve, reject) => {
    const hear: IpcRendererOnListener = (_e, msg) => {
      if (msg.type !== "invoke-reply" || msg.id !== id) return;
      ipc.removeListener(IPC.event, hear);
      resolve(msg.result);
    };
    ipc.on(IPC.event, hear);
    pipeline.handle(renderer.event, id, req).then((ret) => {
      if (ret.via === "event") return;
      ipc.removeListener(IPC.event, hear);
      resolve(ret.result);
    }, reject);
  });
}

describe("InvokePipeline — validation → envelope", () => {
  it("maps an unknown method to a BRIDGE_UNKNOWN_METHOD envelope without dispatching", async () => {
    const { pipeline, renderer, sent } = makeRig();

    await expect(
      answer(pipeline, renderer, { method: "kill-server", args: [] }),
    ).resolves.toMatchObject({
      status: "bridge-error",
      error: { code: "BRIDGE_UNKNOWN_METHOD" },
    });
    expect(sent).toEqual([]);
  });

  it("answers an invoke whose id is not an integer in the invoke's return, without dispatching", async () => {
    const { pipeline, event, sent } = makeRig();

    await expect(
      pipeline.handle(event, "7", { method: "execute", args: ["ls"] }),
    ).resolves.toMatchObject({
      via: "invoke",
      result: {
        status: "bridge-error",
        error: { code: "BRIDGE_INVALID_REQUEST" },
      },
    });
    expect(sent).toEqual([]);
  });

  it("maps a malformed request envelope to a BRIDGE_INVALID_REQUEST envelope", async () => {
    const { pipeline, renderer, sent } = makeRig();

    await expect(
      answer(pipeline, renderer, "not-an-object"),
    ).resolves.toMatchObject({
      status: "bridge-error",
      error: { code: "BRIDGE_INVALID_REQUEST" },
    });
    await expect(
      answer(pipeline, renderer, { args: [] }),
    ).resolves.toMatchObject({
      status: "bridge-error",
      error: { code: "BRIDGE_INVALID_REQUEST" },
    });
    expect(sent).toEqual([]);
  });
});

describe("InvokePipeline — outcome encoding", () => {
  it("encodes a successful command as an `ok` envelope with the response", async () => {
    const { pipeline, renderer, sent, feed } = makeRig();

    const p = answer(pipeline, renderer, {
      method: "execute",
      args: ["list-windows"],
    });
    feed(replyTo(sent[0], ["@0 zsh 1 -"]));

    await expect(p).resolves.toMatchObject({
      status: "ok",
      response: { success: true, output: ["@0 zsh 1 -"] },
    });
  });

  it("encodes a tmux %error as a `tmux-error` envelope (a successful bridge call)", async () => {
    const { pipeline, renderer, sent, feed } = makeRig();

    const p = answer(pipeline, renderer, {
      method: "execute",
      args: ["bogus"],
    });
    // The command reached tmux, which rejected it with an %error guard block.
    feed(replyTo(sent[0], [], "error"));

    await expect(p).resolves.toMatchObject({ status: "tmux-error" });
  });
});

describe("InvokePipeline — destroyed sender", () => {
  it("aborts an invoke whose sender is already destroyed, without dispatching", async () => {
    const { pipeline, sent } = makeRig();
    const dead = createIpcHub().createRenderer();
    dead.destroy();

    // The queued invoke lands after the renderer died. getOrCreate refuses to
    // resurrect it, so the pipeline aborts BEFORE dispatching.
    await expect(
      answer(pipeline, dead, { method: "execute", args: ["ls"] }),
    ).resolves.toMatchObject({
      status: "bridge-error",
      error: { code: "BRIDGE_ABORTED" },
    });
    // No real tmux command ran for the dead renderer.
    expect(sent).toEqual([]);
  });

  it("aborts an in-flight dispatch when its sender is torn down mid-flight", async () => {
    const { pipeline, registry, renderer, event, sent, feed } = makeRig();

    // Dispatch is in flight, awaiting the command's %begin/%end.
    const p = answer(pipeline, renderer, {
      method: "execute",
      args: ["list-windows"],
    });
    expect(sent.length).toBeGreaterThan(0);

    // Sender torn down WHILE the dispatch awaits — flags its PendingDispatch.
    registry.teardown(event.sender);
    // Now the command resolves; the pipeline sees the abort flag and returns
    // BRIDGE_ABORTED instead of delivering the result to a dead renderer.
    feed(replyTo(sent[0]));

    await expect(p).resolves.toMatchObject({
      status: "bridge-error",
      error: { code: "BRIDGE_ABORTED" },
    });
  });
});

describe("InvokePipeline — drain", () => {
  it("resolves immediately when no invoke is in flight", async () => {
    const { pipeline } = makeRig();
    await expect(pipeline.drain()).resolves.toBeUndefined();
  });

  it("tracks in-flight dispatches: drain(timeout) returns even while a call hangs", async () => {
    const { pipeline, event, sent } = makeRig();

    // A valid execute dispatches to the client and awaits a %begin/%end that
    // never arrives (the fake transport records but never replies), so the
    // handler promise stays pending — proving the pipeline tracked it for drain.
    void pipeline.handle(event, 1, { method: "execute", args: ["ls"] });
    expect(sent.length).toBeGreaterThan(0);

    // Without tracking, drain() would hang; the timeout path returns.
    await expect(pipeline.drain(20)).resolves.toBeUndefined();
  });
});
