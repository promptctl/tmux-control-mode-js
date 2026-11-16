// The window terminal composed: engine, renderer and size declarer over a
// scripted tmux window (@1, panes %0 and %1, %1 active), with xterm.js mocked
// and the page's effects (frames, the box, cell sizes) driven by the test.
// Asserts what the consumer and the person at the browser see: the DOM the
// panes land in, the size claim tmux receives, where keys go, and what
// dispose leaves behind.

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { layoutString, ZOOMED_0, TWO_PANES } from "../../helpers/layout.js";
import { scriptedTmux, world } from "../../helpers/scripted-window.js";

// One mock Terminal per pane. `open` puts xterm's helper textarea in the pane,
// and `focus` focuses it, so DOM focus moves as it does with the real xterm.
interface MockTerminal {
  element: HTMLElement | undefined;
  focus: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  loadAddon: ReturnType<typeof vi.fn>;
  options: Record<string, unknown>;
}
const terminals: MockTerminal[] = [];
// Every Terminal constructed: the panes' and the options checker's.
const constructed = { count: 0 };

vi.mock("@xterm/xterm", () => {
  class TerminalMock {
    element: HTMLElement | undefined;
    options: Record<string, unknown>;
    private textarea: HTMLTextAreaElement | null = null;
    focus = vi.fn(() => this.textarea?.focus());
    dispose = vi.fn(() => this.element?.remove());
    write = vi.fn();
    resize = vi.fn();
    clear = vi.fn();
    scrollToBottom = vi.fn();
    onData = vi.fn(() => ({ dispose: vi.fn() }));
    onBinary = vi.fn(() => ({ dispose: vi.fn() }));
    loadAddon = vi.fn((addon: { activate(t: unknown): void }) =>
      addon.activate(this),
    );
    // As xterm does: every option has a value, its default where not given,
    // and the setter refuses a cursor style it does not know.
    constructor(opts: Record<string, unknown>) {
      constructed.count += 1;
      this.options = new Proxy(
        {
          lineHeight: 1,
          letterSpacing: 0,
          cursorStyle: "block",
          theme: {},
          linkHandler: null,
          allowProposedApi: false,
          ...opts,
        },
        {
          set(o, key, value) {
            if (
              key === "cursorStyle" &&
              !["block", "underline", "bar"].includes(value as string)
            ) {
              throw new Error(`"${String(value)}" is not a valid value`);
            }
            return Reflect.set(o, key, value);
          },
        },
      );
    }
    // A pane's terminal opens; the terminal's options checker never does.
    open(container: HTMLElement) {
      terminals.push(this as unknown as MockTerminal);
      const el = container.ownerDocument.createElement("div");
      el.className = "xterm";
      const textarea = container.ownerDocument.createElement("textarea");
      textarea.className = "xterm-helper-textarea";
      el.appendChild(textarea);
      container.appendChild(el);
      this.element = el;
      this.textarea = textarea;
    }
  }
  return { Terminal: TerminalMock };
});

import {
  createWindowTerminal,
  type WindowTerminalOptions,
  type WindowTerminalPorts,
} from "../../../src/window-terminal/terminal.js";
import { TmuxCommandError } from "../../../src/browser.js";
import type { Sizing } from "../../../src/window-terminal/options.js";
import type { WindowTerminalError } from "../../../src/window-terminal/engine/window-model.js";

// ResizeObserver the test fires: the box the terminal is given.
let observed: ((width: number, height: number) => void) | null = null;
class FakeResizeObserver {
  constructor(private readonly cb: ResizeObserverCallback) {}
  observe() {
    observed = (width, height) =>
      this.cb(
        [{ contentRect: { width, height } } as ResizeObserverEntry],
        this as unknown as ResizeObserver,
      );
  }
  disconnect() {
    observed = null;
  }
  unobserve() {}
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
}

function mount(
  sizing?: Sizing,
  cellAt: ReturnType<WindowTerminalPorts["measure"]>["cellAt"] = () =>
    (px) => ({
      width: px / 2,
      height: px,
    }),
  given: Pick<WindowTerminalOptions, "xterm" | "addons"> = {},
) {
  const client = scriptedTmux(world());
  client.setConnectionState({ status: "ready" });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const frames: (() => void)[] = [];
  const metrics = new Set<() => void>();
  const measureDispose = vi.fn();
  const ports: WindowTerminalPorts = {
    // A cell is 0.5em by 1em: at 16px, 8 x 16.
    measure: () => ({
      cellAt,
      onChange(cb) {
        metrics.add(cb);
        return () => metrics.delete(cb);
      },
      dispose: measureDispose,
    }),
    frame(cb) {
      frames.push(cb);
      return () => frames.splice(frames.indexOf(cb), 1);
    },
    now: () => 1000,
  };
  const terminal = createWindowTerminal(
    host,
    { connection: client, window: "@1", history: 10, sizing, ...given },
    ports,
  );
  const errors: WindowTerminalError[] = [];
  terminal.onError((e) => errors.push(e));
  const flush = (): void => {
    for (const cb of frames.splice(0)) cb();
  };
  const sizeCommands = () =>
    client.commands().filter((c) => c.startsWith("refresh-client -C"));
  const pane = (id: string) =>
    host.querySelector<HTMLElement>(`[data-pane-id="${id}"]`);
  return {
    client,
    host,
    terminal,
    errors,
    frames,
    flush,
    sizeCommands,
    pane,
    metrics,
    measureDispose,
  };
}

async function live(sizing?: Sizing) {
  const m = mount(sizing);
  await settle();
  observed?.(800, 480);
  m.flush();
  await settle();
  return m;
}

beforeEach(() => {
  terminals.length = 0;
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("window terminal — what is drawn", () => {
  // Pane positions are `calc(n * var(--wt-cell-w))`, which happy-dom drops;
  // they are checked in a browser against the demo.
  it("each pane is an element in layout order, with tmux's active pane marked", async () => {
    const { host, pane, terminal } = await live();
    expect(terminal.state.phase).toBe("live");
    const panes = [...host.querySelectorAll<HTMLElement>(".wt-pane")];
    expect(panes.map((p) => p.dataset.paneId)).toEqual(["%0", "%1"]);
    expect(pane("%0")?.dataset.active).toBe("false");
    expect(pane("%1")?.dataset.active).toBe("true");
    expect(pane("%1")?.dataset.focused).toBe("true");
    expect(pane("%0")?.querySelector(".xterm")).not.toBeNull();
  });

  it("the grid is tmux's cols x rows at the solved cell", async () => {
    const { host } = await live({ window: "tmux", font: 16, fit: "none" });
    const grid = host.querySelector<HTMLElement>(".wt-grid");
    expect(grid?.style.getPropertyValue("--wt-cell-w")).toBe("8px");
    expect(grid?.style.getPropertyValue("--wt-cell-h")).toBe("16px");
    expect(grid?.style.getPropertyValue("--wt-cols")).toBe("80");
    expect(grid?.style.getPropertyValue("--wt-rows")).toBe("24");
    expect(terminals.every((t) => t.options.fontSize === 16)).toBe(true);
  });

  it("a zoom hides the other panes without closing them", async () => {
    const { client, pane, flush } = await live();
    client.injectLayoutChange(1, TWO_PANES, ZOOMED_0, "*Z");
    await settle();
    flush();
    expect(pane("%0")?.hidden).toBe(false);
    expect(pane("%1")?.hidden).toBe(true);
    expect(terminals.some((t) => t.dispose.mock.calls.length > 0)).toBe(false);
  });

  it("a font size change through update re-solves and re-fonts every pane", async () => {
    const { terminal, flush } = await live({
      window: "tmux",
      font: 16,
      fit: "none",
    });
    terminal.update({ sizing: { window: "tmux", font: 12, fit: "none" } });
    flush();
    expect(terminals.map((t) => t.options.fontSize)).toEqual([12, 12]);
  });

  it("xterm options equal to the ones in use, in a new object, leave every xterm alone and construct none", async () => {
    const { terminal, flush } = await live();
    terminal.update({ xterm: { theme: { background: "#000" } } });
    flush();
    const themes = terminals.map((t) => t.options.theme);
    const before = constructed.count;
    terminal.update({
      xterm: { theme: { background: "#000" }, logger: undefined },
    });
    flush();
    expect(constructed.count).toBe(before);
    expect(terminals.map((t) => t.options.theme)).toEqual(themes);
    expect(terminals.every((t, i) => t.options.theme === themes[i])).toBe(true);
    terminal.update({ xterm: { theme: { background: "#111" } } });
    flush();
    expect(terminals.map((t) => t.options.theme)).toEqual([
      { background: "#111" },
      { background: "#111" },
    ]);
  });

  it("the host's xterm options and addons reach every pane, the addons made once per pane", async () => {
    const made: { activate: () => void; dispose: () => void }[] = [];
    const addons = vi.fn(() => {
      const addon = { activate: vi.fn(), dispose: vi.fn() };
      made.push(addon);
      return [addon];
    });
    const m = mount(undefined, undefined, {
      xterm: { cursorStyle: "bar", allowProposedApi: true },
      addons,
    });
    await settle();
    expect(
      terminals.map((t) => [t.options.cursorStyle, t.options.allowProposedApi]),
    ).toEqual([
      ["bar", true],
      ["bar", true],
    ]);
    expect(addons).toHaveBeenCalledTimes(2);
    expect(terminals.map((t) => t.loadAddon.mock.calls)).toEqual([
      [[made[0]]],
      [[made[1]]],
    ]);
    m.terminal.dispose();
  });

  it("a new link handler through update reaches every pane", async () => {
    const { terminal, flush } = await live();
    const first = vi.fn();
    terminal.update({ xterm: { linkHandler: { activate: first } } });
    const second = vi.fn();
    terminal.update({ xterm: { linkHandler: { activate: second } } });
    flush();
    expect(terminals.map((t) => t.options.linkHandler)).toEqual([
      { activate: second },
      { activate: second },
    ]);
  });

  it("a pane that refuses options xterm accepted is reported; the other panes take them", async () => {
    const { terminal, errors } = await live();
    const refused = new Error("an addon refused the theme");
    const plain = terminals[0].options;
    terminals[0].options = new Proxy(plain, {
      set(o, key, value) {
        if (key === "theme") throw refused;
        return Reflect.set(o, key, value);
      },
    });
    terminal.update({ xterm: { theme: { background: "#111" } } });
    expect(errors.map((e) => [e.seam, e.paneId, e.cause])).toEqual([
      ["render", "%0", refused],
    ]);
    expect(terminals[1].options.theme).toEqual({ background: "#111" });
  });

  it("the cell the solver measures is the one xterm draws: family, line height and letter spacing", async () => {
    const fonts: unknown[] = [];
    const m = mount(
      { window: "tmux", font: 16, fit: "none" },
      (font) => {
        fonts.push(font);
        return (px) => ({ width: px / 2, height: px });
      },
      { xterm: { fontFamily: "Iosevka", letterSpacing: 2 } },
    );
    await settle();
    observed?.(800, 480);
    m.flush();
    expect(fonts.at(-1)).toEqual({
      fontFamily: "Iosevka",
      lineHeight: 1,
      letterSpacing: 2,
    });
    m.terminal.dispose();
  });

  it("a pane whose addon throws is reported once and drawn empty; the window's other panes draw", async () => {
    const refused = new Error("proposed API not allowed");
    let calls = 0;
    const addons = () => {
      calls += 1;
      if (calls === 2) throw refused;
      return [];
    };
    const m = mount(undefined, undefined, { addons });
    await settle();
    observed?.(800, 480);
    m.flush();
    // Later window events: neither re-open the pane nor report it again.
    m.client.injectLayoutChange(1, TWO_PANES, ZOOMED_0, "*Z");
    await settle();
    m.client.injectLayoutChange(1, TWO_PANES, TWO_PANES, "*");
    await settle();
    m.flush();
    expect(m.errors.map((e) => [e.seam, e.paneId, e.cause])).toEqual([
      ["render", "%1", refused],
    ]);
    expect(calls).toBe(2);
    expect(m.pane("%0")?.querySelector(".xterm")).not.toBeNull();
    expect(m.pane("%1")).not.toBeNull();
    expect(m.pane("%1")?.querySelector(".xterm")).toBeNull();
    m.terminal.dispose();
  });

  it("an onError listener that disposes the terminal on a pane that failed to open leaves nothing behind", async () => {
    const addons = () => {
      throw new Error("proposed API not allowed");
    };
    const m = mount(undefined, undefined, { addons });
    m.terminal.onError(() => m.terminal.dispose());
    await settle();
    expect(m.errors.map((e) => [e.seam, e.paneId])).toEqual([["render", "%0"]]);
    expect(m.host.querySelector(".wt-root")).toBeNull();
    expect(m.client.held()).toEqual({
      // The connection's reseed scheduler, for as long as it lives.
      listeners: ["reconnected"],
      sinks: 0,
      subscriptions: [],
    });
  });

  it("fonts finishing loading make every pane's xterm measure again", async () => {
    const { metrics, flush } = await live();
    const writes = terminals.map((t) => {
      const seen: unknown[] = [];
      let v = t.options.fontSize;
      Object.defineProperty(t.options, "fontSize", {
        get: () => v,
        set: (next) => {
          seen.push(next);
          v = next;
        },
      });
      return seen;
    });
    for (const cb of metrics) cb();
    flush();
    expect(writes.every((w) => w.length >= 2)).toBe(true);
  });
});

describe("window terminal — the size claim", () => {
  it("the box owns the window: it declares the grid that fits the box", async () => {
    // 800 x 480 at 14px (7 x 14 cells): 114 x 34.
    const { sizeCommands } = await live({ window: "box", font: 14 });
    expect(sizeCommands()).toEqual([
      "refresh-client -C 114x34",
      "refresh-client -C @1:114x34",
    ]);
  });

  it("an onError listener that throws on a refused size does not stop the next size", async () => {
    const thrown: unknown[] = [];
    const microtask = vi
      .spyOn(globalThis, "queueMicrotask")
      .mockImplementation((cb) => {
        try {
          cb();
        } catch (err) {
          thrown.push(err);
        }
      });
    try {
      const m = mount({ window: "box", font: 14 });
      const bug = new Error("host bug");
      m.terminal.onError(() => {
        throw bug;
      });
      m.client.setExecuteFailure((c) =>
        c.startsWith("refresh-client -C @1:114x34")
          ? new TmuxCommandError({
              commandNumber: 1,
              timestamp: 0,
              output: ["size too small or too big"],
              success: false,
            })
          : null,
      );
      await settle();
      observed?.(800, 480);
      m.flush();
      await settle();
      expect(thrown).toContain(bug);
      observed?.(700, 480);
      m.flush();
      await settle();
      expect(m.sizeCommands()).toContain("refresh-client -C @1:100x34");
      m.terminal.dispose();
    } finally {
      microtask.mockRestore();
    }
  });

  it("tmux owns the window: nothing is declared", async () => {
    const { sizeCommands } = await live({
      window: "tmux",
      font: 14,
      fit: "both",
    });
    expect(sizeCommands()).toEqual([]);
  });

  it("while stale, a new box declares nothing; live again, it does", async () => {
    const { client, flush, sizeCommands, terminal } = await live({
      window: "box",
      font: 14,
    });
    client.setConnectionState({ status: "reconnecting", attempt: 1 });
    await settle();
    expect(terminal.state.phase).toBe("stale");
    observed?.(700, 480);
    flush();
    await settle();
    expect(sizeCommands()).toHaveLength(2);
  });

  it("a bad option at mount throws before anything is measured", () => {
    const measure = vi.fn();
    expect(() =>
      createWindowTerminal(
        document.createElement("div"),
        { connection: scriptedTmux(world()), window: "3" as never },
        { measure, frame: () => () => undefined, now: () => 0 },
      ),
    ).toThrow(RangeError);
    expect(measure).not.toHaveBeenCalled();
  });

  it("a bad setting thrown by update changes nothing", async () => {
    const { terminal, flush, sizeCommands } = await live({
      window: "box",
      font: 14,
    });
    expect(() =>
      terminal.update({
        sizing: { window: "box", font: { min: 20, max: 10 } },
        xterm: { fontFamily: "Iosevka" },
      }),
    ).toThrow(RangeError);
    // A value xterm refuses, beside a good one and a good sizing.
    expect(() =>
      terminal.update({
        sizing: { window: "box", font: 30 },
        xterm: { fontFamily: "Iosevka", cursorStyle: "beam" as never },
      }),
    ).toThrow(RangeError);
    observed?.(800, 480);
    flush();
    await settle();
    expect(sizeCommands()).toHaveLength(2);
    expect(terminals.every((t) => t.options.fontFamily !== "Iosevka")).toBe(
      true,
    );
    expect(terminals.every((t) => t.options.fontSize === 14)).toBe(true);
  });

  it("an option the terminal owns is refused at mount", () => {
    const measure = vi.fn();
    expect(() =>
      createWindowTerminal(
        document.createElement("div"),
        {
          connection: scriptedTmux(world()),
          window: "@1",
          xterm: { scrollback: 5 } as never,
        },
        { measure, frame: () => () => undefined, now: () => 0 },
      ),
    ).toThrow(RangeError);
    expect(measure).not.toHaveBeenCalled();
  });
});

describe("window terminal — where keys go", () => {
  it("a frame that fails to draw reaches onError(render), not the page's handler", async () => {
    const unmeasurable = new Error("cell measured 0x0");
    const m = mount(undefined, () => () => {
      throw unmeasurable;
    });
    await settle();
    observed?.(800, 480);
    m.flush();
    expect(m.errors.map((e) => [e.seam, e.cause])).toEqual([
      ["render", unmeasurable],
    ]);
    m.terminal.dispose();
  });

  it("focus entering a pane makes it this browser's focus; tmux's active pane does not move", async () => {
    const { client, pane, terminal } = await live();
    pane("%0")?.querySelector("textarea")?.focus();
    const state = terminal.state;
    expect(state.phase === "live" && state.window.focus).toBe("%0");
    expect(state.phase === "live" && state.window.active).toBe("%1");
    expect(client.commands().some((c) => c.startsWith("select-pane"))).toBe(
      false,
    );
  });

  it("focus(pane) puts the keyboard in that pane", async () => {
    const { pane, terminal } = await live();
    terminal.focus("%0");
    expect(pane("%0")?.contains(document.activeElement)).toBe(true);
    const state = terminal.state;
    expect(state.phase === "live" && state.window.focus).toBe("%0");
  });

  it("focus refuses an id that is not a pane id", async () => {
    const { terminal } = await live();
    expect(() => terminal.focus("@0" as never)).toThrow(RangeError);
  });

  it("a zoom onto another pane moves the keyboard there, when it was in the terminal", async () => {
    const { client, pane, terminal, flush } = await live();
    terminal.focus("%1");
    client.injectLayoutChange(1, TWO_PANES, ZOOMED_0, "*Z");
    await settle();
    flush();
    expect(pane("%0")?.contains(document.activeElement)).toBe(true);
  });

  it("a swap that reorders the panes keeps the keyboard in its pane", async () => {
    const { client, pane, terminal, flush } = await live();
    terminal.focus("%1");
    // swap-pane: %1 now left, %0 right, so %1's element moves before %0's.
    const swapped = layoutString("80x24,0,0{40x24,0,0,1,39x24,41,0,0}");
    client.injectLayoutChange(1, swapped, swapped, "*");
    await settle();
    flush();
    expect(pane("%1")?.contains(document.activeElement)).toBe(true);
  });

  it("the plan never takes the keyboard from the rest of the page", async () => {
    const { client, flush } = await live();
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    client.injectLayoutChange(1, TWO_PANES, ZOOMED_0, "*Z");
    await settle();
    flush();
    expect(document.activeElement).toBe(input);
  });
});

describe("window terminal — dispose", () => {
  it("removes its DOM, releases the declared size, and stops scheduling", async () => {
    const { host, terminal, frames, sizeCommands, measureDispose } = await live(
      { window: "box", font: 14 },
    );
    observed?.(900, 480);
    expect(frames).toHaveLength(1);
    terminal.dispose();
    expect(frames).toHaveLength(0);
    expect(host.children).toHaveLength(0);
    expect(terminals.every((t) => t.dispose.mock.calls.length === 1)).toBe(
      true,
    );
    expect(measureDispose).toHaveBeenCalledOnce();
    await settle();
    expect(sizeCommands().at(-1)).toBe("refresh-client -C @1:");
    expect(observed).toBeNull();
  });
});
