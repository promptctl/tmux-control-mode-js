// tests/unit/electron-bridge.test.ts
// Unit tests for the Electron IPC bridge: createMainBridge + createRendererBridge.
//
// Uses an in-memory IPC hub to couple a fake IpcMain with one or more fake
// IpcRenderers, plus a fake TmuxTransport to drive a real TmuxClient. No real
// Electron is involved.

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { TmuxClient } from "../../src/client.js";
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

  let invokeHandler: InvokeHandler | null = null;
  const mainOnListeners = new Map<string, Set<OnHandler>>();

  const ipcMain: IpcMainLike = {
    handle(channel, listener) {
      if (channel === IPC.invoke) invokeHandler = listener;
    },
    removeHandler(channel) {
      if (channel === IPC.invoke) invokeHandler = null;
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
        if (channel !== IPC.invoke || invokeHandler === null) {
          throw new Error(`no handler registered for ${channel}`);
        }
        return invokeHandler({ sender }, ...args);
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

    await expect(pending).rejects.toMatchObject({
      success: false,
      output: ["unknown command"],
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
