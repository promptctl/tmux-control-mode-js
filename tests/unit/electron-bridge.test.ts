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

import { TmuxClient } from "../../src/client.js";
import { TmuxCommandError } from "../../src/errors.js";
import type { TmuxTransport } from "../../src/transport/types.js";
import type { TmuxMessage } from "../../src/protocol/types.js";
import {
  IPC,
  type IpcMainLike,
  type IpcMainInvokeEventLike,
  type IpcMainEventLike,
  type IpcRendererLike,
  type WebContentsLike,
} from "../../src/connectors/electron/types.js";
import { createMainBridge } from "../../src/connectors/electron/main.js";
import {
  createRendererBridge,
  TmuxClientProxy,
} from "../../src/connectors/electron/renderer.js";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FakeRenderer {
  readonly ipcRenderer: IpcRendererLike;
  readonly sender: WebContentsLike;
  destroy(): void;
}

interface IpcHub {
  readonly ipcMain: IpcMainLike;
  createRenderer(): FakeRenderer;
}

function createIpcHub(): IpcHub {
  type InvokeHandler = (
    event: IpcMainInvokeEventLike,
    ...args: unknown[]
  ) => unknown | Promise<unknown>;
  type OnHandler = (event: IpcMainEventLike, ...args: unknown[]) => void;

  const invokeHandlers = new Map<string, InvokeHandler>();
  const mainOnListeners = new Map<string, Set<OnHandler>>();

  const ipcMain: IpcMainLike = {
    handle(channel, listener) {
      // [C1] Real Electron throws on second handler registration. The fake
      // mirrors that contract so unit tests fail loudly when a regression
      // re-introduces the per-window registration bug.
      if (invokeHandlers.has(channel)) {
        throw new Error(
          `Attempted to register a second handler for '${channel}'`,
        );
      }
      invokeHandlers.set(channel, listener);
    },
    removeHandler(channel) {
      invokeHandlers.delete(channel);
    },
    on(channel, listener) {
      let set = mainOnListeners.get(channel);
      if (!set) {
        set = new Set();
        mainOnListeners.set(channel, set);
      }
      set.add(listener as OnHandler);
    },
    removeListener(channel, listener) {
      mainOnListeners.get(channel)?.delete(listener as OnHandler);
    },
  };

  function createRenderer(): FakeRenderer {
    type RendererHandler = (event: unknown, ...args: unknown[]) => void;
    const rendererListeners = new Map<string, Set<RendererHandler>>();
    let destroyed = false;
    const destroyHandlers: Array<() => void> = [];

    const sender: WebContentsLike = {
      send(channel, ...args) {
        if (destroyed) return;
        const set = rendererListeners.get(channel);
        if (!set) return;
        for (const h of set) h({}, ...args);
      },
      once(event, listener) {
        if (event === "destroyed") destroyHandlers.push(listener);
      },
      isDestroyed() {
        return destroyed;
      },
    };

    const ipcRenderer: IpcRendererLike = {
      async invoke(channel, ...args) {
        const handler = invokeHandlers.get(channel);
        if (handler === undefined) {
          throw new Error(`no handler registered for ${channel}`);
        }
        return handler({ sender }, ...args);
      },
      send(channel, ...args) {
        const set = mainOnListeners.get(channel);
        if (!set) return;
        for (const h of set) h({ sender }, ...args);
      },
      on(channel, listener) {
        let set = rendererListeners.get(channel);
        if (!set) {
          set = new Set();
          rendererListeners.set(channel, set);
        }
        set.add(listener as RendererHandler);
      },
      removeListener(channel, listener) {
        rendererListeners.get(channel)?.delete(listener as RendererHandler);
      },
    };

    return {
      ipcRenderer,
      sender,
      destroy() {
        destroyed = true;
        for (const h of destroyHandlers) h();
      },
    };
  }

  return { ipcMain, createRenderer };
}

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
    createMainBridge(client, hub.ipcMain);

    expect(() => createMainBridge(client, hub.ipcMain)).toThrow(
      /ALREADY_REGISTERED/,
    );
  });

  it("releases the ipcMain on dispose so a fresh bridge can install", () => {
    const hub = createIpcHub();
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
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
    createMainBridge(client, hub.ipcMain);

    const renderer = hub.createRenderer();

    await expect(
      renderer.ipcRenderer.invoke(IPC.invoke, {
        method: "kill-server",
        args: [],
      }),
    ).rejects.toThrow(/UNKNOWN_METHOD/);
    expect(t.sent).toEqual([]);
  });

  it("rejects malformed envelope (non-object, missing method, non-array args)", async () => {
    const hub = createIpcHub();
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    createMainBridge(client, hub.ipcMain);

    const renderer = hub.createRenderer();

    await expect(
      renderer.ipcRenderer.invoke(IPC.invoke, "not-an-object"),
    ).rejects.toThrow(/INVALID_REQUEST/);
    await expect(
      renderer.ipcRenderer.invoke(IPC.invoke, { args: [] }),
    ).rejects.toThrow(/INVALID_REQUEST/);
    await expect(
      renderer.ipcRenderer.invoke(IPC.invoke, {
        method: "execute",
        args: "not-an-array",
      }),
    ).rejects.toThrow(/INVALID_REQUEST/);
    expect(t.sent).toEqual([]);
  });

  it("rejects bad arg shapes (wrong arity, wrong type)", async () => {
    const hub = createIpcHub();
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    createMainBridge(client, hub.ipcMain);

    const renderer = hub.createRenderer();

    // execute requires 1 string arg.
    await expect(
      renderer.ipcRenderer.invoke(IPC.invoke, { method: "execute", args: [] }),
    ).rejects.toThrow(/INVALID_ARG/);
    await expect(
      renderer.ipcRenderer.invoke(IPC.invoke, {
        method: "execute",
        args: [42],
      }),
    ).rejects.toThrow(/INVALID_ARG/);
    // sendKeys requires 2 strings.
    await expect(
      renderer.ipcRenderer.invoke(IPC.invoke, {
        method: "sendKeys",
        args: ["%0"],
      }),
    ).rejects.toThrow(/INVALID_ARG/);
    // setPaneAction requires (number, PaneAction).
    await expect(
      renderer.ipcRenderer.invoke(IPC.invoke, {
        method: "setPaneAction",
        args: [1, "bogus-action"],
      }),
    ).rejects.toThrow(/INVALID_ARG/);
    // setFlags requires string[].
    await expect(
      renderer.ipcRenderer.invoke(IPC.invoke, {
        method: "setFlags",
        args: [[1, 2, 3]],
      }),
    ).rejects.toThrow(/INVALID_ARG/);
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
    createMainBridge(client, hub.ipcMain);

    const renderer = hub.createRenderer();

    for (const evil of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      await expect(
        renderer.ipcRenderer.invoke(IPC.invoke, { method: evil, args: [] }),
      ).rejects.toThrow(/UNKNOWN_METHOD/);
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
    createMainBridge(client, hub.ipcMain);

    const renderer = hub.createRenderer();
    const proxy = createRendererBridge(renderer.ipcRenderer);

    const typed: TmuxMessage[] = [];
    const wildcard: TmuxMessage[] = [];
    proxy.on("window-add", (ev) => typed.push(ev));
    proxy.on("*", (ev) => wildcard.push(ev));

    t.feed("%window-add @5\n");
    t.feed("%session-renamed $1 my-session\n");

    expect(typed).toEqual([{ type: "window-add", windowId: 5 }]);
    expect(wildcard).toHaveLength(2);
    expect(wildcard[0]?.type).toBe("window-add");
    expect(wildcard[1]?.type).toBe("session-renamed");
  });

  it("preserves Uint8Array identity through OutputMessage round-trip", () => {
    // Electron IPC uses structured clone, which preserves Uint8Array natively.
    // Our in-memory hub passes references directly — which is a stronger test
    // of the path, since if we accidentally stringified anywhere it would break.
    const hub = createIpcHub();
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    createMainBridge(client, hub.ipcMain);

    const renderer = hub.createRenderer();
    const proxy = createRendererBridge(renderer.ipcRenderer);

    const received: Array<{ paneId: number; data: Uint8Array }> = [];
    proxy.on("output", (ev) => {
      received.push({ paneId: ev.paneId, data: ev.data });
    });

    t.feed("%output %2 hello\n");

    expect(received).toHaveLength(1);
    expect(received[0]?.paneId).toBe(2);
    expect(received[0]?.data).toBeInstanceOf(Uint8Array);
    expect(Array.from(received[0]!.data)).toEqual(
      Array.from(new TextEncoder().encode("hello")),
    );
  });

  it("fans events out to multiple registered renderers", () => {
    const hub = createIpcHub();
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
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
    createMainBridge(client, hub.ipcMain);

    const renderer = hub.createRenderer();
    const proxy = createRendererBridge(renderer.ipcRenderer);

    const pending = proxy.sendKeys("%0", "hello");
    expect(t.sent[0]).toContain("send-keys");
    expect(t.sent[0]).toContain("%0");
    expect(t.sent[0]).toContain("hello");

    feedCommandResponse(t, 1, []);
    await pending;
  });

  it("splitWindow forwards the options object", async () => {
    const hub = createIpcHub();
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
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
    const client = new TmuxClient(t.transport);
    createMainBridge(client, hub.ipcMain);

    const renderer = hub.createRenderer();
    const proxy = createRendererBridge(renderer.ipcRenderer);

    const report = "\u001b]10;rgb:1818/1818/1818\u001b\\";
    const pending = proxy.requestReport(3, report);
    expect(t.sent[0]).toContain("refresh-client");
    expect(t.sent[0]).toContain("%3");

    feedCommandResponse(t, 1, []);
    await pending;
  });

  it("detach is fire-and-forget (void return)", () => {
    const hub = createIpcHub();
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    createMainBridge(client, hub.ipcMain);

    const renderer = hub.createRenderer();
    const proxy = createRendererBridge(renderer.ipcRenderer);

    const result = proxy.detach();
    expect(result).toBeUndefined();
    // TmuxClient.detach sends a single LF per SPEC §4.1.
    expect(t.sent).toEqual(["\n"]);
  });

  it("rejects the renderer promise when main-side execute fails", async () => {
    const hub = createIpcHub();
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
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
// MainBridgeHandle.dispose
// ---------------------------------------------------------------------------

describe("Electron IPC bridge — dispose", () => {
  it("removes all ipcMain handlers and stops forwarding events", () => {
    const hub = createIpcHub();
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
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

describe("Electron IPC bridge — type surface", () => {
  it("TmuxClientProxy constructor accepts an IpcRendererLike", () => {
    // If this test compiles, the shape guarantee holds. Purely a compile-time
    // check reified as a runtime no-op.
    const hub = createIpcHub();
    const r = hub.createRenderer();
    const proxy: TmuxClientProxy = createRendererBridge(r.ipcRenderer);
    expect(proxy).toBeInstanceOf(TmuxClientProxy);
  });
});

// ---------------------------------------------------------------------------
// Import-graph smoke test: renderer must not transitively pull Node modules.
// ---------------------------------------------------------------------------

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
      const re =
        /(?<!\/\/[^\n]*)import\s+(?:type\s+)?(?:[^'"]+?\s+from\s+)?["']([^"']+)["']/g;
      for (const m of src.matchAll(re)) {
        const spec = m[1]!;
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

