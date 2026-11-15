import { describe, expect, it } from "vitest";
import {
  NullSink,
  scriptedTmux,
  world,
  type World,
} from "../../helpers/scripted-window.js";
import {
  ONE_PANE,
  THREE_PANES,
  TWO_PANES,
  ZOOMED_0,
} from "../../helpers/layout.js";
import {
  TmuxCommandError,
  TransportClosedError,
} from "../../../src/browser.js";
import {
  WindowEngine,
  type PaneSurfaces,
} from "../../../src/window-terminal/engine/window-engine.js";
import type {
  WindowTerminalError,
  WindowTerminalState,
} from "../../../src/window-terminal/engine/window-model.js";
import type { PaneId } from "../../../src/window-terminal/ids.js";

interface Surfaces extends PaneSurfaces {
  readonly live: Map<PaneId, (data: string) => void>;
  readonly created: PaneId[];
  readonly disposed: PaneId[];
}

function surfaces(): Surfaces {
  const live = new Map<PaneId, (data: string) => void>();
  const created: PaneId[] = [];
  const disposed: PaneId[] = [];
  return {
    live,
    created,
    disposed,
    create(pane, keys) {
      created.push(pane);
      live.set(pane, keys);
      return {
        sink: new NullSink(),
        dispose() {
          disposed.push(pane);
          live.delete(pane);
        },
      };
    },
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
}

function mount(w: World = world(), ready = true) {
  const client = scriptedTmux(w);
  if (ready) client.setConnectionState({ status: "ready" });
  const s = surfaces();
  let t = 100;
  const engine = new WindowEngine({
    connection: client,
    windowId: "@1",
    history: 50,
    surfaces: s,
    now: () => t,
  });
  const states: WindowTerminalState[] = [];
  const errors: WindowTerminalError[] = [];
  engine.onState((st) => states.push(st));
  engine.onError((e) => errors.push(e));
  return {
    client,
    s,
    engine,
    states,
    errors,
    tick: (ms: number) => {
      t += ms;
    },
  };
}

function live(state: WindowTerminalState) {
  if (state.phase !== "live") throw new Error(`not live: ${state.phase}`);
  return state.window;
}

describe("WindowEngine — arrival", () => {
  it("bootstraps a ready connection into a live view with every pane, and a surface and seed per pane", async () => {
    const { client, s, engine } = mount();
    expect(engine.state).toEqual({ phase: "connecting" });
    await settle();
    const view = live(engine.state);
    expect(view.id).toBe("@1");
    expect(view.name).toBe("editor");
    expect(view.active).toBe("%1");
    expect(view.focus).toBe("%1");
    expect(view.panes.map((p) => [p.id, p.title, p.rect])).toEqual([
      ["%0", "left", { x: 0, y: 0, cols: 40, rows: 24 }],
      ["%1", "right", { x: 41, y: 0, cols: 39, rows: 24 }],
    ]);
    expect(s.created).toEqual(["%0", "%1"]);
    const captures = client
      .commands()
      .filter((c) => c.startsWith("capture-pane"));
    expect(captures).toEqual([
      "capture-pane -peqN -S -50 -t %0",
      "capture-pane -peqN -S -50 -t %1",
    ]);
    expect(client.subscriptionNamed("@1")).toMatch(/^wt-.*-flags-@1$/);
    expect(client.subscriptionNamed("%*")).toMatch(/^wt-.*-panes-@1$/);
    engine.dispose();
  });

  it("waits in connecting for the connection, then bootstraps when it is ready", async () => {
    const { client, engine } = mount(world(), false);
    await settle();
    expect(engine.state.phase).toBe("connecting");
    expect(client.commands()).toEqual([]);
    client.setConnectionState({ status: "ready" });
    await settle();
    expect(engine.state.phase).toBe("live");
    engine.dispose();
  });

  it("onState calls back with the current state first and returns an unsubscribe", async () => {
    const { engine } = mount();
    await settle();
    const seen: string[] = [];
    const off = engine.onState((st) => seen.push(st.phase));
    expect(seen).toEqual(["live"]);
    off();
    engine.dispose();
  });

  it("replays the window events that arrive while it bootstraps", async () => {
    const { client, engine } = mount();
    client.injectLayoutChange(1, THREE_PANES, THREE_PANES, "*");
    await settle();
    expect(live(engine.state).panes.map((p) => p.id)).toEqual([
      "%0",
      "%1",
      "%2",
    ]);
    engine.dispose();
  });

  it("two engines use their own subscription names", async () => {
    const client = scriptedTmux(world());
    client.setConnectionState({ status: "ready" });
    const a = new WindowEngine({
      connection: client,
      windowId: "@1",
      history: 0,
      surfaces: surfaces(),
      now: () => 0,
    });
    await settle();
    const nameA = client.subscriptionNamed("@1");
    const b = new WindowEngine({
      connection: client,
      windowId: "@1",
      history: 0,
      surfaces: surfaces(),
      now: () => 0,
    });
    await settle();
    expect(client.subscriptionNamed("@1")).not.toBe(nameA);
    a.dispose();
    b.dispose();
  });

  it("a window outside the attached session is gone(window-unreachable), with nothing subscribed", async () => {
    const { client, engine, s } = mount(
      world({ attached: ["@2"], all: ["@1", "@2"] }),
    );
    await settle();
    expect(engine.state).toEqual({
      phase: "gone",
      reason: "window-unreachable",
    });
    expect(
      client.commands().some((c) => c.startsWith("refresh-client -B")),
    ).toBe(false);
    expect(s.created).toEqual([]);
  });

  it("a window that does not exist is gone(window-closed)", async () => {
    const { engine } = mount(world({ attached: ["@2"], all: ["@2"] }));
    await settle();
    expect(engine.state).toEqual({ phase: "gone", reason: "window-closed" });
  });

  it("a bootstrap tmux refuses reaches onError(bootstrap)", async () => {
    const client = scriptedTmux(world());
    client.setExecuteFailure((cmd) =>
      cmd.startsWith("display-message -p -t @1")
        ? new TmuxCommandError({
            commandNumber: 1,
            timestamp: 0,
            output: ["can't find window"],
            success: false,
          })
        : null,
    );
    client.setConnectionState({ status: "ready" });
    const errors: WindowTerminalError[] = [];
    const engine = new WindowEngine({
      connection: client,
      windowId: "@1",
      history: 0,
      surfaces: surfaces(),
      now: () => 0,
    });
    engine.onError((e) => errors.push(e));
    await settle();
    expect(errors.map((e) => [e.seam, e.windowId])).toEqual([
      ["bootstrap", "@1"],
    ]);
    expect(engine.state.phase).toBe("connecting");
    engine.dispose();
  });

  it("disposed before any reply, it issues nothing more", async () => {
    const { client, engine, s } = mount();
    engine.dispose();
    await settle();
    expect(client.commands()).toEqual([
      "list-windows -F '#{window_id}'",
      "list-windows -a -F '#{window_id}'",
    ]);
    expect(s.created).toEqual([]);
  });
});

describe("WindowEngine — following the window", () => {
  it("a split adds a pane with its own stream; a close removes it", async () => {
    const { client, engine, s } = mount();
    await settle();
    client.injectLayoutChange(1, THREE_PANES, THREE_PANES, "*");
    expect(live(engine.state).panes.map((p) => p.id)).toEqual([
      "%0",
      "%1",
      "%2",
    ]);
    expect(s.created).toEqual(["%0", "%1", "%2"]);
    await settle();
    expect(client.commands()).toContain("capture-pane -peqN -S -50 -t %2");

    client.injectLayoutChange(1, ONE_PANE, ONE_PANE, "*");
    expect(live(engine.state).panes.map((p) => p.id)).toEqual(["%0"]);
    expect(s.disposed).toEqual(["%1", "%2"]);
    engine.dispose();
  });

  it("zoom hides without removing; unzoom shows them again", async () => {
    const { client, engine, s } = mount();
    await settle();
    client.injectLayoutChange(1, TWO_PANES, ZOOMED_0, "*Z");
    const zoomed = live(engine.state);
    expect(zoomed.zoomed).toBe("%0");
    expect(zoomed.focus).toBe("%0");
    expect(s.disposed).toEqual([]);
    client.injectLayoutChange(1, TWO_PANES, TWO_PANES, "*");
    expect(live(engine.state).zoomed).toBeNull();
    engine.dispose();
  });

  it("ignores another window's events", async () => {
    const { client, engine } = mount();
    await settle();
    client.injectLayoutChange(2, ONE_PANE, ONE_PANE, "*");
    client.injectNotification({
      type: "window-renamed",
      windowId: 2,
      name: "x",
    });
    expect(live(engine.state).panes).toHaveLength(2);
    expect(live(engine.state).name).toBe("editor");
    engine.dispose();
  });

  it("follows the active pane, the name (UTF-8), the flags and pane titles", async () => {
    const { client, engine } = mount();
    await settle();
    client.injectNotification({
      type: "window-pane-changed",
      windowId: 1,
      paneId: 0,
    });
    client.injectNotification({
      type: "window-renamed",
      windowId: 1,
      name: "cafÃ©",
    });
    client.injectSubscriptionChanged(
      client.subscriptionNamed("@1"),
      -1,
      "101",
      {
        windowId: 1,
      },
    );
    client.injectSubscriptionChanged(
      client.subscriptionNamed("%*"),
      1,
      "build\tmake",
      {
        windowId: 1,
      },
    );
    client.injectSubscriptionChanged(
      client.subscriptionNamed("%*"),
      9,
      "other\tzsh",
      {
        windowId: 2,
      },
    );
    const view = live(engine.state);
    expect(view.active).toBe("%0");
    expect(view.name).toBe("café");
    expect(view.flags).toEqual({ bell: true, activity: false, silence: true });
    expect(view.panes[1]).toMatchObject({ title: "build", command: "make" });
    engine.dispose();
  });

  it("a malformed layout reaches onError(layout) and leaves the view", async () => {
    const { client, engine, errors } = mount();
    await settle();
    client.injectLayoutChange(1, "0000,80x24", "0000,80x24", "*");
    expect(errors.map((e) => e.seam)).toEqual(["layout"]);
    expect(live(engine.state).panes).toHaveLength(2);
    engine.dispose();
  });

  it("a window-close re-reads membership: a closed window is gone, every pane disposed, subscriptions ended", async () => {
    const w = world();
    const { client, engine, s } = mount(w);
    await settle();
    const names = [
      client.subscriptionNamed("@1"),
      client.subscriptionNamed("%*"),
    ];
    w.attached = [];
    w.all = ["@2"];
    client.injectNotification({ type: "window-close", windowId: 1 });
    await settle();
    expect(engine.state).toEqual({ phase: "gone", reason: "window-closed" });
    expect(s.disposed).toEqual(["%0", "%1"]);
    for (const n of names) {
      expect(client.commands()).toContain(`refresh-client -B '${n}'`);
    }
  });

  it("a window unlinked from this session is gone(window-unreachable)", async () => {
    const w = world();
    const { client, engine } = mount(w);
    await settle();
    w.attached = [];
    client.injectNotification({ type: "unlinked-window-close", windowId: 1 });
    await settle();
    expect(engine.state).toEqual({
      phase: "gone",
      reason: "window-unreachable",
    });
  });

  it("switching the attached session re-reads membership", async () => {
    const w = world();
    const { client, engine } = mount(w);
    await settle();
    w.attached = ["@2"];
    client.injectNotification({
      type: "session-changed",
      sessionId: 2,
      name: "other",
    });
    await settle();
    expect(engine.state).toEqual({
      phase: "gone",
      reason: "window-unreachable",
    });
  });
});

describe("WindowEngine — keys and focus", () => {
  it("keys typed into a pane's surface go to that pane only, and nothing selects a pane", async () => {
    const { client, engine, s } = mount();
    await settle();
    s.live.get("%0")?.("ls\r");
    await settle();
    const sends = client.commands().filter((c) => c.startsWith("send-keys"));
    expect(sends).toEqual(["send-keys -H -t '%0' 6c 73 0d"]);
    expect(client.commands().some((c) => /select-pane/.test(c))).toBe(false);
    expect(live(engine.state).active).toBe("%1");
    engine.dispose();
  });

  it("send-keys tmux refuses reaches onError(send-keys) with the pane; a lost connection does not", async () => {
    const { client, engine, s, errors } = mount();
    await settle();
    client.setExecuteFailure((cmd) =>
      cmd.startsWith("send-keys -H -t '%0'")
        ? new TmuxCommandError({
            commandNumber: 1,
            timestamp: 0,
            output: ["no pane"],
            success: false,
          })
        : cmd.startsWith("send-keys -H -t '%1'")
          ? new TransportClosedError("gone")
          : null,
    );
    s.live.get("%0")?.("a");
    s.live.get("%1")?.("b");
    await settle();
    expect(errors.map((e) => [e.seam, e.paneId])).toEqual([
      ["send-keys", "%0"],
    ]);
    engine.dispose();
  });

  it("focus() pins this browser's focus; tmux's active pane moving does not move it", async () => {
    const { client, engine } = mount();
    await settle();
    engine.focus("%0");
    expect(live(engine.state).focus).toBe("%0");
    client.injectNotification({
      type: "window-pane-changed",
      windowId: 1,
      paneId: 1,
    });
    expect(live(engine.state).focus).toBe("%0");
    expect(() => engine.focus("%9")).toThrow(RangeError);
    engine.dispose();
  });
});

describe("WindowEngine — the connection", () => {
  it("reconnecting is stale with the last picture; ready again re-bootstraps to live, keeping the panes", async () => {
    const { client, engine, s, tick } = mount();
    await settle();
    const before = live(engine.state);
    client.setConnectionState({ status: "reconnecting", attempt: 1 });
    expect(engine.state).toEqual({
      phase: "stale",
      window: before,
      since: 100,
      reason: "reconnecting (attempt 1)",
    });
    tick(50);
    client.setConnectionState({ status: "connecting" });
    expect(engine.state).toMatchObject({ phase: "stale", since: 100 });
    const bootstraps = () =>
      client.commands().filter((c) => c.startsWith("display-message -p -t @1"))
        .length;
    expect(bootstraps()).toBe(1);
    client.setConnectionState({ status: "ready" });
    await settle();
    expect(engine.state.phase).toBe("live");
    expect(bootstraps()).toBe(2);
    expect(s.created).toEqual(["%0", "%1"]);
    expect(s.disposed).toEqual([]);
    engine.dispose();
  });

  it("a panes's flood shows as resyncing until it is reseeded", async () => {
    const { client, engine } = mount();
    await settle();
    client.injectNotification({ type: "pause", paneId: 1 });
    expect(live(engine.state).panes.map((p) => p.resyncing)).toEqual([
      false,
      true,
    ]);
    client.injectNotification({ type: "continue", paneId: 1 });
    await settle();
    expect(live(engine.state).panes.map((p) => p.resyncing)).toEqual([
      false,
      false,
    ]);
    engine.dispose();
  });

  it("closed is gone(connection-closed) and tears down every pane", async () => {
    const { client, engine, s } = mount();
    await settle();
    client.setConnectionState({ status: "closed", reason: "exit" });
    expect(engine.state).toEqual({
      phase: "gone",
      reason: "connection-closed",
      detail: "exit",
    });
    expect(s.disposed).toEqual(["%0", "%1"]);
  });

  it("dispose ends every pane and the window subscriptions", async () => {
    const { client, engine, s } = mount();
    await settle();
    const names = [
      client.subscriptionNamed("@1"),
      client.subscriptionNamed("%*"),
    ];
    engine.dispose();
    expect(s.disposed).toEqual(["%0", "%1"]);
    for (const n of names) {
      expect(client.commands()).toContain(`refresh-client -B '${n}'`);
    }
    await settle();
  });
});
