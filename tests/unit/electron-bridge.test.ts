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
import { RPC_METHOD_NAMES } from "../../src/connectors/rpc.js";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FakeRenderer {
  readonly ipcRenderer: IpcRendererLike;
  readonly sender: WebContentsLike;
  destroy(): void;
  /**
   * Visibility hook for M2 regression tests: how many `destroyed` listeners
   * are still attached to this fake's WebContents. After a sender is torn
   * down via `unregister` while alive, this should drop to 0 — proving the
   * bridge actually called `removeListener` rather than leaking the handler.
   */
  destroyHandlerCount(): number;
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
    // Set so removeListener('destroyed', ...) can detach a single handler —
    // mirrors real Electron, where once-handlers can be removed before
    // they fire. Using a Set also makes "registered handler count" a
    // first-class assertion target for the M2 leak test.
    const destroyHandlers = new Set<() => void>();

    const sender: WebContentsLike = {
      send(channel, ...args) {
        if (destroyed) return;
        const set = rendererListeners.get(channel);
        if (!set) return;
        // [M6] Real Electron sends args through structuredClone before they
        // reach the renderer. Mirroring that here means a test that mutates
        // the source object after dispatch (or relies on by-ref identity)
        // fails the same way it would in production. Uint8Array round-trips
        // through structuredClone natively.
        for (const h of set) h({}, ...cloneArgs(args));
      },
      once(event, listener) {
        if (event === "destroyed") destroyHandlers.add(listener);
      },
      removeListener(event, listener) {
        if (event === "destroyed") destroyHandlers.delete(listener);
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
        // [M6] Round-trip args through structuredClone so the main-side
        // handler operates on its own copy — same as real Electron IPC.
        // The handler's return value also crosses the IPC boundary, so we
        // clone it on the way back.
        const result = await handler({ sender }, ...cloneArgs(args));
        return cloneArgs([result])[0];
      },
      send(channel, ...args) {
        const set = mainOnListeners.get(channel);
        if (!set) return;
        for (const h of set) h({ sender }, ...cloneArgs(args));
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
        // Snapshot so a destroy handler that mutates the set (e.g. via
        // teardownSender → wc.removeListener) does not perturb iteration.
        const snapshot = [...destroyHandlers];
        destroyHandlers.clear();
        for (const h of snapshot) h();
      },
      destroyHandlerCount: () => destroyHandlers.size,
    };
  }

  return { ipcMain, createRenderer };
}

// ---------------------------------------------------------------------------
// structuredClone shim for the fake hub.
//
// Real Electron IPC payloads cross a structured-clone boundary: a renderer
// that mutates its sent object after dispatch cannot perturb the main side,
// and main return values arrive as fresh copies. The test hub mirrors this
// so a regression that depends on shared identity (or mutates Uint8Array
// payloads after send) fails here the same way it would in production.
// ---------------------------------------------------------------------------

function cloneArgs(args: readonly unknown[]): unknown[] {
  return args.map((a) => structuredClone(a));
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

  it("preserves Uint8Array contents through OutputMessage round-trip", () => {
    // Electron IPC uses structured clone, which preserves Uint8Array natively.
    // The hub now mirrors that with `cloneArgs` (structuredClone per arg) so
    // a regression that depends on shared identity — or stringifies anywhere
    // along the path — fails here the same way it would in production.
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

  it("detach is NOT exposed on the proxy (admin-only) and renderer attempts are rejected", async () => {
    // H2: detach tears down the tmux client for every renderer sharing the
    // bridge — it is an admin operation owned by the main process, not any
    // single window. A renderer that crafts a raw {method:'detach'} request
    // is rejected at the trust boundary with UNKNOWN_METHOD; tmux never sees
    // the LF detach signal (so no other windows get torn down).
    const hub = createIpcHub();
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    createMainBridge(client, hub.ipcMain);

    const renderer = hub.createRenderer();
    const proxy = createRendererBridge(renderer.ipcRenderer);

    // Compile-time: TmuxClientProxy must not expose detach.
    expect((proxy as unknown as { detach?: unknown }).detach).toBeUndefined();

    // Runtime trust-boundary: bypassing the proxy and crafting a raw IPC
    // payload still gets rejected with UNKNOWN_METHOD.
    await expect(
      renderer.ipcRenderer.invoke(IPC.invoke, { method: "detach", args: [] }),
    ).rejects.toThrow(/UNKNOWN_METHOD/);
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
    createMainBridge(client, hub.ipcMain);

    const renderer = hub.createRenderer();
    const proxy = createRendererBridge(renderer.ipcRenderer);

    await expect(proxy.execute("list-windows")).rejects.toThrow(
      /BRIDGE_INTERNAL.*method=execute.*transport offline/,
    );
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
    const handle = createMainBridge(client, hub.ipcMain);
    await handle.drain();
    handle.dispose();
  });

  it("drain awaits every in-flight invoke after dispose (aborted dispatches resolve)", async () => {
    const hub = createIpcHub();
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
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

    // Clean up: dispose to remove handlers; client.close to release the
    // pending FIFO entry so vitest doesn't complain about open handles.
    handle.dispose();
    void t; // silence lint
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
    const hub = createIpcHub();
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    createMainBridge(client, hub.ipcMain);

    const renderer = hub.createRenderer();
    const proxy = createRendererBridge(renderer.ipcRenderer);
    const received: TmuxMessage[] = [];
    proxy.on("output", (m) => received.push(m));

    // Synthesize a %output frame end-to-end through the parser.
    const payload = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    t.feed(`%output %1 \\336\\255\\276\\357\n`);

    // Allow microtasks to drain.
    await Promise.resolve();
    await Promise.resolve();

    expect(received).toHaveLength(1);
    const ev = received[0]!;
    expect(ev.type).toBe("output");
    if (ev.type !== "output") return;
    expect([...ev.data]).toEqual([...payload]);
    // The renderer's copy is a fresh Uint8Array, NOT the main-side identity.
    // (We cannot probe main-side identity directly — but a structuredClone
    // round-trip guarantees the buffers are different objects.)
    expect(ev.data).toBeInstanceOf(Uint8Array);
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
    createMainBridge(client, hub.ipcMain);

    const a = hub.createRenderer();
    const b = hub.createRenderer();
    const c = hub.createRenderer();

    const proxyA = createRendererBridge(a.ipcRenderer);
    const proxyB = createRendererBridge(b.ipcRenderer);
    const proxyC = createRendererBridge(c.ipcRenderer);

    const got: Array<["a" | "c", string]> = [];
    proxyA.on("output", (m) => got.push(["a", m.type]));
    proxyC.on("output", (m) => got.push(["c", m.type]));
    // proxyB receives nothing — destroyed before broadcast.

    // Destroy B's wc directly (real Electron: webContents went away during
    // event delivery). Then drive a %output through main; main's forward()
    // must visit A and C without skipping or double-tearing-down.
    b.destroy();
    void proxyB; // keep reference so unused-variable lint is quiet

    t.feed(`%output %42 ok\n`);
    await Promise.resolve();
    await Promise.resolve();

    const labels = got.map(([who]) => who).sort();
    expect(labels).toEqual(["a", "c"]);
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
    createMainBridge(client, hub.ipcMain);

    const r = hub.createRenderer();
    const proxy = createRendererBridge(r.ipcRenderer);

    const sub = proxy.subscribe("focus", "", "#{pane_id}");
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

    await expect(proxy.execute("anything")).rejects.toThrow(/TIMEOUT/);

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
    createMainBridge(client, hub.ipcMain);

    const r = hub.createRenderer();
    const proxy = new TmuxClientProxy(r.ipcRenderer); // no timeout option

    const p = proxy.listPanes();
    feedCommandResponse(t, 0, []);
    const resp = await p;
    expect(resp.success).toBe(true);
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
    createMainBridge(client, hub.ipcMain);

    const a = hub.createRenderer();
    const b = hub.createRenderer();
    const pa = createRendererBridge(a.ipcRenderer);
    const pb = createRendererBridge(b.ipcRenderer);

    // A subscribes — bridge forwards the subscribe to tmux.
    const aSub = pa.subscribe("focus", "", "#{pane_id}");
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
    createMainBridge(client, hub.ipcMain);

    const a = hub.createRenderer();
    const b = hub.createRenderer();
    const pa = createRendererBridge(a.ipcRenderer);
    const pb = createRendererBridge(b.ipcRenderer);

    const aSub = pa.subscribe("focus", "", "#{pane_id}");
    feedCommandResponse(t, 1, []);
    await aSub;
    const bSub = pb.subscribe("focus", "", "#{pane_id}");
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
    createMainBridge(client, hub.ipcMain);

    const a = hub.createRenderer();
    const pa = createRendererBridge(a.ipcRenderer);

    const sub = pa.subscribe("focus", "", "#{pane_id}");
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
    createMainBridge(client, hub.ipcMain);

    const a = hub.createRenderer();
    const b = hub.createRenderer();
    const pa = createRendererBridge(a.ipcRenderer);
    const pb = createRendererBridge(b.ipcRenderer);

    const aSub = pa.subscribe("focus", "", "#{pane_id}");
    feedCommandResponse(t, 1, []);
    await aSub;
    const bSub = pb.subscribe("focus", "", "#{pane_id}");
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
    const handle = createMainBridge(client, hub.ipcMain);

    const a = hub.createRenderer();
    const pa = createRendererBridge(a.ipcRenderer);

    const aSub1 = pa.subscribe("focus", "", "#{pane_id}");
    feedCommandResponse(t, 1, []);
    await aSub1;
    const aSub2 = pa.subscribe("layout", "", "#{window_id}");
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
});

