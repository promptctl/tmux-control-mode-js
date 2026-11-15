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
  pollUntil,
  tmux,
  uniqueName,
  uniqueSocket,
} from "../helpers/integration.js";
import type { TmuxClient } from "../../src/client.js";
import { clearWindowSize, setWindowSize } from "../../src/commands/index.js";
import { createWebSocketBridge } from "../../src/connectors/websocket/server.js";
import { WebSocketTmuxClient } from "../../src/connectors/websocket/client.js";
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
  readonly keys: Map<PaneId, (data: string) => void>;
  readonly disposed: PaneId[];
}

function recorder(): Recorder {
  const sinks = new Map<PaneId, BufferingSink>();
  const keys = new Map<PaneId, (data: string) => void>();
  const disposed: PaneId[] = [];
  return {
    sinks,
    keys,
    disposed,
    create(pane, send) {
      const sink = new BufferingSink();
      sinks.set(pane, sink);
      keys.set(pane, send);
      return {
        sink,
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
  await pollUntil(() => {
    const v = liveView(engine.state);
    return v !== null && pred(v);
  });
  return liveView(engine.state) as WindowView;
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
    await pollUntil(() => (s.sinks.get(added)?.seedCalls.length ?? 0) === 1);

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
    await pollUntil(() => s.sinks.get(added)?.resizeCalls.at(-1)?.cols === 30);
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
    await pollUntil(
      () =>
        q(socket, ["display-message", "-p", "-t", dead, "#{pane_dead}"]) ===
        "1",
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

    s.keys.get(first as PaneId)?.("WT_KEYS_MARK");
    const captured = (pane: string) =>
      q(socket, ["capture-pane", "-p", "-t", pane]);
    await pollUntil(() => captured(first).includes("WT_KEYS_MARK"));
    expect(captured(active)).not.toContain("WT_KEYS_MARK");
    expect(
      q(socket, ["display-message", "-p", "-t", window, "#{pane_id}"]),
    ).toBe(active);
  });

  it("kill-window is gone(window-closed)", async () => {
    const { c, window } = await start();
    q(socket, ["new-window", "-d", "cat"]);
    engine = engineOver(c, window, recorder());
    await untilLive(engine);
    q(socket, ["kill-window", "-t", window]);
    await pollUntil(() => engine?.state.phase === "gone");
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
    await pollUntil(() => engine?.state.phase === "gone");
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
    await setWindowSize(c, Number(a.slice(1)), 100, 30);
    await pollUntil(() => size(a) === "100x30");
    await visit(b);
    expect(size(b)).toBe("80x24");
    await clearWindowSize(c, Number(a.slice(1)));
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
    await pollUntil(() => size(a) === "110x35");
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

      const bridge = createWebSocketBridge({ createClient: () => tmuxClient });
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

      let lastWs: WsClient | null = null;
      const browser = new WebSocketTmuxClient({
        url: `ws://127.0.0.1:${port}/tmux`,
        createWebSocket: (u) => {
          lastWs = new WsClient(u);
          return lastWs as unknown as BrowserWebSocketLike;
        },
        reconnect: {
          maxAttempts: 5,
          initialDelayMs: 25,
          maxDelayMs: 50,
          factor: 1,
          jitterMs: 0,
        },
        heartbeatIntervalMs: 0,
      });
      teardown.push(() => browser.close());

      const s = recorder();
      const engine = engineOver(browser, window, s);
      teardown.push(() => engine.dispose());
      await untilLive(engine, (v) => v.panes.length === 2);
      await pollUntil(() =>
        [...s.sinks.values()].every((sink) => sink.seedCalls.length === 1),
      );
      const before = await untilLive(engine, (v) =>
        v.panes.every((p) => !p.resyncing),
      );

      (lastWs as unknown as WsClient).terminate();
      await pollUntil(() => engine.state.phase === "stale");
      expect(engine.state).toMatchObject({ phase: "stale", window: before });

      await untilLive(engine);
      await pollUntil(() =>
        [...s.sinks.values()].every((sink) => sink.seedCalls.length === 2),
      );
      await new Promise((r) => setTimeout(r, 300));
      expect(
        [...s.sinks.values()].map((sink) => sink.seedCalls.length),
      ).toEqual([2, 2]);
      expect(s.sinks.size).toBe(2);
    }, 20_000);
  },
);
