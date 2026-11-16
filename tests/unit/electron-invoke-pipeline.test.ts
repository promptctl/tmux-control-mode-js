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
import type {
  InvokeResultEnvelope,
  IpcMainEventLike,
  WebContentsLike,
} from "../../src/connectors/electron/types.js";
import {
  createIpcHub,
  invokeRaw,
  RAW_PROXY,
  type FakeRenderer,
} from "./_helpers/ipc-hub.js";
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
  // A proxy registers before it can invoke (in its constructor).
  registry.register(renderer.event, RAW_PROXY);
  return { pipeline, registry, renderer, event: renderer.event, sent, feed };
}

// Hand `req` to the pipeline as `renderer`'s invoke, and resolve with its reply.
function answer(
  pipeline: InvokePipeline,
  renderer: FakeRenderer,
  req: unknown,
): Promise<InvokeResultEnvelope> {
  return invokeRaw(renderer.ipcRenderer, req, (call) =>
    pipeline.handle(renderer.event, call),
  );
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

  it("answers an invoke that names no proxy in the invoke's return, without dispatching", async () => {
    const { pipeline, event, sent } = makeRig();

    await expect(
      pipeline.handle(event, {
        id: 7,
        request: { method: "execute", args: ["ls"] },
      }),
    ).resolves.toMatchObject({
      via: "invoke",
      result: {
        status: "bridge-error",
        error: { code: "BRIDGE_INVALID_REQUEST" },
      },
    });
    expect(sent).toEqual([]);
  });

  it("answers an invoke whose id is not an integer in the invoke's return, without dispatching", async () => {
    const { pipeline, event, sent } = makeRig();

    await expect(
      pipeline.handle(event, {
        proxy: RAW_PROXY,
        id: "7",
        request: { method: "execute", args: ["ls"] },
      }),
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

    // The queued invoke lands after the renderer died. Its page's peers are
    // gone, so the pipeline aborts BEFORE dispatching.
    await expect(
      answer(pipeline, dead, { method: "execute", args: ["ls"] }),
    ).resolves.toMatchObject({
      status: "bridge-error",
      error: { code: "BRIDGE_ABORTED" },
    });
    // No real tmux command ran for the dead renderer.
    expect(sent).toEqual([]);
  });

  it("aborts an invoke naming a proxy its live page never registered, opening no peer", async () => {
    const { pipeline, registry, event, sent } = makeRig();
    const stranger = RAW_PROXY - 1;

    await expect(
      pipeline.handle(event, {
        proxy: stranger,
        id: 1,
        request: { method: "execute", args: ["ls"] },
      }),
    ).resolves.toMatchObject({
      via: "invoke",
      result: { status: "bridge-error", error: { code: "BRIDGE_ABORTED" } },
    });
    expect(sent).toEqual([]);
    expect(registry.registered(event, stranger)).toBeUndefined();
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

  it("answers in the return when the WebContents is destroyed before its teardown arrives", async () => {
    const { pipeline, registry, renderer, sent, feed } = makeRig();
    // Electron reports `destroyed` a task after the WebContents dies, so the
    // sender is still registered when the dispatch settles.
    let destroyed = false;
    const sender = Object.create(renderer.sender, {
      isDestroyed: { value: () => destroyed },
    }) as WebContentsLike;
    const event = { ...renderer.event, sender };
    registry.register(event, RAW_PROXY);

    const p = pipeline.handle(event, {
      proxy: RAW_PROXY,
      id: 1,
      request: { method: "execute", args: ["list-windows"] },
    });
    destroyed = true;
    feed(replyTo(sent[0]));

    await expect(p).resolves.toMatchObject({
      via: "invoke",
      result: { status: "ok" },
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
    void pipeline.handle(event, {
      proxy: RAW_PROXY,
      id: 1,
      request: { method: "execute", args: ["ls"] },
    });
    expect(sent.length).toBeGreaterThan(0);

    // Without tracking, drain() would hang; the timeout path returns.
    await expect(pipeline.drain(20)).resolves.toBeUndefined();
  });
});
