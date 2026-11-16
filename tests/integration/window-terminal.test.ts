// tests/integration/window-terminal.test.ts
//
// The window engine and the size declarer against a real tmux: the view's
// rects are tmux's, splits/closes/zoom are followed, keys reach the pane they
// were typed into and no other, the window's end is reported, a per-window
// size declaration stays on its window (F1), and through the WebSocket bridge
// a dropped socket reads as stale and comes back live with every pane
// reseeded once. Panes run `cat`, so what is typed is what the pane shows.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { WebSocket as WsClient, WebSocketServer } from "ws";
import { killTmuxServer } from "../helpers/reap-test-sockets.js";
import {
  attachSession,
  hexBytes,
  rawInputCapture,
  readUntil,
  tmux,
  uniqueName,
  uniqueSocket,
} from "../helpers/integration.js";
import type { TmuxClient } from "../../src/client.js";
import { createWebSocketBridge } from "../../src/connectors/websocket/server.js";
import { WebSocketTmuxClient } from "../../src/connectors/websocket/client.js";
import { BridgeError } from "../../src/bridge-error.js";
import type {
  BrowserWebSocketLike,
  ServerWebSocketLike,
} from "../../src/connectors/websocket/types.js";
import {
  WindowEngine,
  type PaneSurfaces,
} from "../../src/window-terminal/engine/window-engine.js";
import type { TerminalConnection } from "../../src/window-terminal/engine/pane-stream.js";
import { BufferingSink } from "../../src/window-terminal/engine/terminal-sink.js";
import type {
  WindowTerminalState,
  WindowView,
} from "../../src/window-terminal/engine/window-model.js";
import { PANE_META_FORMAT } from "../../src/window-terminal/engine/bootstrap.js";
import type { PaneId, WindowId } from "../../src/window-terminal/ids.js";
import { ClientSizeDeclarer } from "../../src/window-terminal/sizing/client-size.js";

const RUN_INTEGRATION = process.env.TMUX_INTEGRATION === "1";

interface Recorder extends PaneSurfaces {
  readonly sinks: Map<PaneId, BufferingSink>;
  /** Input bytes into a pane's surface; throws when the engine never created it. */
  send(pane: PaneId, bytes: Uint8Array): void;
  readonly disposed: PaneId[];
}

function recorder(): Recorder {
  const sinks = new Map<PaneId, BufferingSink>();
  const keys = new Map<PaneId, (bytes: Uint8Array) => void>();
  const disposed: PaneId[] = [];
  return {
    sinks,
    disposed,
    send(pane, bytes) {
      const send = keys.get(pane);
      if (send === undefined) throw new Error(`no surface for pane ${pane}`);
      send(bytes);
    },
    create(pane, send) {
      const sink = new BufferingSink();
      sinks.set(pane, sink);
      keys.set(pane, send);
      return {
        sink,
        failures: [],
        dispose() {
          disposed.push(pane);
        },
      };
    },
  };
}

function engineOver(
  connection: TerminalConnection,
  windowId: WindowId,
  surfaces: PaneSurfaces,
): WindowEngine {
  return new WindowEngine({
    connection,
    windowId,
    history: 100,
    surfaces,
    now: () => Date.now(),
  });
}

function liveView(state: WindowTerminalState): WindowView | null {
  return state.phase === "live" ? state.window : null;
}

async function untilLive(
  engine: WindowEngine,
  pred: (v: WindowView) => boolean = () => true,
): Promise<WindowView> {
  const state = await readUntil(
    () => engine.state,
    (st) => {
      const v = liveView(st);
      return v !== null && pred(v);
    },
    "the window never went live in the expected shape",
  );
  return liveView(state) as WindowView;
}

function q(socket: string, args: readonly string[]): string {
  return tmux(socket, args);
}

describe.skipIf(!RUN_INTEGRATION)("window terminal — real tmux", () => {
  let socket = "";
  let client: TmuxClient | null = null;
  let engine: WindowEngine | null = null;

  beforeEach(() => {
    socket = uniqueSocket("tmux-js-wterm-", "wt");
  });

  afterEach(() => {
    engine?.dispose();
    engine = null;
    client?.close();
    client = null;
    if (socket !== "") killTmuxServer(socket);
    socket = "";
  });

  async function start(): Promise<{ c: TmuxClient; window: WindowId }> {
    const session = uniqueName("wt");
    const c = await attachSession(socket, session, {
      newSessionFlags: ["-x", "120", "-y", "40", "cat"],
    });
    client = c;
    const window = q(socket, [
      "display-message",
      "-p",
      "-t",
      session,
      "#{window_id}",
    ]);
    return { c, window: window as WindowId };
  }

  function rectsFromTmux(window: string) {
    return q(socket, [
      "list-panes",
      "-t",
      window,
      "-F",
      "#{pane_id} #{pane_left} #{pane_top} #{pane_width} #{pane_height}",
    ])
      .split("\n")
      .map((line) => {
        const [id, x, y, cols, rows] = line.split(" ");
        return [id, { x: +x, y: +y, cols: +cols, rows: +rows }];
      });
  }

  it("the view's panes and rects are tmux's, in layout order", async () => {
    const { c, window } = await start();
    q(socket, ["split-window", "-h", "-t", window, "cat"]);
    const s = recorder();
    engine = engineOver(c, window, s);
    const view = await untilLive(engine, (v) => v.panes.length === 2);
    expect(view.panes.map((p) => [p.id, p.rect])).toEqual(
      rectsFromTmux(window),
    );
    expect(view.size.cols).toBe(
      Number(
        q(socket, ["display-message", "-p", "-t", window, "#{window_width}"]),
      ),
    );
  });

  it("follows a split (the new pane is seeded), a kill and a zoom", async () => {
    const { c, window } = await start();
    const s = recorder();
    engine = engineOver(c, window, s);
    await untilLive(engine, (v) => v.panes.length === 1);

    const added = q(socket, [
      "split-window",
      "-h",
      "-t",
      window,
      "-P",
      "-F",
      "#{pane_id}",
      "cat",
    ]) as PaneId;
    await untilLive(engine, (v) => v.panes.some((p) => p.id === added));
    await readUntil(
      () => s.sinks.get(added)?.seedCalls.length ?? 0,
      (seeds) => seeds === 1,
      "the split's new pane was not seeded once",
    );

    q(socket, ["resize-pane", "-Z", "-t", added]);
    const zoomed = await untilLive(engine, (v) => v.zoomed === added);
    expect(zoomed.panes).toHaveLength(2);
    expect(zoomed.focus).toBe(added);
    q(socket, ["resize-pane", "-Z", "-t", added]);
    await untilLive(engine, (v) => v.zoomed === null);

    q(socket, ["kill-pane", "-t", added]);
    await untilLive(engine, (v) => v.panes.length === 1);
    expect(s.disposed).toEqual([added]);
  });

  // Arrival reads every fact once; from then on they reach the view only
  // through the terminal's format subscriptions.
  it("after arrival, a pane retitled and resized in tmux reaches the view and the pane's surface", async () => {
    const { c, window } = await start();
    const added = q(socket, [
      "split-window",
      "-h",
      "-t",
      window,
      "-P",
      "-F",
      "#{pane_id}",
      "cat",
    ]) as PaneId;
    const s = recorder();
    engine = engineOver(c, window, s);
    await untilLive(engine, (v) => v.panes.length === 2);

    q(socket, ["select-pane", "-t", added, "-T", "retitled"]);
    await untilLive(engine, (v) =>
      v.panes.some((p) => p.id === added && p.title === "retitled"),
    );

    q(socket, ["resize-pane", "-t", added, "-x", "30"]);
    await readUntil(
      () => s.sinks.get(added)?.resizeCalls.at(-1),
      (last) => last?.cols === 30,
      "the pane's surface never resized to 30 columns",
    );
  });

  it("the pane-meta format reads a control byte in a command as ?, on the running tmux", async () => {
    const { window } = await start();
    const pane = q(socket, [
      "display-message",
      "-p",
      "-t",
      window,
      "#{pane_id}",
    ]);
    // tmux writes a subscription value into the control stream raw, so a
    // command named "x\n%exit" would end the connection. The substitution is
    // the same over any value; a pane option stands in for the command.
    q(socket, ["set-option", "-p", "-t", pane, "@hostile", "x\n%exit"]);
    q(socket, ["select-pane", "-t", pane, "-T", "t"]);
    expect(PANE_META_FORMAT).toContain(":pane_current_command}");
    const format = PANE_META_FORMAT.replace(
      ":pane_current_command}",
      ":@hostile}",
    );
    expect(q(socket, ["display-message", "-p", "-t", pane, format])).toBe(
      "t\tx?%exit",
    );

    // A dead pane has no command, as the bootstrap's snapshot reads it.
    q(socket, ["set-option", "-w", "-t", window, "remain-on-exit", "on"]);
    const dead = q(socket, [
      "split-window",
      "-t",
      window,
      "-P",
      "-F",
      "#{pane_id}",
      "true",
    ]);
    await readUntil(
      () => q(socket, ["display-message", "-p", "-t", dead, "#{pane_dead}"]),
      (paneDead) => paneDead === "1",
      "the split's pane never died",
      3000,
    );
    q(socket, ["set-option", "-p", "-t", dead, "@hostile", "x"]);
    q(socket, ["select-pane", "-t", dead, "-T", "t"]);
    // The `|` keeps the empty command from being trimmed off the reply.
    expect(q(socket, ["display-message", "-p", "-t", dead, `${format}|`])).toBe(
      "t\t|",
    );
  });

  it("keys typed into a pane land in that pane only, and tmux's active pane stays", async () => {
    const { c, window } = await start();
    const first = q(socket, [
      "display-message",
      "-p",
      "-t",
      window,
      "#{pane_id}",
    ]);
    q(socket, ["split-window", "-h", "-t", window, "cat"]);
    const active = q(socket, [
      "display-message",
      "-p",
      "-t",
      window,
      "#{pane_id}",
    ]);
    expect(active).not.toBe(first);
    const s = recorder();
    engine = engineOver(c, window, s);
    await untilLive(engine, (v) => v.panes.length === 2);

    s.send(first as PaneId, new TextEncoder().encode("WT_KEYS_MARK"));
    const captured = (pane: string) =>
      q(socket, ["capture-pane", "-p", "-t", pane]);
    await readUntil(
      () => captured(first),
      (text) => text.includes("WT_KEYS_MARK"),
      "the keys never reached the first pane",
    );
    expect(captured(active)).not.toContain("WT_KEYS_MARK");
    expect(
      q(socket, ["display-message", "-p", "-t", window, "#{pane_id}"]),
    ).toBe(active);
  });

  it("input bytes typed into a pane reach its program byte-exact, a legacy mouse report included", async () => {
    const { c, window } = await start();
    const capture = rawInputCapture();
    q(socket, ["split-window", "-h", "-t", window, capture.command]);
    const pane = q(socket, [
      "display-message",
      "-p",
      "-t",
      window,
      "#{pane_id}",
    ]);
    const s = recorder();
    engine = engineOver(c, window, s);
    await untilLive(engine, (v) => v.panes.length === 2);
    await readUntil(
      () =>
        q(socket, [
          "display-message",
          "-p",
          "-t",
          pane,
          "#{pane_current_command}",
        ]),
      (cmd) => cmd === "cat",
      "the pane never reached cat",
    );

    // A DEFAULT-encoded press at column 129 (0xa1), then "é" as UTF-8.
    const mouse = new Uint8Array([0x1b, 0x5b, 0x4d, 0x20, 0xa1, 0x21]);
    const text = new TextEncoder().encode("é");
    s.send(pane as PaneId, mouse);
    s.send(pane as PaneId, text);
    const expected = hexBytes([...mouse, ...text]);
    await readUntil(
      capture.hex,
      (got) => got === expected,
      `the pane never received exactly ${expected}`,
    );
  });

  it("kill-window is gone(window-closed)", async () => {
    const { c, window } = await start();
    q(socket, ["new-window", "-d", "cat"]);
    engine = engineOver(c, window, recorder());
    await untilLive(engine);
    q(socket, ["kill-window", "-t", window]);
    await readUntil(
      () => engine?.state,
      (st) => st?.phase === "gone",
      "the engine never went gone",
    );
    expect(engine.state).toEqual({ phase: "gone", reason: "window-closed" });
  });

  it("a window in another session is gone(window-unreachable)", async () => {
    const { c } = await start();
    const elsewhere = q(socket, [
      "new-session",
      "-d",
      "-s",
      uniqueName("other"),
      "-P",
      "-F",
      "#{window_id}",
      "cat",
    ]) as WindowId;
    engine = engineOver(c, elsewhere, recorder());
    await readUntil(
      () => engine?.state,
      (st) => st?.phase === "gone",
      "the engine never went gone",
    );
    expect(engine.state).toEqual({
      phase: "gone",
      reason: "window-unreachable",
    });
  });

  // F1: does a per-window declaration squash the session's other windows?
  // Outcome on tmux 3.8: yes. The first `-C @W:CxR` makes the control client
  // a sizing client for every window (CLIENT_WINDOWSIZECHANGED, never
  // cleared), and a window it declared nothing for reads its tty size, 80x24.
  // So `ClientSizeDeclarer` sets the overall size with each declaration.
  async function twoWindows() {
    const { c, window: a } = await start();
    const b = q(socket, [
      "new-window",
      "-d",
      "-P",
      "-F",
      "#{window_id}",
      "cat",
    ]);
    const size = (w: string) =>
      q(socket, [
        "display-message",
        "-p",
        "-t",
        w,
        "#{window_width}x#{window_height}",
      ]);
    // tmux resizes a window to its session's clients when it is visited, on
    // a later turn of its loop.
    const visit = async (w: string) => {
      q(socket, ["select-window", "-t", w]);
      await new Promise((r) => setTimeout(r, 300));
    };
    await visit(b);
    await visit(a);
    return { c, a, b, size, visit };
  }

  it("F1: a per-window declaration alone squashes the session's other windows to 80x24", async () => {
    const { c, a, b, size, visit } = await twoWindows();
    expect(size(b)).toBe("120x40");
    await c.setWindowSize(Number(a.slice(1)), 100, 30);
    await readUntil(
      () => size(a),
      (sz) => sz === "100x30",
      "window A never took its declared size",
    );
    await visit(b);
    expect(size(b)).toBe("80x24");
    await c.clearWindowSize(Number(a.slice(1)));
  });

  it("F1 mitigation: with the declarer, the other windows read the declared size, and A keeps its own", async () => {
    const { c, a, b, size, visit } = await twoWindows();
    const errors: unknown[] = [];
    const declarer = new ClientSizeDeclarer({
      connection: c,
      windowId: a as WindowId,
      onError: (e) => errors.push(e),
    });
    declarer.apply({ kind: "declare", grid: { cols: 110, rows: 35 } });
    await readUntil(
      () => size(a),
      (sz) => sz === "110x35",
      "window A never took its declared size",
    );
    await visit(b);
    expect(size(b)).toBe("110x35");
    await visit(a);
    expect(size(a)).toBe("110x35");
    declarer.dispose();
    expect(errors).toEqual([]);
  });
});

describe.skipIf(!RUN_INTEGRATION)(
  "window terminal — through the WebSocket bridge",
  () => {
    let socket = "";
    const teardown: (() => Promise<void> | void)[] = [];

    beforeEach(() => {
      socket = uniqueSocket("tmux-js-wterm-", "br");
    });

    afterEach(async () => {
      for (const t of teardown.reverse()) await t();
      teardown.length = 0;
      if (socket !== "") killTmuxServer(socket);
      socket = "";
    });

    // The browser's reconnect policy: a short, fixed backoff.
    const RETRY = {
      maxAttempts: 5,
      initialDelayMs: 25,
      maxDelayMs: 50,
      factor: 1,
      jitterMs: 0,
    } as const;

    // A bridge on a loopback port and a browser client of it, retrying on
    // RETRY, both torn down with the test. `sockets` holds every
    // socket the browser opened, latest last.
    async function browserOverBridge(
      createClient: () => TmuxClient,
    ): Promise<{ browser: WebSocketTmuxClient; sockets: WsClient[] }> {
      const bridge = createWebSocketBridge({ createClient });
      const http = createServer();
      const wss = new WebSocketServer({ server: http, path: "/tmux" });
      wss.on("connection", (ws, req) => {
        void bridge.handleConnection(ws as unknown as ServerWebSocketLike, {
          url: req.url,
          headers: {},
          remoteAddress: undefined,
        });
      });
      const port = await new Promise<number>((resolve) => {
        http.listen(0, "127.0.0.1", () => {
          const addr = http.address();
          resolve(typeof addr === "object" && addr !== null ? addr.port : 0);
        });
      });
      teardown.push(async () => {
        await bridge.shutdown(1_000);
        await new Promise<void>((r) => wss.close(() => r()));
        await new Promise<void>((r) => http.close(() => r()));
      });

      const sockets: WsClient[] = [];
      const browser = new WebSocketTmuxClient({
        url: `ws://127.0.0.1:${port}/tmux`,
        createWebSocket: (u) => {
          const ws = new WsClient(u);
          sockets.push(ws);
          return ws as unknown as BrowserWebSocketLike;
        },
        reconnect: RETRY,
        heartbeatIntervalMs: 0,
      });
      teardown.push(() => browser.close());
      return { browser, sockets };
    }

    // The cc-dump-web factory: it backs a connection with `tmuxClient` while
    // tmux still has `window`, and refuses for good once it does not.
    // `calls` counts every connection it was asked to back.
    function windowFactory(
      tmuxClient: TmuxClient,
      window: WindowId,
    ): { createClient: () => TmuxClient; calls: () => number } {
      let calls = 0;
      return {
        createClient: () => {
          calls++;
          const windows = q(socket, [
            "list-windows",
            "-a",
            "-F",
            "#{window_id}",
          ]);
          if (!windows.split("\n").includes(window)) {
            throw new BridgeError(
              "BRIDGE_REFUSED",
              `can't find window: ${window}`,
            );
          }
          return tmuxClient;
        },
        calls: () => calls,
      };
    }

    // Twice the whole retry budget's backoff (no jitter), so a retry the
    // client wrongly scheduled would have reached the factory.
    const pastRetryBudget = (): Promise<void> =>
      new Promise((r) =>
        setTimeout(r, 2 * RETRY.maxAttempts * RETRY.maxDelayMs),
      );

    it("a dropped socket is stale with the last picture, then live again with each pane reseeded once", async () => {
      const tmuxClient = await attachSession(socket, uniqueName("br"), {
        newSessionFlags: ["-x", "120", "-y", "40", "cat"],
      });
      teardown.push(() => tmuxClient.close());
      const window = q(socket, [
        "display-message",
        "-p",
        "#{window_id}",
      ]) as WindowId;
      q(socket, ["split-window", "-h", "-t", window, "cat"]);

      const { browser, sockets } = await browserOverBridge(() => tmuxClient);

      const s = recorder();
      const engine = engineOver(browser, window, s);
      teardown.push(() => engine.dispose());
      await untilLive(engine, (v) => v.panes.length === 2);
      await readUntil(
        () => [...s.sinks.values()].map((sink) => sink.seedCalls.length),
        (seeds) => seeds.every((n) => n === 1),
        "every pane was not seeded once",
      );
      const before = await untilLive(engine, (v) =>
        v.panes.every((p) => !p.resyncing),
      );

      // Recorded from before the terminate: the 25ms reconnect can end the
      // stale phase between two samples of engine.state.
      // [LAW:no-ambient-temporal-coupling]
      const states: (typeof engine.state)[] = [];
      const offState = engine.onState((st) => states.push(st));
      sockets.at(-1)?.terminate();
      await readUntil(
        () => states.map((st) => st.phase),
        (phases) => phases.includes("stale"),
        "the engine never went stale",
      );
      offState();
      expect(states.find((st) => st.phase === "stale")).toMatchObject({
        phase: "stale",
        window: before,
      });

      await untilLive(engine);
      await readUntil(
        () => [...s.sinks.values()].map((sink) => sink.seedCalls.length),
        (seeds) => seeds.every((n) => n === 2),
        "every pane was not reseeded once",
      );
      await new Promise((r) => setTimeout(r, 300));
      expect(
        [...s.sinks.values()].map((sink) => sink.seedCalls.length),
      ).toEqual([2, 2]);
      expect(s.sinks.size).toBe(2);
    }, 20_000);

    it("a window gone before the page connects is gone at once: one refused connection, never stale", async () => {
      const tmuxClient = await attachSession(socket, uniqueName("br"), {
        newSessionFlags: ["-x", "120", "-y", "40", "cat"],
      });
      teardown.push(() => tmuxClient.close());
      const window = q(socket, [
        "new-window",
        "-d",
        "-P",
        "-F",
        "#{window_id}",
        "cat",
      ]) as WindowId;
      q(socket, ["kill-window", "-t", window]);
      const factory = windowFactory(tmuxClient, window);

      const { browser } = await browserOverBridge(factory.createClient);
      const statuses: string[] = [];
      browser.on("connection-state", (ev) => statuses.push(ev.state.status));
      const engine = engineOver(browser, window, recorder());
      teardown.push(() => engine.dispose());
      const phases: string[] = [];
      engine.onState((st) => phases.push(st.phase));

      const gone = await readUntil(
        () => engine.state,
        (st) => st.phase === "gone",
        "the engine never went gone",
      );
      expect(gone).toEqual({
        phase: "gone",
        reason: "connection-closed",
        detail: expect.stringContaining(`can't find window: ${window}`),
      });
      expect(browser.connectionState).toMatchObject({
        status: "closed",
        reason: "refused",
        error: expect.objectContaining({ code: "BRIDGE_REFUSED" }),
      });
      await pastRetryBudget();
      expect(factory.calls()).toBe(1);
      expect(statuses).not.toContain("reconnecting");
      expect(phases).not.toContain("stale");
    }, 20_000);

    it("a dropped socket whose window the bridge then refuses ends refused after one retry, not the whole budget", async () => {
      const tmuxClient = await attachSession(socket, uniqueName("br"), {
        newSessionFlags: ["-x", "120", "-y", "40", "cat"],
      });
      teardown.push(() => tmuxClient.close());
      const window = q(socket, [
        "new-window",
        "-d",
        "-P",
        "-F",
        "#{window_id}",
        "cat",
      ]) as WindowId;
      const factory = windowFactory(tmuxClient, window);

      const { browser, sockets } = await browserOverBridge(
        factory.createClient,
      );
      await readUntil(
        () => browser.connectionState.status,
        (st) => st === "ready",
        "the browser never became ready",
      );
      const statuses: string[] = [];
      browser.on("connection-state", (ev) => statuses.push(ev.state.status));

      // The window goes under a live connection (its client is the session's,
      // which outlives the window), so the connection the page opens after
      // the drop is the bridge's to refuse.
      q(socket, ["kill-window", "-t", window]);
      sockets.at(-1)?.terminate();

      await readUntil(
        () => browser.connectionState.status,
        (st) => st === "closed",
        "the browser never closed",
      );
      expect(browser.connectionState).toMatchObject({
        status: "closed",
        reason: "refused",
        error: expect.objectContaining({ code: "BRIDGE_REFUSED" }),
      });
      await pastRetryBudget();
      expect(factory.calls()).toBe(2);
      expect(statuses.filter((s) => s === "reconnecting")).toHaveLength(1);
    }, 20_000);
  },
);
