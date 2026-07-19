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
  IpcMainInvokeEventLike,
  WebContentsLike,
} from "../../src/connectors/electron/types.js";
import { createIpcHub } from "./_helpers/ipc-hub.js";
import { STARTUP_GREETING } from "./_helpers/greeting.js";

interface Rig {
  readonly pipeline: InvokePipeline;
  readonly event: IpcMainInvokeEventLike;
  readonly sent: string[];
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
    reportResumeFailure: () => {
      // No stranded-resume surfacing asserted by these tests.
    },
  });
  const registry = new SenderRegistry({ bridge, client });
  const pipeline = new InvokePipeline({ bridge, client, registry });
  const event: IpcMainInvokeEventLike = {
    sender: createIpcHub().createRenderer().sender,
  };
  return { pipeline, event, sent };
}

describe("InvokePipeline — validation → envelope", () => {
  it("maps an unknown method to a BRIDGE_UNKNOWN_METHOD envelope without dispatching", async () => {
    const { pipeline, event, sent } = makeRig();

    await expect(
      pipeline.handle(event, { method: "kill-server", args: [] }),
    ).resolves.toMatchObject({
      status: "bridge-error",
      error: { code: "BRIDGE_UNKNOWN_METHOD" },
    });
    expect(sent).toEqual([]);
  });

  it("maps a malformed request envelope to a BRIDGE_INVALID_REQUEST envelope", async () => {
    const { pipeline, event, sent } = makeRig();

    await expect(
      pipeline.handle(event, "not-an-object"),
    ).resolves.toMatchObject({
      status: "bridge-error",
      error: { code: "BRIDGE_INVALID_REQUEST" },
    });
    await expect(pipeline.handle(event, { args: [] })).resolves.toMatchObject({
      status: "bridge-error",
      error: { code: "BRIDGE_INVALID_REQUEST" },
    });
    expect(sent).toEqual([]);
  });
});

describe("InvokePipeline — destroyed sender", () => {
  it("aborts an invoke whose sender is already destroyed, without dispatching", async () => {
    const { pipeline, sent } = makeRig();
    const deadWc: WebContentsLike = {
      send() {
        // A destroyed renderer receives nothing.
      },
      once() {
        // No destroyed-listener wiring for an already-dead wc.
      },
      removeListener() {
        // Nothing was attached.
      },
      isDestroyed: () => true,
    };

    // The queued invoke lands after the renderer died. getOrCreate refuses to
    // resurrect it, so the pipeline aborts BEFORE dispatching.
    await expect(
      pipeline.handle({ sender: deadWc }, { method: "execute", args: ["ls"] }),
    ).resolves.toMatchObject({
      status: "bridge-error",
      error: { code: "BRIDGE_ABORTED" },
    });
    // No real tmux command ran for the dead renderer.
    expect(sent).toEqual([]);
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
    void pipeline.handle(event, { method: "execute", args: ["ls"] });
    expect(sent.length).toBeGreaterThan(0);

    // Without tracking, drain() would hang; the timeout path returns.
    await expect(pipeline.drain(20)).resolves.toBeUndefined();
  });
});
