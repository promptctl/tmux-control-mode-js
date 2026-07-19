// tests/unit/electron-bridge.test.ts
// Unit tests for the Electron IPC bridge: createMainBridge + createRendererBridge.
//
// Uses an in-memory IPC hub to couple a fake IpcMain with one or more fake
// IpcRenderers, plus a fake TmuxTransport to drive a real TmuxClient. No real
// Electron is involved.
//
// IMPORTANT: the fake IpcMain mirrors real Electron semantics — second
// handle() call for the same channel throws. The audit (e07.5/C1) called out
// that the previous silent-overwrite hub hid a real production crash.

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

import { TmuxClient } from "../../src/client.js";
import { isTmuxMessage } from "../../src/emitter.js";
import { TmuxCommandError } from "../../src/errors.js";
import type { TmuxTransport } from "../../src/transport/types.js";
import type { TmuxMessage } from "../../src/protocol/types.js";
import { paneScope, sessionScope } from "../../src/pane-output.js";
import {
  IPC,
  type IpcRendererLike,
  type WebContentsLike,
  parseAckMessage,
  BridgeError,
} from "../../src/connectors/electron/types.js";
import { createMainBridge } from "../../src/connectors/electron/main.js";
import {
  createRendererBridge,
  TmuxClientProxy,
} from "../../src/connectors/electron/renderer.js";
import { RPC_METHOD_NAMES } from "../../src/connectors/rpc.js";
import {
  createIpcHub,
  type FakeRenderer,
  type IpcHub,
} from "./_helpers/ipc-hub.js";
import { STARTUP_GREETING } from "./_helpers/greeting.js";

// ---------------------------------------------------------------------------
// Test-only types
// ---------------------------------------------------------------------------
// `FakeRenderer` and `createIpcHub` live in `./_helpers/ipc-hub.ts` so other
// test files (e.g. connection-state) can drive the bridges without
// duplicating the in-memory IPC scaffolding.

interface FakeTransport {
  readonly transport: TmuxTransport;
  readonly sent: string[];
  feed(chunk: string): void;
  fireClose(reason?: string): void;
}

function createFakeTransport(): FakeTransport {
  let dataCb: ((chunk: string) => void) | null = null;
  let closeCb: ((reason?: string) => void) | null = null;
  const sent: string[] = [];

  const transport: TmuxTransport = {
    send(cmd) {
      sent.push(cmd);
      return { ok: true };
    },
    onData(cb) {
      dataCb = cb;
    },
    onClose(cb) {
      closeCb = cb;
    },
    close() {
      closeCb?.("closed");
    },
  };

  return {
    transport,
    sent,
    feed(chunk) {
      dataCb?.(chunk);
    },
    fireClose(reason) {
      closeCb?.(reason);
    },
  };
}

/**
 * Feed tmux's response to the most recently sent command.
 * Matches the begin/end flanking used across the codebase.
 */
function feedCommandResponse(
  t: FakeTransport,
  commandNumber: number,
  outputLines: readonly string[],
): void {
  t.feed(`%begin ${commandNumber} ${commandNumber} 0\n`);
  for (const line of outputLines) t.feed(line + "\n");
  t.feed(`%end ${commandNumber} ${commandNumber} 0\n`);
}

// ---------------------------------------------------------------------------
// C1 — single-instance enforcement
// ---------------------------------------------------------------------------

describe("Electron IPC bridge — C1 single-instance", () => {
  it("throws ALREADY_REGISTERED on a second createMainBridge for the same ipcMain", () => {
    const hub = createIpcHub();
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    t.feed(STARTUP_GREETING);
    createMainBridge(client, hub.ipcMain);

    expect(() => createMainBridge(client, hub.ipcMain)).toThrow(
      /ALREADY_REGISTERED/,
    );
  });

  it("releases the ipcMain on dispose so a fresh bridge can install", () => {
    const hub = createIpcHub();
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    t.feed(STARTUP_GREETING);
    const handle = createMainBridge(client, hub.ipcMain);
    handle.dispose();

    // Should not throw.
    const handle2 = createMainBridge(client, hub.ipcMain);
    expect(handle2).toBeDefined();
    handle2.dispose();
  });
});

// ---------------------------------------------------------------------------
// C2 — input validation on renderer requests
// ---------------------------------------------------------------------------

describe("Electron IPC bridge — C2 input validation", () => {
  it("rejects unknown methods without touching the client", async () => {
    const hub = createIpcHub();
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    t.feed(STARTUP_GREETING);
    createMainBridge(client, hub.ipcMain);

    const renderer = hub.createRenderer();

    await expect(
      renderer.ipcRenderer.invoke(IPC.invoke, {
        method: "kill-server",
        args: [],
      }),
    ).resolves.toMatchObject({
      status: "bridge-error",
      error: { code: "BRIDGE_UNKNOWN_METHOD" },
    });
    expect(t.sent).toEqual([]);
  });

  it("rejects malformed envelope (non-object, missing method, non-array args)", async () => {
    const hub = createIpcHub();
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    t.feed(STARTUP_GREETING);
    createMainBridge(client, hub.ipcMain);

    const renderer = hub.createRenderer();

    await expect(
      renderer.ipcRenderer.invoke(IPC.invoke, "not-an-object"),
    ).resolves.toMatchObject({
      status: "bridge-error",
      error: { code: "BRIDGE_INVALID_REQUEST" },
    });
    await expect(
      renderer.ipcRenderer.invoke(IPC.invoke, { args: [] }),
    ).resolves.toMatchObject({
      status: "bridge-error",
      error: { code: "BRIDGE_INVALID_REQUEST" },
    });
    await expect(
      renderer.ipcRenderer.invoke(IPC.invoke, {
        method: "execute",
        args: "not-an-array",
      }),
    ).resolves.toMatchObject({
      status: "bridge-error",
      error: { code: "BRIDGE_INVALID_REQUEST" },
    });
    expect(t.sent).toEqual([]);
  });

  it("rejects bad arg shapes (wrong arity, wrong type)", async () => {
    const hub = createIpcHub();
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    t.feed(STARTUP_GREETING);
    createMainBridge(client, hub.ipcMain);

    const renderer = hub.createRenderer();

    const expectInvalidArg = async (req: object): Promise<void> => {
      await expect(
        renderer.ipcRenderer.invoke(IPC.invoke, req),
      ).resolves.toMatchObject({
        status: "bridge-error",
        error: { code: "BRIDGE_INVALID_ARG" },
      });
    };

    // execute requires 1 string arg.
    await expectInvalidArg({ method: "execute", args: [] });
    await expectInvalidArg({ method: "execute", args: [42] });
    // sendKeys requires 2 strings.
    await expectInvalidArg({ method: "sendKeys", args: ["%0"] });
    // setPaneAction requires (number, PaneAction).
    await expectInvalidArg({
      method: "setPaneAction",
      args: [1, "bogus-action"],
    });
    // setFlags requires string[].
    await expectInvalidArg({ method: "setFlags", args: [[1, 2, 3]] });
    expect(t.sent).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// C3 — prototype-chain lookups must not resolve
// ---------------------------------------------------------------------------

describe("Electron IPC bridge — C3 prototype pollution", () => {
  it("rejects method='constructor' / '__proto__' / 'toString' as UNKNOWN_METHOD", async () => {
    const hub = createIpcHub();
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    t.feed(STARTUP_GREETING);
    createMainBridge(client, hub.ipcMain);

    const renderer = hub.createRenderer();

    for (const evil of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      await expect(
        renderer.ipcRenderer.invoke(IPC.invoke, { method: evil, args: [] }),
      ).resolves.toMatchObject({
        status: "bridge-error",
        error: { code: "BRIDGE_UNKNOWN_METHOD" },
      });
    }
    expect(t.sent).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// C4 — backpressure preserved across IPC
// ---------------------------------------------------------------------------

describe("Electron IPC bridge — C4 backpressure", () => {
  it("emits setPaneAction(Pause) once per-pane outstanding crosses the high watermark", () => {
    const hub = createIpcHub();
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    t.feed(STARTUP_GREETING);
    // Tiny watermarks: 100B high, 25B low. Renderer ackBatchBytes set high so
    // the renderer never acks during this test — we want main to observe
    // unbounded outstanding bytes.
    createMainBridge(client, hub.ipcMain, {
      outputHighWatermark: 100,
      outputLowWatermark: 25,
    });

    const renderer = hub.createRenderer();
    createRendererBridge(renderer.ipcRenderer, { ackBatchBytes: 1 << 30 });

    // 5 chunks of 30 bytes = 150 bytes outstanding > 100 → pause emitted once.
    for (let i = 0; i < 5; i++) {
      t.feed(`%output %2 ${"x".repeat(30)}\n`);
    }

    const pauseCmds = t.sent.filter(
      (c) => c.includes("refresh-client") && c.includes("%2:pause"),
    );
    expect(pauseCmds).toHaveLength(1);
  });

  it("emits setPaneAction(Continue) once tmux:ack drops outstanding below the low watermark", () => {
    const hub = createIpcHub();
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    t.feed(STARTUP_GREETING);
    createMainBridge(client, hub.ipcMain, {
      outputHighWatermark: 100,
      outputLowWatermark: 25,
    });

    // No proxy — register manually so the test owns ack timing. The proxy's
    // auto-ack is a real-IPC convenience; here we want deterministic control.
    const renderer = hub.createRenderer();
    renderer.ipcRenderer.send(IPC.register);

    for (let i = 0; i < 5; i++) {
      t.feed(`%output %3 ${"x".repeat(30)}\n`);
    }
    // 5×30 = 150 outstanding, > high=100 → one pause fired.
    expect(
      t.sent.filter((c) => c.includes("%3:pause")),
    ).toHaveLength(1);
    expect(
      t.sent.filter((c) => c.includes("%3:continue")),
    ).toHaveLength(0);

    // Ack 130 bytes → outstanding = 20 < low=25 → exactly one continue.
    renderer.ipcRenderer.send(IPC.ack, { paneId: 3, bytes: 130 });
    expect(
      t.sent.filter((c) => c.includes("%3:continue")),
    ).toHaveLength(1);
  });

  it("does not re-pause on every chunk while already paused", () => {
    const hub = createIpcHub();
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    t.feed(STARTUP_GREETING);
    createMainBridge(client, hub.ipcMain, {
      outputHighWatermark: 100,
      outputLowWatermark: 25,
    });

    const renderer = hub.createRenderer();
    renderer.ipcRenderer.send(IPC.register);

    for (let i = 0; i < 20; i++) {
      t.feed(`%output %7 ${"x".repeat(30)}\n`);
    }
    expect(
      t.sent.filter((c) => c.includes("%7:pause")),
    ).toHaveLength(1);
  });

  it("counts outstanding bytes per renderer separately (sum across renderers drives pause)", () => {
    const hub = createIpcHub();
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    t.feed(STARTUP_GREETING);
    createMainBridge(client, hub.ipcMain, {
      outputHighWatermark: 100,
      outputLowWatermark: 25,
    });

    // Two raw subscribers; neither auto-acks.
    const r1 = hub.createRenderer();
    const r2 = hub.createRenderer();
    r1.ipcRenderer.send(IPC.register);
    r2.ipcRenderer.send(IPC.register);

    // Each chunk fans out to BOTH renderers, so per-pane total grows by 60
    // (2 × 30) per chunk. 2 chunks = 120 > 100 → pause.
    t.feed(`%output %9 ${"x".repeat(30)}\n`);
    expect(t.sent.filter((c) => c.includes("%9:pause"))).toHaveLength(0);
    t.feed(`%output %9 ${"x".repeat(30)}\n`);
    expect(t.sent.filter((c) => c.includes("%9:pause"))).toHaveLength(1);

    // Drop r2 → its 60 bytes evaporate → outstanding = 60 > low=25 → no resume.
    r2.destroy();
    expect(t.sent.filter((c) => c.includes("%9:continue"))).toHaveLength(0);

    // Ack the rest from r1 → outstanding = 0 → resume.
    r1.ipcRenderer.send(IPC.ack, { paneId: 9, bytes: 60 });
    expect(t.sent.filter((c) => c.includes("%9:continue"))).toHaveLength(1);
  });

  it("invalidates this renderer's outstanding bytes when WebContents is destroyed (resume fires)", () => {
    const hub = createIpcHub();
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    t.feed(STARTUP_GREETING);
    createMainBridge(client, hub.ipcMain, {
      outputHighWatermark: 100,
      outputLowWatermark: 25,
    });

    const renderer = hub.createRenderer();
    // High ack batch so renderer never acks before destruction.
    createRendererBridge(renderer.ipcRenderer, { ackBatchBytes: 1 << 30 });

    for (let i = 0; i < 5; i++) {
      t.feed(`%output %4 ${"x".repeat(30)}\n`);
    }
    expect(
      t.sent.filter((c) => c.includes("%4:pause")),
    ).toHaveLength(1);

    renderer.destroy();
    // Destroy → drop subscriber → outstanding for pane %4 drops to 0 → resume.
    expect(
      t.sent.filter((c) => c.includes("%4:continue")),
    ).toHaveLength(1);
  });

  it("dispose resumes any panes the bridge had paused", () => {
    const hub = createIpcHub();
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    t.feed(STARTUP_GREETING);
    const handle = createMainBridge(client, hub.ipcMain, {
      outputHighWatermark: 100,
      outputLowWatermark: 25,
    });

    const renderer = hub.createRenderer();
    createRendererBridge(renderer.ipcRenderer, { ackBatchBytes: 1 << 30 });

    for (let i = 0; i < 5; i++) {
      t.feed(`%output %5 ${"x".repeat(30)}\n`);
    }
    handle.dispose();

    expect(
      t.sent.filter((c) => c.includes("%5:continue")),
    ).toHaveLength(1);
  });

  it("rejects invalid watermark configuration", () => {
    const hub = createIpcHub();
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    t.feed(STARTUP_GREETING);
    expect(() =>
      createMainBridge(client, hub.ipcMain, {
        outputHighWatermark: 10,
        outputLowWatermark: 50,
      }),
    ).toThrow(/INVALID_ARG/);
  });
});

// ---------------------------------------------------------------------------
// Event forwarding
// ---------------------------------------------------------------------------

describe("Electron IPC bridge — event forwarding", () => {
  it("forwards tmux events from main to a registered renderer", () => {
    const hub = createIpcHub();
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    t.feed(STARTUP_GREETING);
    createMainBridge(client, hub.ipcMain);

    const renderer = hub.createRenderer();
    const proxy = createRendererBridge(renderer.ipcRenderer);

    const typed: TmuxMessage[] = [];
    const wildcard: TmuxMessage[] = [];
    proxy.on("window-add", (ev) => typed.push(ev));
    // Filter to parsed-tmux events so the synthetic connection-state snapshot
    // that main sends on register doesn't perturb the count.
    // [LAW:single-enforcer] use the same discriminator as runtime filtering
    // (src/emitter.ts:isTmuxMessage); inline copies drift when the synthetic
    // event set grows.
    proxy.on("*", (ev) => {
      if (isTmuxMessage(ev)) {
        wildcard.push(ev);
      }
    });

    t.feed("%window-add @5\n");
    t.feed("%session-renamed $1 my-session\n");

    expect(typed).toEqual([{ type: "window-add", windowId: 5 }]);
    expect(wildcard).toHaveLength(2);
    expect(wildcard[0]?.type).toBe("window-add");
    expect(wildcard[1]?.type).toBe("session-renamed");
  });

  it("does NOT forward the main client's topology-error to renderers (each client owns its own bootstrap)", () => {
    const hub = createIpcHub();
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    t.feed(STARTUP_GREETING); // main reaches ready
    createMainBridge(client, hub.ipcMain);

    const renderer = hub.createRenderer();
    const proxy = createRendererBridge(renderer.ipcRenderer);

    const rendererTopoErrors: unknown[] = [];
    proxy.on("topology-error", (ev) => rendererTopoErrors.push(ev));

    // Make the MAIN client topology-dependent so its own router bootstraps
    // (already ready → bootstrap fires immediately) and issues `list-panes -a`.
    client.attachBytesSink({ write() {}, end() {} }, { scope: sessionScope(1) });
    expect(t.sent.some((c) => c.includes("list-panes -a"))).toBe(true);

    // Reject that bootstrap → the MAIN client emits topology-error locally.
    t.feed("%begin 1 1 0\n%error 1 1 0\n");

    // The renderer proxy has its own router and reports its own failures; the
    // main client's per-instance topology-error must not cross the bridge.
    expect(rendererTopoErrors).toHaveLength(0);
  });

  it("preserves Uint8Array contents through OutputMessage round-trip", () => {
    // Electron IPC uses structured clone, which preserves Uint8Array natively.
    // The hub now mirrors that with `cloneArgs` (structuredClone per arg) so
    // a regression that depends on shared identity — or stringifies anywhere
    // along the path — fails here the same way it would in production.
    //
    // Pane bytes flow through `attachBytesSink`, not the emitter — the
    // proxy's `on('output', …)` is a TS error because `TmuxEventMap` does
    // not contain `'output'`.
    const hub = createIpcHub();
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    t.feed(STARTUP_GREETING);
    createMainBridge(client, hub.ipcMain);

    const renderer = hub.createRenderer();
    const proxy = createRendererBridge(renderer.ipcRenderer);

    const received: Uint8Array[] = [];
    proxy.attachBytesSink(
      {
        write(msg) {
          // BytesSink contract: msg.data is read-only, copy before retention.
          received.push(msg.data.slice());
        },
        end() {},
      },
      { scope: paneScope(2) },
    );

    t.feed("%output %2 hello\n");

    expect(received).toHaveLength(1);
    expect(received[0]).toBeInstanceOf(Uint8Array);
    expect(Array.from(received[0]!)).toEqual(
      Array.from(new TextEncoder().encode("hello")),
    );
  });

  it("fans events out to multiple registered renderers", () => {
    const hub = createIpcHub();
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    t.feed(STARTUP_GREETING);
    createMainBridge(client, hub.ipcMain);

    const a = hub.createRenderer();
    const b = hub.createRenderer();
    const pa = createRendererBridge(a.ipcRenderer);
    const pb = createRendererBridge(b.ipcRenderer);

    const receivedA: number[] = [];
    const receivedB: number[] = [];
    pa.on("window-add", (ev) => receivedA.push(ev.windowId));
    pb.on("window-add", (ev) => receivedB.push(ev.windowId));

    t.feed("%window-add @7\n");

    expect(receivedA).toEqual([7]);
    expect(receivedB).toEqual([7]);
  });

  it("stops forwarding to a renderer once its WebContents is destroyed", () => {
    const hub = createIpcHub();
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    t.feed(STARTUP_GREETING);
    createMainBridge(client, hub.ipcMain);

    const renderer = hub.createRenderer();
    const proxy = createRendererBridge(renderer.ipcRenderer);

    const received: number[] = [];
    proxy.on("window-add", (ev) => received.push(ev.windowId));

    t.feed("%window-add @1\n");
    renderer.destroy();
    t.feed("%window-add @2\n");

    expect(received).toEqual([1]);
  });

  it("proxy.close unsubscribes from further events", () => {
    const hub = createIpcHub();
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    t.feed(STARTUP_GREETING);
    createMainBridge(client, hub.ipcMain);

    const renderer = hub.createRenderer();
    const proxy = createRendererBridge(renderer.ipcRenderer);

    const received: number[] = [];
    proxy.on("window-add", (ev) => received.push(ev.windowId));

    t.feed("%window-add @1\n");
    proxy.close();
    t.feed("%window-add @2\n");

    expect(received).toEqual([1]);
  });
});

// ---------------------------------------------------------------------------
// Method dispatch
// ---------------------------------------------------------------------------

describe("Electron IPC bridge — method dispatch", () => {
  it("proxy.execute routes through main and resolves with CommandResponse", async () => {
    const hub = createIpcHub();
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    t.feed(STARTUP_GREETING);
    createMainBridge(client, hub.ipcMain);

    const renderer = hub.createRenderer();
    const proxy = createRendererBridge(renderer.ipcRenderer);

    const pending = proxy.execute("list-windows");
    expect(t.sent).toEqual(["list-windows\n"]);

    feedCommandResponse(t, 1, ["@0 zsh 1 -"]);

    const response = await pending;
    expect(response.success).toBe(true);
    expect(response.output).toEqual(["@0 zsh 1 -"]);
  });

  it("sendKeys passes target and keys verbatim", async () => {
    const hub = createIpcHub();
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    t.feed(STARTUP_GREETING);
    createMainBridge(client, hub.ipcMain);

    const renderer = hub.createRenderer();
    const proxy = createRendererBridge(renderer.ipcRenderer);

    const pending = proxy.sendKeys("%0", "hello");
    expect(t.sent[0]).toContain("send-keys");
    expect(t.sent[0]).toContain("%0");
    // Keys are sent as raw UTF-8 hex bytes (`send -H`): "hello".
    expect(t.sent[0]).toContain("68 65 6c 6c 6f");

    feedCommandResponse(t, 1, []);
    await pending;
  });

  it("splitWindow forwards the options object", async () => {
    const hub = createIpcHub();
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    t.feed(STARTUP_GREETING);
    createMainBridge(client, hub.ipcMain);

    const renderer = hub.createRenderer();
    const proxy = createRendererBridge(renderer.ipcRenderer);

    const pending = proxy.splitWindow({ vertical: true, target: "%0" });
    expect(t.sent[0]).toContain("split-window");
    expect(t.sent[0]).toContain("-v");
    expect(t.sent[0]).toContain("%0");

    feedCommandResponse(t, 1, []);
    await pending;
  });

  it("setFlags forwards a readonly string array", async () => {
    const hub = createIpcHub();
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    t.feed(STARTUP_GREETING);
    createMainBridge(client, hub.ipcMain);

    const renderer = hub.createRenderer();
    const proxy = createRendererBridge(renderer.ipcRenderer);

    const pending = proxy.setFlags(["pause-after=2", "no-output"]);
    expect(t.sent[0]).toContain("refresh-client");
    expect(t.sent[0]).toContain("pause-after=2");
    expect(t.sent[0]).toContain("no-output");

    feedCommandResponse(t, 1, []);
    await pending;
  });

  it("requestReport passes paneId and escape-sequence payload", async () => {
    const hub = createIpcHub();
    const t = createFakeTransport();

    // [LAW:no-ambient-temporal-coupling] requestReport now probes the tmux
    // version (refresh-client -r needs 3.5+) before sending the report, so the
    // bridge path makes two round-trips. Drive ordering with the real promise
    // chain — not microtask polling — via an auto-responding transport: each
    // command is answered as it is sent (version probe → "3.6a", everything
    // else → empty success). The test then awaits requestReport to full
    // resolution and inspects t.sent at the end.
    let respNum = 0;
    const record = t.transport.send.bind(t.transport);
    t.transport.send = (cmd: string) => {
      const result = record(cmd);
      respNum += 1;
      const output = cmd.includes("#{version}") ? ["3.6a"] : [];
      feedCommandResponse(t, respNum, output);
      return result;
    };

    const client = new TmuxClient(t.transport);
    t.feed(STARTUP_GREETING);
    createMainBridge(client, hub.ipcMain);

    const renderer = hub.createRenderer();
    const proxy = createRendererBridge(renderer.ipcRenderer);

    const report = "\u001b]10;rgb:1818/1818/1818\u001b\\";
    await proxy.requestReport(3, report);

    const reportCmd = t.sent.find((c) => c.includes("refresh-client -r"));
    expect(reportCmd).toBeDefined();
    expect(reportCmd).toContain("%3");
  });

  it("detach is NOT exposed on the proxy (admin-only) and renderer attempts are rejected", async () => {
    // H2: detach tears down the tmux client for every renderer sharing the
    // bridge — it is an admin operation owned by the main process, not any
    // single window. A renderer that crafts a raw {method:'detach'} request
    // is rejected at the trust boundary with UNKNOWN_METHOD; tmux never sees
    // the LF detach signal (so no other windows get torn down).
    const hub = createIpcHub();
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    t.feed(STARTUP_GREETING);
    createMainBridge(client, hub.ipcMain);

    const renderer = hub.createRenderer();
    const proxy = createRendererBridge(renderer.ipcRenderer);

    // Compile-time: TmuxClientProxy must not expose detach.
    expect((proxy as unknown as { detach?: unknown }).detach).toBeUndefined();

    // Runtime trust-boundary: bypassing the proxy and crafting a raw IPC
    // payload still gets rejected with BRIDGE_UNKNOWN_METHOD.
    await expect(
      renderer.ipcRenderer.invoke(IPC.invoke, { method: "detach", args: [] }),
    ).resolves.toMatchObject({
      status: "bridge-error",
      error: { code: "BRIDGE_UNKNOWN_METHOD" },
    });
    expect(t.sent).toEqual([]);
  });

  it("wraps unexpected dispatch errors with method context (H3)", async () => {
    // H3: when the dispatcher's call into TmuxClient throws an unexpected
    // sync error (here: an encoder failure simulated by a transport that
    // rejects send), the bridge re-wraps the error with method context and
    // the cause stack. The renderer must NOT see a bare opaque "send failed"
    // message because that gives no signal about which call broke.
    const hub = createIpcHub();
    const t = createFakeTransport();
    // Make `send` throw — TmuxClient.execute calls transport.send synchronously.
    (t.transport as { send: (cmd: string) => void }).send = () => {
      throw new Error("transport offline");
    };
    const client = new TmuxClient(t.transport);
    t.feed(STARTUP_GREETING);
    createMainBridge(client, hub.ipcMain);

    const renderer = hub.createRenderer();
    const proxy = createRendererBridge(renderer.ipcRenderer);

    await expect(proxy.execute("list-windows")).rejects.toThrow(
      /BRIDGE_INTERNAL.*method=execute.*transport offline/,
    );
  });

  it("classifies a transport send refusal as BRIDGE_CLOSED carrying the reason", async () => {
    // The DESIGNED dead-transport path (vs H3's contract-violating throw):
    // the transport refuses with a typed {ok:false}, TmuxClient.execute
    // rejects with TransportSendError, and the bridge reports it as the
    // operational BRIDGE_CLOSED (never BRIDGE_INTERNAL, which means "bug"),
    // with the refusal reason intact — a swallowed reason would leave the
    // renderer with an unactionable "something failed". [LAW:no-silent-failure]
    const hub = createIpcHub();
    const t = createFakeTransport();
    t.transport.send = () => ({
      ok: false,
      reason: "transport closed: exit 1",
    });
    const client = new TmuxClient(t.transport);
    t.feed(STARTUP_GREETING);
    createMainBridge(client, hub.ipcMain);

    const renderer = hub.createRenderer();
    const proxy = createRendererBridge(renderer.ipcRenderer);

    await expect(proxy.execute("list-windows")).rejects.toMatchObject({
      code: "BRIDGE_CLOSED",
      message: "[BRIDGE_CLOSED] command not sent: transport closed: exit 1",
    });
  });

  it("classifies a mid-command transport close as BRIDGE_CLOSED, not BRIDGE_INTERNAL", async () => {
    // The OTHER dead-transport path: send() accepted the command (ok:true),
    // but the transport dies before %end/%error arrives. TmuxClient.execute
    // rejects with TransportClosedError — a distinct class from
    // TransportSendError above — and it must classify the same operational
    // way, not fall through to the catch-all BRIDGE_INTERNAL (meant for bugs).
    const hub = createIpcHub();
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    t.feed(STARTUP_GREETING);
    createMainBridge(client, hub.ipcMain);

    const renderer = hub.createRenderer();
    const proxy = createRendererBridge(renderer.ipcRenderer);

    const callPromise = proxy.execute("list-windows");
    t.fireClose("EPIPE");

    await expect(callPromise).rejects.toMatchObject({
      code: "BRIDGE_CLOSED",
    });
  });

  it("rejects the renderer promise when main-side execute fails", async () => {
    const hub = createIpcHub();
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    t.feed(STARTUP_GREETING);
    createMainBridge(client, hub.ipcMain);

    const renderer = hub.createRenderer();
    const proxy = createRendererBridge(renderer.ipcRenderer);

    const pending = proxy.execute("bogus-cmd");
    t.feed("%begin 1 1 0\n");
    t.feed("unknown command\n");
    t.feed("%error 1 1 0\n");

    await expect(pending).rejects.toBeInstanceOf(TmuxCommandError);
    await expect(pending).rejects.toMatchObject({
      response: { success: false, output: ["unknown command"] },
    });
  });
});

// ---------------------------------------------------------------------------
// L1 — every TmuxMessage variant survives structuredClone
//
// Real Electron IPC payloads cross a structured-clone boundary. The bridge
// works today because every TmuxMessage variant is plain data (primitives +
// Uint8Array). Adding a Date / Map / Function / getter to a variant would
// silently break IPC in production while passing every other test. This
// table-driven check freezes the contract: every variant in the union must
// remain structuredClone-safe.
// ---------------------------------------------------------------------------

describe("Electron IPC bridge — L1 structuredClone parity", () => {
  // [LAW:one-source-of-truth] One sample per discriminator. The mapped-type
  // signature forces every variant of the TmuxMessage union to appear;
  // adding a new event variant without updating the sample table is a
  // compile error, not a silent skip.
  const SAMPLES: {
    readonly [K in TmuxMessage["type"]]: Extract<TmuxMessage, { type: K }>;
  } = {
    begin: { type: "begin", timestamp: 1, commandNumber: 2, flags: 0 },
    end: { type: "end", timestamp: 1, commandNumber: 2, flags: 0 },
    error: { type: "error", timestamp: 1, commandNumber: 2, flags: 0 },
    output: {
      type: "output",
      paneId: 1,
      data: new Uint8Array([0xde, 0xad]),
    },
    "extended-output": {
      type: "extended-output",
      paneId: 1,
      age: 5,
      data: new Uint8Array([0xbe, 0xef]),
    },
    pause: { type: "pause", paneId: 7 },
    continue: { type: "continue", paneId: 7 },
    "pane-mode-changed": { type: "pane-mode-changed", paneId: 7 },
    "window-add": { type: "window-add", windowId: 11 },
    "window-close": { type: "window-close", windowId: 11 },
    "window-renamed": {
      type: "window-renamed",
      windowId: 11,
      name: "main",
    },
    "window-pane-changed": {
      type: "window-pane-changed",
      windowId: 11,
      paneId: 22,
    },
    "unlinked-window-add": { type: "unlinked-window-add", windowId: 13 },
    "unlinked-window-close": { type: "unlinked-window-close", windowId: 13 },
    "unlinked-window-renamed": {
      type: "unlinked-window-renamed",
      windowId: 13,
      name: "side",
    },
    "layout-change": {
      type: "layout-change",
      windowId: 11,
      windowLayout: "a",
      windowVisibleLayout: "b",
      windowFlags: "c",
    },
    "session-changed": { type: "session-changed", sessionId: 1, name: "s" },
    "session-renamed": { type: "session-renamed", sessionId: 1, name: "s2" },
    "sessions-changed": { type: "sessions-changed" },
    "session-window-changed": {
      type: "session-window-changed",
      sessionId: 1,
      windowId: 11,
    },
    "client-session-changed": {
      type: "client-session-changed",
      clientName: "c",
      sessionId: 1,
      name: "s",
    },
    "client-detached": { type: "client-detached", clientName: "c" },
    "paste-buffer-changed": { type: "paste-buffer-changed", name: "buf" },
    "paste-buffer-deleted": { type: "paste-buffer-deleted", name: "buf" },
    "subscription-changed": {
      type: "subscription-changed",
      name: "n",
      sessionId: 1,
      windowId: -1,
      windowIndex: -1,
      paneId: -1,
      value: "v",
    },
    message: { type: "message", message: "hi" },
    "config-error": { type: "config-error", error: "bad" },
    exit: { type: "exit", reason: "bye" },
  };

  it("every TmuxMessage variant round-trips through structuredClone", () => {
    for (const [variantName, sample] of Object.entries(SAMPLES)) {
      // structuredClone throws DataCloneError on functions / getters / Maps
      // holding un-cloneable values — exactly the failure mode the audit
      // worried about (a future variant silently breaking IPC).
      const cloned = structuredClone(sample);
      expect(
        cloned,
        `variant "${variantName}" did not survive structuredClone deeply`,
      ).toEqual(sample);
      expect(
        cloned,
        `variant "${variantName}" returned the same identity from clone`,
      ).not.toBe(sample);
    }
  });

  it("Uint8Array payloads keep byte content but get fresh identity", () => {
    // Spot-check the only field shape with non-trivial structuredClone
    // semantics. A regression that swaps Uint8Array → ArrayBufferView /
    // DataView would still toEqual but would not satisfy this assertion.
    const sample = SAMPLES.output;
    const cloned = structuredClone(sample);
    expect(cloned.data).toBeInstanceOf(Uint8Array);
    expect(cloned.data).not.toBe(sample.data);
    expect([...cloned.data]).toEqual([...sample.data]);
  });
});

// ---------------------------------------------------------------------------
// L5 — MainBridgeHandle.drain awaits in-flight invoke dispatches
// ---------------------------------------------------------------------------

describe("Electron IPC bridge — L5 drain", () => {
  it("drain resolves immediately when no invokes are in flight", async () => {
    const hub = createIpcHub();
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    t.feed(STARTUP_GREETING);
    const handle = createMainBridge(client, hub.ipcMain);
    await handle.drain();
    handle.dispose();
  });

  it("drain awaits every in-flight invoke after dispose (aborted dispatches resolve)", async () => {
    const hub = createIpcHub();
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    t.feed(STARTUP_GREETING);
    const handle = createMainBridge(client, hub.ipcMain);

    const renderer = hub.createRenderer();
    const proxy = createRendererBridge(renderer.ipcRenderer);

    const pending = proxy.execute("list-windows").catch((err: unknown) => err);

    // dispose marks every in-flight dispatch aborted but doesn't await them.
    handle.dispose();
    let drainResolved = false;
    const drainPromise = handle.drain().then(() => {
      drainResolved = true;
    });

    // Drain hasn't completed yet — the underlying client.execute is still
    // awaiting its FIFO entry (no tmux response yet).
    await Promise.resolve();
    expect(drainResolved).toBe(false);

    feedCommandResponse(t, 1, []);
    await drainPromise;
    expect(drainResolved).toBe(true);

    // The renderer-side promise rejected with ABORTED as expected.
    const err = await pending;
    expect((err as Error).message).toMatch(/ABORTED/);
  });

  it("drain honors timeoutMs and returns even when invokes don't settle", async () => {
    // No fake transport response is fed → the in-flight invoke never settles.
    // drain(25) must return after the timeout regardless.
    const hub = createIpcHub();
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    t.feed(STARTUP_GREETING);
    const handle = createMainBridge(client, hub.ipcMain);

    const renderer = hub.createRenderer();
    const proxy = createRendererBridge(renderer.ipcRenderer);

    // Swallow rejection so vitest doesn't flag it; the handler is still
    // pending until we feed a response (which we never will here).
    void proxy.execute("hangs-forever").catch(() => undefined);

    const start = Date.now();
    await handle.drain(25);
    const elapsed = Date.now() - start;

    // Allow generous slack for CI scheduler — the assertion is "drain
    // returned in roughly 25ms, not seconds".
    expect(elapsed).toBeLessThan(500);
    expect(elapsed).toBeGreaterThanOrEqual(20);

    // Clean up: dispose removes the IPC handlers installed by the bridge.
    // The orphaned in-flight invoke stays pending in the TmuxClient FIFO,
    // but the fake transport holds no real handles (no sockets/timers), so
    // there is nothing for vitest to flag as leaked.
    handle.dispose();
  });
});

// ---------------------------------------------------------------------------
// MainBridgeHandle.dispose
// ---------------------------------------------------------------------------

describe("Electron IPC bridge — dispose", () => {
  it("removes all ipcMain handlers and stops forwarding events", () => {
    const hub = createIpcHub();
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    t.feed(STARTUP_GREETING);
    const handle = createMainBridge(client, hub.ipcMain);

    const renderer = hub.createRenderer();
    const proxy = createRendererBridge(renderer.ipcRenderer);

    const received: number[] = [];
    proxy.on("window-add", (ev) => received.push(ev.windowId));

    t.feed("%window-add @1\n");
    handle.dispose();
    t.feed("%window-add @2\n");

    expect(received).toEqual([1]);
  });

  it("after dispose, renderer invoke throws because the handler is gone", async () => {
    const hub = createIpcHub();
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    t.feed(STARTUP_GREETING);
    const handle = createMainBridge(client, hub.ipcMain);

    const renderer = hub.createRenderer();
    const proxy = createRendererBridge(renderer.ipcRenderer);

    handle.dispose();

    await expect(proxy.execute("list-windows")).rejects.toThrow(
      /no handler/,
    );
  });
});

// ---------------------------------------------------------------------------
// Type surface — TmuxClientProxy mirrors TmuxClient at compile time.
// ---------------------------------------------------------------------------

describe("Electron IPC bridge — proxy parity (M6)", () => {
  // [M6] The previous type-surface test only asserted `instanceof
  // TmuxClientProxy`, which proves nothing about parity with TmuxClient or
  // the wire union. The `class TmuxClientProxy implements RpcProxyApi`
  // declaration in renderer.ts already gives us the compile-time guarantee
  // that the proxy mirrors the wire union; the runtime check below proves
  // that every name in RPC_METHOD_NAMES (the sole source of truth for
  // bridged methods) is actually a callable function on the proxy
  // prototype. A regression that adds a wire variant and forgets the
  // proxy method now fails this test rather than silently shipping.
  it("every RPC method name is a callable function on TmuxClientProxy", () => {
    const hub = createIpcHub();
    const r = hub.createRenderer();
    const proxy = createRendererBridge(r.ipcRenderer);
    for (const name of RPC_METHOD_NAMES) {
      const fn = (proxy as unknown as Record<string, unknown>)[name];
      expect(
        typeof fn,
        `proxy is missing method "${name}" — RPC_METHOD_NAMES diverged from TmuxClientProxy`,
      ).toBe("function");
      // Smoke-call: every method should accept its declared argument count.
      // We don't assert the result here (the dispatcher needs a live client)
      // — only that referring to the method does not throw.
      expect(
        () => fn,
        `proxy.${name} reference threw on access`,
      ).not.toThrow();
    }
  });

  it("Uint8Array %output payloads round-trip across the IPC structuredClone boundary", async () => {
    // [M6] The previous fake hub passed args by reference, hiding bugs that
    // would surface in real Electron when payloads cross structuredClone.
    // The hub now clones every IPC payload; this test pins that contract.
    //
    // Bytes flow through `attachBytesSink`, not the emitter.
    const hub = createIpcHub();
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    t.feed(STARTUP_GREETING);
    createMainBridge(client, hub.ipcMain);

    const renderer = hub.createRenderer();
    const proxy = createRendererBridge(renderer.ipcRenderer);
    const received: Uint8Array[] = [];
    proxy.attachBytesSink(
      {
        write(msg) {
          // BytesSink contract: msg.data is read-only, copy before retention.
          received.push(msg.data.slice());
        },
        end() {},
      },
      { scope: paneScope(1) },
    );

    // Synthesize a %output frame end-to-end through the parser.
    const payload = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    t.feed(`%output %1 \\336\\255\\276\\357\n`);

    // Allow microtasks to drain.
    await Promise.resolve();
    await Promise.resolve();

    expect(received).toHaveLength(1);
    const bytes = received[0]!;
    expect([...bytes]).toEqual([...payload]);
    // The renderer's copy is a fresh Uint8Array, NOT the main-side identity.
    // (We cannot probe main-side identity directly — but a structuredClone
    // round-trip guarantees the buffers are different objects.)
    expect(bytes).toBeInstanceOf(Uint8Array);
  });
});

// ---------------------------------------------------------------------------
// M1 — forward() must not perturb iteration when teardownSender mutates the
// senders Map mid-loop (a destroyed wc detected during forwarding).
// ---------------------------------------------------------------------------

describe("Electron IPC bridge — M1 forward iteration safety", () => {
  it("delivers to surviving renderers when one is destroyed mid-broadcast", async () => {
    const hub = createIpcHub();
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    t.feed(STARTUP_GREETING);
    createMainBridge(client, hub.ipcMain);

    const a = hub.createRenderer();
    const b = hub.createRenderer();
    const c = hub.createRenderer();

    const proxyA = createRendererBridge(a.ipcRenderer);
    const proxyB = createRendererBridge(b.ipcRenderer);
    const proxyC = createRendererBridge(c.ipcRenderer);

    const got: Array<"a" | "c"> = [];
    proxyA.attachBytesSink(
      { write() { got.push("a"); }, end() {} },
      { scope: paneScope(42) },
    );
    proxyC.attachBytesSink(
      { write() { got.push("c"); }, end() {} },
      { scope: paneScope(42) },
    );
    // proxyB receives nothing — destroyed before broadcast.

    // Destroy B's wc directly (real Electron: webContents went away during
    // event delivery). Then drive a %output through main; main's byte
    // forwarder must visit A and C without skipping or double-tearing-down.
    b.destroy();
    void proxyB; // keep reference so unused-variable lint is quiet

    t.feed(`%output %42 ok\n`);
    await Promise.resolve();
    await Promise.resolve();

    expect(got.sort()).toEqual(["a", "c"]);
  });
});

// ---------------------------------------------------------------------------
// M2 — destroyed listener does not leak after a sender is torn down via
// unregister while its WebContents is still alive.
// ---------------------------------------------------------------------------

describe("Electron IPC bridge — M2 destroyed-listener cleanup", () => {
  it("removes the destroyed handler when teardown is driven by unregister", async () => {
    const hub = createIpcHub();
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    t.feed(STARTUP_GREETING);
    createMainBridge(client, hub.ipcMain);

    const r = hub.createRenderer();
    const proxy = createRendererBridge(r.ipcRenderer);
    expect(r.destroyHandlerCount()).toBe(1);

    proxy.close(); // sends tmux:unregister → main.teardownSender
    await Promise.resolve();
    expect(r.destroyHandlerCount()).toBe(0);
  });

  it("removes the destroyed handler when teardown is driven by dispose", async () => {
    const hub = createIpcHub();
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    t.feed(STARTUP_GREETING);
    const handle = createMainBridge(client, hub.ipcMain);

    const r = hub.createRenderer();
    createRendererBridge(r.ipcRenderer);
    expect(r.destroyHandlerCount()).toBe(1);

    handle.dispose();
    expect(r.destroyHandlerCount()).toBe(0);
  });

  it("duplicate tmux:unregister from a single sender is a noop (L3)", async () => {
    // A misbehaving or double-firing renderer can resend tmux:unregister.
    // The bridge must not double-decrement refcounts or duplicate any
    // teardown side effect — teardownSender is idempotent by lookup.
    const hub = createIpcHub();
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    t.feed(STARTUP_GREETING);
    createMainBridge(client, hub.ipcMain);

    const r = hub.createRenderer();
    const proxy = createRendererBridge(r.ipcRenderer);

    const sub = proxy.subscribeRaw("focus", "", "#{pane_id}");
    feedCommandResponse(t, 1, []);
    await sub;

    // First unregister: refcount 1 → 0 → tmux unsubscribe fires.
    r.ipcRenderer.send(IPC.unregister);
    expect(
      t.sent.filter((c) => c === `refresh-client -B 'focus'\n`),
    ).toHaveLength(1);

    // Second unregister: noop, no additional unsubscribe.
    r.ipcRenderer.send(IPC.unregister);
    expect(
      t.sent.filter((c) => c === `refresh-client -B 'focus'\n`),
    ).toHaveLength(1);
  });

  it("late destroy after unregister is a no-op (no double teardown, no error)", async () => {
    const hub = createIpcHub();
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    t.feed(STARTUP_GREETING);
    createMainBridge(client, hub.ipcMain);

    const r = hub.createRenderer();
    const proxy = createRendererBridge(r.ipcRenderer);
    proxy.close();
    expect(r.destroyHandlerCount()).toBe(0);

    // Firing destroy now should not throw — destroyHandlers Set is empty.
    expect(() => r.destroy()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// M8 — invokeTimeoutMs.
// ---------------------------------------------------------------------------

describe("Electron IPC bridge — M8 invoke timeout", () => {
  it("rejects with BridgeError(TIMEOUT) when the IPC call does not settle in time", async () => {
    // Fake renderer that lets us control settle timing of a single in-flight
    // invoke. We bypass the real ipcMain handler so the call simply hangs.
    let resolveStuck: (v: unknown) => void = () => {};
    const stuckIpc: IpcRendererLike = {
      invoke: () =>
        new Promise((resolve) => {
          resolveStuck = resolve;
        }),
      send: () => undefined,
      on: () => undefined,
      removeListener: () => undefined,
    };
    const proxy = new TmuxClientProxy(stuckIpc, { invokeTimeoutMs: 25 });

    const err = await proxy.execute("anything").then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(BridgeError);
    expect((err as BridgeError).code).toBe("BRIDGE_TIMEOUT");

    // Late settlement must not throw an unhandled rejection (the timer
    // already rejected the renderer-side promise; the resolution is just
    // discarded). vitest will fail the test if an unhandled rejection
    // propagates, so the absence of a failure here is the assertion.
    resolveStuck({ ok: true, response: { output: [], success: true } });
    await new Promise((r) => setTimeout(r, 5));
  });

  it("does not start a timer when invokeTimeoutMs is 0 (default)", async () => {
    // Nothing to assert beyond "the call resolves normally" — but we use
    // vitest's fake-timer escape: a real timer would never fire because the
    // call resolves first. We assert correctness of the result.
    const hub = createIpcHub();
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    t.feed(STARTUP_GREETING);
    createMainBridge(client, hub.ipcMain);

    const r = hub.createRenderer();
    const proxy = new TmuxClientProxy(r.ipcRenderer); // no timeout option

    const p = proxy.listPanes();
    feedCommandResponse(t, 1, []);
    const resp = await p;
    expect(resp.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Import-graph smoke test: renderer must not transitively pull Node modules.
// ---------------------------------------------------------------------------

// Extract every RUNTIME module-graph edge from a TS source. An edge is a
// specifier that pulls its target into the renderer's runtime bundle — the
// thing a Node import would ride into the browser. Type-only forms are erased
// by tsc and create NO runtime edge, so they are deliberately excluded (the
// renderer legitimately imports TYPES from Node-only files, e.g. an
// `implements TmuxConnection` clause whose declaration lives in client.ts).
//
// The set of forms is grammar-defined by the TS parser rather than matched by
// a hand-rolled regex: a regex must enumerate syntactic shapes and silently
// misses every one it forgot (this gate previously missed `export ... from`
// re-exports and dynamic `import()` — a Node import smuggled through either
// slipped past the renderer/Node boundary check). The parser closes that
// enumeration gap by construction. [LAW:types-are-the-program] [LAW:no-silent-failure]
//
//   COLLECT (runtime edge)              │ SKIP (type-only, fully erased)
//   ────────────────────────────────────┼───────────────────────────────────
//   import d from "m"                    │ import type { X } from "m"
//   import { a } from "m"                │ export type { X } from "m"
//   import * as n from "m"               │ import { type X } from "m"  (all-type)
//   import "m"          (side-effect)    │ export { type X } from "m"  (all-type)
//   import d, { a } from "m"             │
//   export { a } from "m"    (re-export) │
//   export * from "m"        (re-export) │
//   export * as n from "m"   (re-export) │
//   import("m")         (dynamic literal)│
function collectModuleEdges(sourceText: string, fileName: string): string[] {
  const sf = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const specs: string[] = [];

  // `import { type A, type B } from "m"` with no default/namespace binding is
  // fully erased; if ANY binding is a value, a runtime edge remains. Note the
  // `length > 0` guard: `import {} from "m"` has zero specifiers, and an empty
  // `.every()` is vacuously true — but empty braces are a *side-effect* import
  // (the module still loads at runtime), so they must NOT be classified as
  // type-only, else a `import {} from "node:fs"` edge slips the gate.
  const importClauseIsTypeOnly = (clause: ts.ImportClause): boolean => {
    if (clause.isTypeOnly) return true; // `import type { ... }`
    if (clause.name !== undefined) return false; // default binding is a value
    const b = clause.namedBindings;
    if (b !== undefined && ts.isNamespaceImport(b)) return false; // `* as ns`
    if (b !== undefined && ts.isNamedImports(b)) {
      return b.elements.length > 0 && b.elements.every((e) => e.isTypeOnly);
    }
    return false;
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      // No importClause → `import "m"`, a pure side-effect runtime edge.
      const typeOnly =
        node.importClause !== undefined &&
        importClauseIsTypeOnly(node.importClause);
      if (!typeOnly && ts.isStringLiteral(node.moduleSpecifier)) {
        specs.push(node.moduleSpecifier.text);
      }
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined
    ) {
      // `export ... from "m"`. isTypeOnly covers `export type { X } from`;
      // a fully-inline-type named re-export is erased too — mirror imports,
      // including the `length > 0` guard so `export {} from "m"` (a runtime
      // side-effect re-export) is not vacuously classified as type-only.
      const allInlineType =
        node.exportClause !== undefined &&
        ts.isNamedExports(node.exportClause) &&
        node.exportClause.elements.length > 0 &&
        node.exportClause.elements.every((e) => e.isTypeOnly);
      if (
        !node.isTypeOnly &&
        !allInlineType &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        specs.push(node.moduleSpecifier.text);
      }
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      // Dynamic `import("m")` — always a runtime edge. A non-literal specifier
      // can't be resolved statically; surface it loudly rather than silently
      // dropping an unanalyzable edge past the gate. [LAW:no-silent-failure]
      const arg = node.arguments[0];
      if (arg !== undefined && ts.isStringLiteral(arg)) {
        specs.push(arg.text);
      } else {
        throw new Error(
          `[import-graph] non-literal dynamic import in ${fileName} — the ` +
            `renderer-purity gate cannot statically resolve its target; make ` +
            `the specifier a string literal so the edge stays analyzable.`,
        );
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sf);
  return specs;
}

describe("Electron IPC bridge — renderer import graph", () => {
  const __dirname = dirname(fileURLToPath(import.meta.url));

  const NODE_BUILTIN = new Set([
    "assert",
    "buffer",
    "child_process",
    "cluster",
    "crypto",
    "dgram",
    "dns",
    "events",
    "fs",
    "fs/promises",
    "http",
    "https",
    "net",
    "os",
    "path",
    "perf_hooks",
    "process",
    "querystring",
    "readline",
    "stream",
    "tls",
    "url",
    "util",
    "v8",
    "vm",
    "worker_threads",
    "zlib",
  ]);

  const BANNED_RELATIVE = [
    // Anything inside these trees is Node-only.
    "src/client",
    "src/transport/",
  ];

  async function walk(entry: string): Promise<{
    files: Set<string>;
    allImports: Array<{ from: string; spec: string }>;
  }> {
    const files = new Set<string>();
    const allImports: Array<{ from: string; spec: string }> = [];
    const queue: string[] = [entry];
    while (queue.length > 0) {
      const f = queue.shift()!;
      if (files.has(f)) continue;
      files.add(f);
      const src = await readFile(f, "utf-8");
      // Grammar-defined runtime edges only — see collectModuleEdges. Type-only
      // imports/re-exports are excluded there, so the walk never traverses into
      // Node-only files via a compile-time-erased edge.
      for (const spec of collectModuleEdges(src, f)) {
        allImports.push({ from: f, spec });
        if (spec.startsWith(".")) {
          const abs = resolve(dirname(f), spec.replace(/\.js$/, ".ts"));
          queue.push(abs);
        }
      }
    }
    return { files, allImports };
  }

  it("renderer.ts + transitive imports contain zero Node built-ins", async () => {
    const entry = resolve(
      __dirname,
      "../../src/connectors/electron/renderer.ts",
    );
    const { allImports } = await walk(entry);

    const forbidden = allImports.filter(({ spec }) => {
      const bare = spec.replace(/^node:/, "");
      return spec.startsWith("node:") || NODE_BUILTIN.has(bare);
    });
    expect(forbidden).toEqual([]);
  });

  it("renderer.ts + transitive imports never reach src/client or src/transport", async () => {
    const entry = resolve(
      __dirname,
      "../../src/connectors/electron/renderer.ts",
    );
    const { allImports, files } = await walk(entry);

    // No import specifier may resolve into client.ts or anything under transport/.
    const bad = allImports.filter(({ spec }) =>
      BANNED_RELATIVE.some((seg) => spec.includes(seg.replace("src/", ""))),
    );
    expect(bad).toEqual([]);

    // And no visited file may live in src/transport/ or be src/client.ts.
    for (const f of files) {
      expect(f).not.toMatch(/\/src\/transport\//);
      expect(f).not.toMatch(/\/src\/client\.ts$/);
    }
  });

  // Negative test for the enumeration gap this gate previously had. The old
  // regex matched only `import` statements, so a Node import smuggled through
  // an `export ... from` re-export or a dynamic `import()` slipped past both
  // assertions above. Prove the parser-based extractor collects every runtime
  // edge form (so the gate would flag them) and still erases type-only forms
  // (so it doesn't false-positive on legitimate type imports from Node-only
  // files). [LAW:no-silent-failure]
  it("catches re-exports and dynamic imports; erases type-only edges", () => {
    const src = [
      `import { real } from "./local.js";`, // value import — edge
      `import type { T } from "../../src/client.js";`, // type-only stmt — NOT an edge
      `export { fs } from "node:fs";`, // re-export — edge (regex MISSED this)
      `export * from "child_process";`, // re-export-all — edge (regex MISSED this)
      `export * as net from "node:net";`, // re-export-ns — edge (regex MISSED this)
      `export type { U } from "../../src/transport/types.js";`, // type re-export — NOT an edge
      `async function load() { return import("os"); }`, // dynamic — edge (regex MISSED this)
      `import { type Only } from "node:crypto";`, // all-inline-type — NOT an edge
      `import {} from "node:dns";`, // empty-brace side-effect — edge (loads at runtime)
      `export {} from "node:tls";`, // empty-brace re-export — edge (runtime dependency)
    ].join("\n");

    const specs = collectModuleEdges(src, "/synthetic/renderer.ts");

    // Every runtime-edge form is collected — the smuggling routes are closed.
    // Empty-brace forms (node:dns, node:tls) must NOT be vacuously erased: they
    // are side-effect edges that still load the module at runtime.
    expect(specs).toEqual(
      expect.arrayContaining([
        "./local.js",
        "node:fs",
        "child_process",
        "node:net",
        "os",
        "node:dns",
        "node:tls",
      ]),
    );
    // Every type-only form is erased — no false positives on legit type imports.
    expect(specs).not.toContain("../../src/client.js");
    expect(specs).not.toContain("../../src/transport/types.js");
    expect(specs).not.toContain("node:crypto");

    // The smuggled Node imports are exactly what the "zero Node built-ins"
    // assertion flags — so a re-export or dynamic import of a Node module now
    // fails the gate instead of passing silently.
    const forbidden = specs.filter((spec) => {
      const bare = spec.replace(/^node:/, "");
      return spec.startsWith("node:") || NODE_BUILTIN.has(bare);
    });
    expect(forbidden).toEqual(
      expect.arrayContaining(["node:fs", "child_process", "node:net", "os"]),
    );
  });

  // The extractor must refuse to silently pass an edge it cannot analyze,
  // rather than dropping it. [LAW:no-silent-failure]
  it("throws on a non-literal dynamic import (unanalyzable edge)", () => {
    const src = `const mod = "os"; async function f() { return import(mod); }`;
    expect(() => collectModuleEdges(src, "/synthetic/x.ts")).toThrow(
      /non-literal dynamic import/,
    );
  });
});

// ---------------------------------------------------------------------------
// Two-renderer integration ("opens two windows") — proves the bridge survives
// a second window being created (real-Electron-style fake throws on duplicate
// handle()) and that subscribers fan-out correctly.
// ---------------------------------------------------------------------------

describe("Electron IPC bridge — two-window scenario", () => {
  it("creates a second renderer without re-installing the bridge", async () => {
    const hub = createIpcHub();
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    t.feed(STARTUP_GREETING);
    createMainBridge(client, hub.ipcMain);

    // Renderer 1 (window 1).
    const r1 = hub.createRenderer();
    const p1 = createRendererBridge(r1.ipcRenderer);
    const got1: number[] = [];
    p1.on("window-add", (ev) => got1.push(ev.windowId));

    // Renderer 2 (window 2) — would crash if the bridge re-registered the
    // ipcMain.handle for tmux:invoke. Real Electron throws, our fake throws,
    // and createMainBridge throws ALREADY_REGISTERED if you try to install
    // twice. The right shape is "createMainBridge once, many windows".
    const r2 = hub.createRenderer();
    const p2 = createRendererBridge(r2.ipcRenderer);
    const got2: number[] = [];
    p2.on("window-add", (ev) => got2.push(ev.windowId));

    t.feed("%window-add @11\n");
    expect(got1).toEqual([11]);
    expect(got2).toEqual([11]);

    // Both renderers can independently invoke commands through the single
    // shared handler.
    const p1Pending = p1.execute("list-windows");
    feedCommandResponse(t, 1, []);
    await p1Pending;

    const p2Pending = p2.execute("list-panes");
    feedCommandResponse(t, 2, []);
    await p2Pending;

    expect(t.sent).toContain("list-windows\n");
    expect(t.sent).toContain("list-panes\n");
  });

  it("regression — fake hub mirrors real Electron: second handle() throws", () => {
    const hub = createIpcHub();
    // Direct second registration on the same channel must throw.
    hub.ipcMain.handle("tmux:invoke", async () => undefined);
    expect(() =>
      hub.ipcMain.handle("tmux:invoke", async () => undefined),
    ).toThrow(/second handler/);
  });
});

// ---------------------------------------------------------------------------
// H4 — Per-sender pending invoke tracking; abandonment on destroyed
// ---------------------------------------------------------------------------

describe("Electron IPC bridge — H4 per-sender pending invokes", () => {
  it("aborts in-flight invoke when sender is destroyed; FIFO stays correlated", async () => {
    // Renderer A invokes; renderer A is destroyed BEFORE tmux replies;
    // renderer B subsequently invokes. The TmuxClient FIFO must NOT be
    // purged on A's death — A's pending entry stays in line, A's tmux
    // response pops A's entry (resolved into the void on the bridge side
    // because A is aborted), B's tmux response pops B's entry and lands.
    const hub = createIpcHub();
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    t.feed(STARTUP_GREETING);
    createMainBridge(client, hub.ipcMain);

    const a = hub.createRenderer();
    const b = hub.createRenderer();
    const pa = createRendererBridge(a.ipcRenderer);
    const pb = createRendererBridge(b.ipcRenderer);

    const aResult = pa.execute("list-windows").catch((err: unknown) => err);
    // tmux has not yet replied — kill A.
    a.destroy();
    // Now B starts a request; tmux processes them in order.
    const bResult = pb.execute("list-panes");

    // Tmux replies to A's command first (still in FIFO), then B's.
    feedCommandResponse(t, 1, ["@0 zsh 1 -"]);
    feedCommandResponse(t, 2, ["%1 main 0 -"]);

    // A's invoke surface MUST reject with a typed BridgeError (not silently
    // resolve and not crash) so callers can localize.
    const aErr = await aResult;
    expect(aErr).toBeInstanceOf(Error);
    expect((aErr as Error).message).toMatch(/ABORTED/);
    expect((aErr as Error).message).toMatch(/method=execute/);

    // B's invoke MUST receive its own response (correlation intact).
    const bResp = await bResult;
    expect(bResp.success).toBe(true);
    expect(bResp.output).toEqual(["%1 main 0 -"]);
  });

  it("aborts in-flight invoke when sender unregisters mid-request", async () => {
    // close() on the proxy sends IPC.unregister. The bridge treats this as
    // a teardown for the sender (matching the destroyed-handler path) so any
    // in-flight invoke is aborted with a typed error rather than orphaned.
    const hub = createIpcHub();
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    t.feed(STARTUP_GREETING);
    createMainBridge(client, hub.ipcMain);

    const renderer = hub.createRenderer();
    const proxy = createRendererBridge(renderer.ipcRenderer);

    const pending = proxy.execute("list-windows").catch((err: unknown) => err);
    proxy.close();
    feedCommandResponse(t, 1, []);

    const err = await pending;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/ABORTED/);
  });

  it("dispose aborts every in-flight invoke", async () => {
    const hub = createIpcHub();
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    t.feed(STARTUP_GREETING);
    const handle = createMainBridge(client, hub.ipcMain);

    const renderer = hub.createRenderer();
    const proxy = createRendererBridge(renderer.ipcRenderer);

    const pending = proxy.execute("list-windows").catch((err: unknown) => err);
    handle.dispose();

    // After dispose, the IPC handler is gone. The pending invoke was already
    // awaiting on dispatchRpcRequest(client, ...) — feeding a response still
    // resolves the underlying promise, but the post-await branch sees
    // aborted and throws.
    feedCommandResponse(t, 1, []);

    const err = await pending;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/ABORTED/);
  });
});

// ---------------------------------------------------------------------------
// H7 — Per-sender subscription scoping (ownership + refcount + auto-cleanup)
//
// Wire helpers: tmux's `refresh-client -B` is overloaded — `'name':'value':
// 'format'` is subscribe, bare `'name'` is unsubscribe. The encoder wraps
// every arg in single quotes (see src/protocol/encoder.ts tmuxEscape), so
// the wire shape is unambiguous on the test side.
// ---------------------------------------------------------------------------

function isUnsubscribeWire(line: string, name: string): boolean {
  return line === `refresh-client -B '${name}'\n`;
}

function isSubscribeWire(line: string, name: string): boolean {
  return line.startsWith(`refresh-client -B '${name}':'`);
}

describe("Electron IPC bridge — H7 subscription scoping", () => {
  it("rejects unsubscribe of a name the sender does not own", async () => {
    // A subscribes "focus"; B tries to unsubscribe it. B's request fails
    // with UNKNOWN_SUBSCRIPTION; tmux unsubscribe is NOT called.
    const hub = createIpcHub();
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    t.feed(STARTUP_GREETING);
    createMainBridge(client, hub.ipcMain);

    const a = hub.createRenderer();
    const b = hub.createRenderer();
    const pa = createRendererBridge(a.ipcRenderer);
    const pb = createRendererBridge(b.ipcRenderer);

    // A subscribes — bridge forwards the subscribe to tmux.
    const aSub = pa.subscribeRaw("focus", "", "#{pane_id}");
    feedCommandResponse(t, 1, []);
    await aSub;
    expect(t.sent.some((c) => isSubscribeWire(c, "focus"))).toBe(true);

    const sentBefore = t.sent.length;

    // B attempts to unsubscribe — bridge rejects at the trust boundary.
    await expect(pb.unsubscribe("focus")).rejects.toThrow(
      /UNKNOWN_SUBSCRIPTION/,
    );

    // Tmux must not have seen any unsubscribe attempt.
    expect(t.sent.slice(sentBefore)).toEqual([]);
  });

  it("refcounts subscriptions: tmux unsubscribe fires only after the last sender drops", async () => {
    const hub = createIpcHub();
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    t.feed(STARTUP_GREETING);
    createMainBridge(client, hub.ipcMain);

    const a = hub.createRenderer();
    const b = hub.createRenderer();
    const pa = createRendererBridge(a.ipcRenderer);
    const pb = createRendererBridge(b.ipcRenderer);

    const aSub = pa.subscribeRaw("focus", "", "#{pane_id}");
    feedCommandResponse(t, 1, []);
    await aSub;
    const bSub = pb.subscribeRaw("focus", "", "#{pane_id}");
    feedCommandResponse(t, 2, []);
    await bSub;

    // Two senders own "focus" → refcount = 2.
    // A unsubscribes — bridge synthesizes success without hitting tmux
    // because B still owns it. (Verify by counting unsubscribe wire traffic.)
    const sentBefore = t.sent.length;
    const aResp = await pa.unsubscribe("focus");
    expect(aResp.success).toBe(true);
    expect(
      t.sent.slice(sentBefore).filter((c) => isUnsubscribeWire(c, "focus")),
    ).toEqual([]);

    // B unsubscribes — refcount hits 0 → tmux call.
    const bUnsub = pb.unsubscribe("focus");
    feedCommandResponse(t, 3, []);
    await bUnsub;
    expect(
      t.sent.filter((c) => isUnsubscribeWire(c, "focus")),
    ).toHaveLength(1);
  });

  it("auto-unsubscribes a sender's subscriptions when its WebContents is destroyed", async () => {
    // Single-owner case: A subscribes "focus" then dies → tmux unsubscribe
    // fires automatically as part of teardown (no leak).
    const hub = createIpcHub();
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    t.feed(STARTUP_GREETING);
    createMainBridge(client, hub.ipcMain);

    const a = hub.createRenderer();
    const pa = createRendererBridge(a.ipcRenderer);

    const sub = pa.subscribeRaw("focus", "", "#{pane_id}");
    feedCommandResponse(t, 1, []);
    await sub;

    a.destroy();

    // Refcount went 1 → 0; bridge issues tmux unsubscribe.
    expect(
      t.sent.filter((c) => isUnsubscribeWire(c, "focus")),
    ).toHaveLength(1);
  });

  it("auto-cleanup respects refcount: surviving sender keeps the subscription alive", async () => {
    const hub = createIpcHub();
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    t.feed(STARTUP_GREETING);
    createMainBridge(client, hub.ipcMain);

    const a = hub.createRenderer();
    const b = hub.createRenderer();
    const pa = createRendererBridge(a.ipcRenderer);
    const pb = createRendererBridge(b.ipcRenderer);

    const aSub = pa.subscribeRaw("focus", "", "#{pane_id}");
    feedCommandResponse(t, 1, []);
    await aSub;
    const bSub = pb.subscribeRaw("focus", "", "#{pane_id}");
    feedCommandResponse(t, 2, []);
    await bSub;

    a.destroy();
    // B still owns "focus"; refcount = 1; no tmux unsubscribe yet.
    expect(
      t.sent.filter((c) => isUnsubscribeWire(c, "focus")),
    ).toEqual([]);

    // When B finally goes too, the unsubscribe fires.
    b.destroy();
    expect(
      t.sent.filter((c) => isUnsubscribeWire(c, "focus")),
    ).toHaveLength(1);
  });

  it("dispose clears every refcounted subscription with one tmux unsubscribe each", async () => {
    const hub = createIpcHub();
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    t.feed(STARTUP_GREETING);
    const handle = createMainBridge(client, hub.ipcMain);

    const a = hub.createRenderer();
    const pa = createRendererBridge(a.ipcRenderer);

    const aSub1 = pa.subscribeRaw("focus", "", "#{pane_id}");
    feedCommandResponse(t, 1, []);
    await aSub1;
    const aSub2 = pa.subscribeRaw("layout", "", "#{window_id}");
    feedCommandResponse(t, 2, []);
    await aSub2;

    handle.dispose();

    // Bridge issues an unsubscribe per refcounted name on dispose.
    expect(
      t.sent.filter((c) => isUnsubscribeWire(c, "focus")),
    ).toHaveLength(1);
    expect(
      t.sent.filter((c) => isUnsubscribeWire(c, "layout")),
    ).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // qz5.5 / C1 — divergent re-subscribe across senders.
  //
  // Pre-qz5.5 (electron/main.ts:316-331), `subscribeForSender` always
  // forwarded `client.subscribeRaw(name, what, format)` to tmux. When sender A
  // held name=foo with format='#{a}' and sender B subscribed name=foo with
  // format='#{b}', tmux's binding for "foo" was overwritten to '#{b}' but
  // A's per-sender record still claimed it owned "foo" — so A's events
  // arrived in B's format until A unsubscribed, at which point the refcount
  // hit 0 and B's binding was destroyed too. The audit (C1) called this out
  // as "either key on (name, what, format) or reject divergent re-subscribes
  // — document which".
  //
  // qz5.5 chose REJECTION via the shared BridgeConnection helper: a peer
  // claiming an existing name with a different (what, format) gets
  // BRIDGE_SUBSCRIPTION_FORMAT_CONFLICT. To update the format, unsubscribe
  // first.
  // -------------------------------------------------------------------------
  describe("Electron IPC bridge — qz5.5 C1 divergent re-subscribe", () => {
    it("rejects a second sender re-subscribing the same name with a different (what, format)", async () => {
      const hub = createIpcHub();
      const t = createFakeTransport();
      const client = new TmuxClient(t.transport);
      t.feed(STARTUP_GREETING);
      createMainBridge(client, hub.ipcMain);

      const a = hub.createRenderer();
      const b = hub.createRenderer();
      const pa = createRendererBridge(a.ipcRenderer);
      const pb = createRendererBridge(b.ipcRenderer);

      // A claims (foo, '', '#{a}'); bridge forwards to tmux with '#{a}'.
      const aSub = pa.subscribeRaw("foo", "", "#{a}");
      feedCommandResponse(t, 1, []);
      await aSub;

      // B attempts to claim (foo, '', '#{b}') — different format.
      // Bridge MUST reject so A's binding is preserved.
      await expect(pb.subscribeRaw("foo", "", "#{b}")).rejects.toMatchObject({
        code: "BRIDGE_SUBSCRIPTION_FORMAT_CONFLICT",
      });

      // tmux must not have seen a second subscribe overwriting A's format.
      // (Electron's encoder produces `refresh-client -B 'foo':'':'#{...}'\n`.)
      const fooSubs = t.sent.filter((c) =>
        c.startsWith("refresh-client -B 'foo':"),
      );
      expect(fooSubs).toHaveLength(1);
      expect(fooSubs[0]).toContain("'#{a}'");
      expect(fooSubs[0]).not.toContain("'#{b}'");
    });

    it("accepts a second sender claiming the same name with the SAME (what, format) (refcount bumps; tmux not re-asked)", async () => {
      const hub = createIpcHub();
      const t = createFakeTransport();
      const client = new TmuxClient(t.transport);
      t.feed(STARTUP_GREETING);
      createMainBridge(client, hub.ipcMain);

      const a = hub.createRenderer();
      const b = hub.createRenderer();
      const pa = createRendererBridge(a.ipcRenderer);
      const pb = createRendererBridge(b.ipcRenderer);

      const aSub = pa.subscribeRaw("foo", "", "#{x}");
      feedCommandResponse(t, 1, []);
      await aSub;

      // B subscribes the SAME (what, format). Helper synthesizes ok and
      // does NOT issue a second tmux subscribe (refcount bumps to 2). The
      // synthesized response is observable as success without a wire send.
      const sentBefore = t.sent.length;
      const bSub = pb.subscribeRaw("foo", "", "#{x}");
      const resp = await bSub;
      expect(resp.success).toBe(true);
      expect(t.sent.slice(sentBefore)).toEqual([]);
    });

    it("rolls back the entire record (and every concurrent joiner) when tmux rejects the first subscribe", async () => {
      // Race the bloodhound caught in the qz5.5 review: the helper
      // optimistically installed a record before `client.subscribeRaw`
      // resolved, so a concurrent peer with the matching (what, format)
      // could short-circuit to a synthesized OK. If tmux then rejected the
      // first call, the second peer was left holding a phantom
      // subscription. The fix queues concurrent joiners on an `inflight`
      // promise; this test pins that they all reject together.
      const hub = createIpcHub();
      const t = createFakeTransport();
      const client = new TmuxClient(t.transport);
      t.feed(STARTUP_GREETING);
      createMainBridge(client, hub.ipcMain);

      const a = hub.createRenderer();
      const b = hub.createRenderer();
      const pa = createRendererBridge(a.ipcRenderer);
      const pb = createRendererBridge(b.ipcRenderer);

      // A initiates the subscribe; B races in with the same (what, format).
      const aSub = pa.subscribeRaw("foo", "", "#{x}");
      // Yield once so A's subscribe call reaches client.subscribeRaw (the
      // bridge dispatch path is async). Then B's call observes the
      // record and queues on inflight.
      await Promise.resolve();
      await Promise.resolve();
      const bSub = pb.subscribeRaw("foo", "", "#{x}");

      // tmux rejects A's subscribe. Both A and B must reject — B was
      // queued on the inflight promise, not optimistically resolved.
      t.feed("%begin 1 1 0\n");
      t.feed("nope\n");
      t.feed("%error 1 1 0\n");

      await expect(aSub).rejects.toBeInstanceOf(TmuxCommandError);
      await expect(bSub).rejects.toBeInstanceOf(TmuxCommandError);

      // Neither peer should still be carrying ownership — a follow-up
      // unsubscribe would surface BRIDGE_UNKNOWN_SUBSCRIPTION because the
      // rollback dropped both peers' state.subscriptions and deleted the
      // shared record.
      await expect(pa.unsubscribe("foo")).rejects.toMatchObject({
        code: "BRIDGE_UNKNOWN_SUBSCRIPTION",
      });
      await expect(pb.unsubscribe("foo")).rejects.toMatchObject({
        code: "BRIDGE_UNKNOWN_SUBSCRIPTION",
      });
    });

    it("allows a sender to update its OWN format after unsubscribing first", async () => {
      // The rejection rule says "to update format, unsubscribe first". This
      // pins that the workaround actually works — a single owner can
      // unsubscribe + re-subscribe with a new format and tmux sees both
      // calls in order.
      const hub = createIpcHub();
      const t = createFakeTransport();
      const client = new TmuxClient(t.transport);
      t.feed(STARTUP_GREETING);
      createMainBridge(client, hub.ipcMain);

      const a = hub.createRenderer();
      const pa = createRendererBridge(a.ipcRenderer);

      const sub1 = pa.subscribeRaw("foo", "", "#{a}");
      feedCommandResponse(t, 1, []);
      await sub1;

      const unsub = pa.unsubscribe("foo");
      feedCommandResponse(t, 2, []);
      await unsub;

      // Now re-subscribe with a different format — refcount is 0 again, so
      // the new (what, format) becomes the canonical record without a
      // conflict.
      const sub2 = pa.subscribeRaw("foo", "", "#{b}");
      feedCommandResponse(t, 3, []);
      const resp2 = await sub2;
      expect(resp2.success).toBe(true);
      const fooSubs = t.sent.filter((c) =>
        c.startsWith("refresh-client -B 'foo':"),
      );
      expect(fooSubs).toHaveLength(2);
      expect(fooSubs[0]).toContain("'#{a}'");
      expect(fooSubs[1]).toContain("'#{b}'");
    });
  });
});

// ---------------------------------------------------------------------------
// parseAckMessage — ack channel trust boundary validation
// ---------------------------------------------------------------------------

describe("parseAckMessage — trust boundary", () => {
  it("accepts valid ack", () => {
    const msg = parseAckMessage({ paneId: 3, bytes: 1024 });
    expect(msg).toEqual({ paneId: 3, bytes: 1024 });
  });

  it.each([
    ["non-object", "string"],
    ["null", null],
    ["array", [1, 2]],
  ])("rejects %s envelope", (_name, value) => {
    expect(() => parseAckMessage(value)).toThrow(/INVALID_ARG/);
  });

  it.each([
    ["negative paneId", { paneId: -1, bytes: 0 }],
    ["non-integer paneId", { paneId: 3.5, bytes: 0 }],
    ["NaN paneId", { paneId: Number.NaN, bytes: 0 }],
    ["negative bytes", { paneId: 0, bytes: -1 }],
    ["non-finite bytes", { paneId: 0, bytes: Infinity }],
    ["missing paneId", { bytes: 0 }],
    ["missing bytes", { paneId: 0 }],
  ])("rejects %s", (_name, value) => {
    expect(() => parseAckMessage(value)).toThrow(/INVALID_ARG/);
  });
});

// ---------------------------------------------------------------------------
// qz5.2 — BridgeError round-trips with .code preserved across Electron IPC.
//
// Real Electron's `ipcMain.handle` rejection serializer drops subclass
// properties on Error instances, so a renderer reading `.code` directly off
// a thrown rejection will see `undefined`. The bridge solves this by
// returning a typed `InvokeResultEnvelope` and letting the renderer
// reconstruct via `BridgeError.fromPayload`. These tests prove that:
//
//   1. The renderer-side rejection IS a BridgeError instance.
//   2. The `.code` field survives the structured-clone hop.
//   3. The same class identity is shared with the WebSocket connector
//      (one `BridgeError` declaration in `src/connectors/errors.ts`).
// ---------------------------------------------------------------------------

describe("qz5.2 — BridgeError round-trips through Electron IPC", () => {
  it("renderer-side rejection is `instanceof BridgeError` with `.code` preserved (BRIDGE_INTERNAL)", async () => {
    // Drive a BRIDGE_INTERNAL rejection by making the synchronous send path
    // throw inside TmuxClient — the bridge wraps it via the envelope.
    const hub = createIpcHub();
    const t = createFakeTransport();
    (t.transport as { send: (cmd: string) => void }).send = () => {
      throw new Error("transport offline");
    };
    const client = new TmuxClient(t.transport);
    t.feed(STARTUP_GREETING);
    createMainBridge(client, hub.ipcMain);

    const renderer = hub.createRenderer();
    const proxy = createRendererBridge(renderer.ipcRenderer);

    const err = await proxy
      .execute("list-windows")
      .then(() => undefined, (e: unknown) => e);

    expect(err).toBeInstanceOf(BridgeError);
    expect((err as BridgeError).code).toBe("BRIDGE_INTERNAL");
    expect((err as Error).message).toMatch(/method=execute/);
    // Stack preservation regression (qz5.2 PR feedback): the cause's stack
    // must propagate across IPC so renderer-side logs localize to the
    // function that actually threw, not just to the bridge wrapper. The
    // pre-envelope code did this via `wrapped.stack = own + "\nCaused by: " + cause.stack`;
    // the new payload-based path must give the renderer the same context.
    const stack = (err as Error).stack ?? "";
    expect(stack).toMatch(/Caused by:/);
    expect(stack).toMatch(/transport offline/);
  });

  it("renderer-side rejection carries BRIDGE_UNKNOWN_METHOD via the proxy", async () => {
    // Going through the proxy is the canonical reconstruction path. Calling
    // a method that fails parseRpcRequest must surface as a typed
    // BridgeError on the renderer side, not as a generic Error with the
    // code lost in serialization.
    const hub = createIpcHub();
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    t.feed(STARTUP_GREETING);
    createMainBridge(client, hub.ipcMain);

    const renderer = hub.createRenderer();
    // Skip the proxy and call ipc.invoke directly with a bogus method name.
    // The envelope shape was already verified in C2; here we focus on the
    // class identity by reconstructing manually — same code path the proxy
    // uses internally.
    const envelope = (await renderer.ipcRenderer.invoke(IPC.invoke, {
      method: "kill-server",
      args: [],
    })) as { status: string; error: { code: string; message: string } };

    expect(envelope.status).toBe("bridge-error");
    const reconstructed = BridgeError.fromPayload(envelope.error as never);
    expect(reconstructed).toBeInstanceOf(BridgeError);
    expect(reconstructed.code).toBe("BRIDGE_UNKNOWN_METHOD");
  });

  it("the BridgeError class is the SAME class as the websocket connector exposes", async () => {
    // [LAW:one-source-of-truth] Both transports import BridgeError from
    // `src/connectors/errors.ts`. A constructor-identity check would trip
    // immediately if a future refactor reintroduced a parallel
    // declaration on either side.
    const wsModule = await import("../../src/connectors/websocket/protocol.js");
    expect(wsModule.BridgeError).toBe(BridgeError);
  });
});

