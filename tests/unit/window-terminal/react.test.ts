// `<WindowTerminal>` maps React's lifecycle onto `mountWindowTerminal`:
// identity (connection, window, history) mounts a terminal, each setting
// (sizing, xterm) updates it alone, the addons are read at mount, and the
// callbacks and ref follow the latest render without remounting.

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, StrictMode, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type {
  WindowTerminal as Terminal,
  WindowTerminalOptions,
} from "../../../src/window-terminal/terminal.js";
import type { WindowTerminalState } from "../../../src/window-terminal/engine/window-model.js";

interface Mounted {
  readonly options: WindowTerminalOptions;
  readonly element: HTMLElement;
  readonly updates: unknown[];
  disposed: boolean;
  emit(state: WindowTerminalState): void;
  readonly terminal: Terminal;
}
const mounted: Mounted[] = [];

vi.mock("../../../src/window-terminal/index.js", () => ({
  mountWindowTerminal(element: HTMLElement, options: WindowTerminalOptions) {
    const listeners = new Set<(s: WindowTerminalState) => void>();
    const m: Mounted = {
      options,
      element,
      updates: [],
      disposed: false,
      emit: (s) => {
        for (const cb of listeners) cb(s);
      },
      terminal: {
        update: (settings) => m.updates.push(settings),
        state: { phase: "connecting" },
        onState(cb) {
          listeners.add(cb);
          cb({ phase: "connecting" });
          return () => listeners.delete(cb);
        },
        onError: () => () => undefined,
        focus: () => undefined,
        dispose: () => {
          m.disposed = true;
        },
      },
    };
    mounted.push(m);
    return m.terminal;
  },
}));

import { WindowTerminal } from "../../../src/window-terminal/react/index.js";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const CONN_A = { name: "a" } as unknown as WindowTerminalOptions["connection"];
const CONN_B = { name: "b" } as unknown as WindowTerminalOptions["connection"];
const BOX = { window: "box", font: 14 } as const;
const ADDONS = () => [];

let root: Root;
let container: HTMLElement;

function render(el: ReactElement): void {
  act(() => root.render(el));
}

beforeEach(() => {
  mounted.length = 0;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

describe("<WindowTerminal>", () => {
  it("mounts one terminal into its own element, with the identity and settings it was given", () => {
    render(
      createElement(WindowTerminal, {
        connection: CONN_A,
        window: "@1",
        history: 50,
        sizing: BOX,
        xterm: { fontFamily: "Iosevka" },
        addons: ADDONS,
        className: "term",
      }),
    );
    expect(mounted).toHaveLength(1);
    expect(mounted[0].element.className).toBe("term");
    expect(mounted[0].options).toEqual({
      connection: CONN_A,
      window: "@1",
      history: 50,
      sizing: BOX,
      xterm: { fontFamily: "Iosevka" },
      addons: ADDONS,
    });
  });

  it("the addons are the ones at mount; a new factory neither remounts nor updates", () => {
    render(
      createElement(WindowTerminal, {
        connection: CONN_A,
        window: "@1",
        addons: ADDONS,
      }),
    );
    const count = mounted[0].updates.length;
    render(
      createElement(WindowTerminal, {
        connection: CONN_A,
        window: "@1",
        addons: () => [],
      }),
    );
    expect(mounted).toHaveLength(1);
    expect(mounted[0].options.addons).toBe(ADDONS);
    expect(mounted[0].updates).toHaveLength(count);
  });

  it("a new value for one setting updates only that one; one taken away returns to its default", () => {
    const sizing = { window: "tmux", font: 12, fit: "none" } as const;
    render(
      createElement(WindowTerminal, {
        connection: CONN_A,
        window: "@1",
        sizing,
        xterm: { cursorStyle: "bar" },
      }),
    );
    const count = mounted[0].updates.length;
    // A new xterm object: the sizing (perhaps set through the ref) is left be.
    render(
      createElement(WindowTerminal, {
        connection: CONN_A,
        window: "@1",
        sizing,
        xterm: { cursorStyle: "underline" },
      }),
    );
    expect(mounted[0].updates.slice(count)).toEqual([
      { xterm: { cursorStyle: "underline" } },
    ]);
    render(createElement(WindowTerminal, { connection: CONN_A, window: "@1" }));
    expect(mounted).toHaveLength(1);
    expect(mounted[0].updates.slice(count + 1)).toEqual([
      { sizing: BOX },
      { xterm: {} },
    ]);
  });

  it("a new connection or window is a new terminal; the old one is disposed", () => {
    render(createElement(WindowTerminal, { connection: CONN_A, window: "@1" }));
    render(createElement(WindowTerminal, { connection: CONN_B, window: "@1" }));
    render(createElement(WindowTerminal, { connection: CONN_B, window: "@2" }));
    expect(mounted.map((m) => [m.options.window, m.disposed])).toEqual([
      ["@1", true],
      ["@1", true],
      ["@2", false],
    ]);
  });

  it("new settings update the same terminal; a re-render with the same ones does nothing", () => {
    render(
      createElement(WindowTerminal, {
        connection: CONN_A,
        window: "@1",
        sizing: BOX,
      }),
    );
    const next = { window: "tmux", font: 12, fit: "none" } as const;
    render(
      createElement(WindowTerminal, {
        connection: CONN_A,
        window: "@1",
        sizing: next,
      }),
    );
    render(
      createElement(WindowTerminal, {
        connection: CONN_A,
        window: "@1",
        sizing: next,
      }),
    );
    expect(mounted).toHaveLength(1);
    expect(mounted[0].updates.at(-1)).toEqual({ sizing: next });
    const count = mounted[0].updates.length;
    render(
      createElement(WindowTerminal, {
        connection: CONN_A,
        window: "@1",
        sizing: next,
      }),
    );
    expect(mounted[0].updates).toHaveLength(count);
  });

  it("onState gets the current state first, then changes, through the latest callback without remounting", () => {
    const first: string[] = [];
    const second: string[] = [];
    render(
      createElement(WindowTerminal, {
        connection: CONN_A,
        window: "@1",
        onState: (s) => first.push(s.phase),
      }),
    );
    render(
      createElement(WindowTerminal, {
        connection: CONN_A,
        window: "@1",
        onState: (s) => second.push(s.phase),
      }),
    );
    act(() => mounted[0].emit({ phase: "gone", reason: "connection-closed" }));
    expect(mounted).toHaveLength(1);
    expect(first).toEqual(["connecting"]);
    expect(second).toEqual(["gone"]);
  });

  it("the ref is the mounted terminal, and null once unmounted", () => {
    const seen: (Terminal | null)[] = [];
    render(
      createElement(WindowTerminal, {
        connection: CONN_A,
        window: "@1",
        ref: (t: Terminal | null) => seen.push(t),
      }),
    );
    act(() => root.unmount());
    root = createRoot(container);
    expect(seen).toEqual([mounted[0].terminal, null]);
    expect(mounted[0].disposed).toBe(true);
  });

  it("a different ref gets the terminal and the old one is cleared, without remounting", () => {
    const a = { current: null as Terminal | null };
    const b = { current: null as Terminal | null };
    const props = { connection: CONN_A, window: "@1" as const };
    render(createElement(WindowTerminal, { ...props, ref: a }));
    render(createElement(WindowTerminal, { ...props, ref: b }));
    expect(mounted).toHaveLength(1);
    expect(a.current).toBeNull();
    expect(b.current).toBe(mounted[0].terminal);
    act(() => root.unmount());
    root = createRoot(container);
    expect(b.current).toBeNull();
  });

  it("under StrictMode, the extra mount is disposed and exactly one terminal stays", () => {
    render(
      createElement(
        StrictMode,
        null,
        createElement(WindowTerminal, { connection: CONN_A, window: "@1" }),
      ),
    );
    expect(mounted.filter((m) => !m.disposed)).toHaveLength(1);
  });
});
