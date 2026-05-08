// packages/pane-terminal/tests/unit/xterm-sink-resize-storm.test.ts
//
// O9 verification: 100 ResizeObserver entries dispatched in one tick must
// coalesce into AT MOST ONE xterm-side mutation per rAF flush. The intent
// is that container churn (window resize, panel drag, devtools open/close)
// never multiplies xterm work — the rAF is the rate limiter.
//
// happy-dom does not deliver real ResizeObserver entries on layout changes
// (it has no layout engine). We invoke XtermSink's container-resize callback
// directly — the unit-of-work being tested is "100 callbacks → 1 rAF flush
// → 1 xterm option write," not "ResizeObserver fires 100 times in browsers
// (it doesn't anyway, ResizeObserver coalesces upstream too)."
//
// [LAW:behavior-not-structure] The test asserts call counts against the
//   mocked Terminal — it does not poke at XtermSink's private rAF state.

// @vitest-environment happy-dom

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

interface MockTerminal {
  options: { fontSize: number; theme: object; [k: string]: unknown };
  open: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  onData: ReturnType<typeof vi.fn>;
}

let lastTerm: MockTerminal | null = null;
let resizeCallback: ResizeObserverCallback | null = null;

vi.mock("@xterm/xterm", () => {
  class TerminalMock {
    options: { fontSize: number; theme: object; [k: string]: unknown };
    open = vi.fn<(el: HTMLElement) => void>();
    write = vi.fn<(d: string | Uint8Array) => void>();
    resize = vi.fn<(c: number, r: number) => void>();
    clear = vi.fn<() => void>();
    dispose = vi.fn<() => void>();
    focus = vi.fn<() => void>();
    onData = vi.fn(() => ({ dispose: vi.fn() }));
    constructor(opts: { fontSize?: number; theme?: object } = {}) {
      this.options = {
        fontSize: opts.fontSize ?? 14,
        theme: opts.theme ?? {},
      };
      lastTerm = this as unknown as MockTerminal;
    }
  }
  return { Terminal: TerminalMock };
});

import { XtermSink } from "../../src/xterm-sink/index.js";
import { __resetCache } from "../../src/xterm-sink/font-cache.js";

// Stub ResizeObserver so we can capture the callback and dispatch entries
// at will. happy-dom ships a noop ResizeObserver; we replace it for the
// duration of these tests.
const realRO = globalThis.ResizeObserver;

class StubResizeObserver implements ResizeObserver {
  constructor(cb: ResizeObserverCallback) {
    resizeCallback = cb;
  }
  observe(): void {
    /* recorded via the captured callback above */
  }
  unobserve(): void {
    /* noop */
  }
  disconnect(): void {
    /* noop */
  }
}

// rAF stub — same pattern as xterm-sink.test.ts.
let rafQueue: Array<() => void> = [];
const realRaf = globalThis.requestAnimationFrame;
const realCaf = globalThis.cancelAnimationFrame;
function installFakeRaf(): void {
  rafQueue = [];
  globalThis.requestAnimationFrame = ((cb: () => void) => {
    rafQueue.push(cb);
    return rafQueue.length as unknown as number;
  }) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = vi.fn();
}
function flushRaf(): void {
  const q = rafQueue;
  rafQueue = [];
  for (const cb of q) cb();
}

beforeEach(() => {
  __resetCache();
  lastTerm = null;
  resizeCallback = null;
  globalThis.ResizeObserver =
    StubResizeObserver as unknown as typeof ResizeObserver;
  installFakeRaf();
});

afterEach(() => {
  globalThis.ResizeObserver = realRO;
  globalThis.requestAnimationFrame = realRaf;
  globalThis.cancelAnimationFrame = realCaf;
  document.body.innerHTML = "";
});

function makeContainer(): HTMLElement {
  const el = document.createElement("div");
  document.body.appendChild(el);
  return el;
}

function fakeEntries(width: number, height: number): ResizeObserverEntry[] {
  return [
    {
      contentRect: {
        width,
        height,
        top: 0,
        left: 0,
        bottom: height,
        right: width,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      },
    } as unknown as ResizeObserverEntry,
  ];
}

describe("XtermSink: resize storm coalescing (O9)", () => {
  it("100 ResizeObserver callbacks within one tick → at most one rAF flush", () => {
    const container = makeContainer();
    const sink = new XtermSink({ container });
    if (lastTerm === null) throw new Error("Terminal mock not constructed");
    if (resizeCallback === null)
      throw new Error("ResizeObserver not registered");
    const term = lastTerm;
    const cb = resizeCallback;

    // Tmux-side dimensions so fitFont has something to compute against.
    sink.resize(80, 24);
    flushRaf(); // first-resize rAF
    expect(term.resize).toHaveBeenCalledTimes(1);

    const beforeFontSizeWrites = term.options.fontSize;
    let fontSizeWrites = 0;
    let backing = beforeFontSizeWrites;
    Object.defineProperty(term.options, "fontSize", {
      configurable: true,
      get: () => backing,
      set: (v) => {
        fontSizeWrites += 1;
        backing = v as number;
      },
    });

    // Storm: 100 callbacks, each with the same final box (typical of a
    // window resize where intermediate frames hit the observer at 60Hz).
    for (let i = 0; i < 100; i++) {
      cb(fakeEntries(800 + i, 240), {} as ResizeObserver);
    }
    // Pre-flush: zero xterm mutations regardless of how many callbacks fired.
    expect(fontSizeWrites).toBe(0);
    // Pre-flush: rAF queue holds one entry — coalescing happened upstream.
    expect(rafQueue.length).toBe(1);

    flushRaf();
    // Post-flush: at most one font-size write. Could be zero if the chosen
    // font size happens to equal the constructor default (16px DEFAULT_MAX
    // matches our 14px default, so the answer at containerW≈900 is ≥ 16,
    // clamped — could match the current value). The contract is "AT MOST 1",
    // not "exactly 1".
    expect(fontSizeWrites).toBeLessThanOrEqual(1);

    sink.dispose();
  });

  it("disposed sink does not flush a queued rAF after disposal", () => {
    const container = makeContainer();
    const sink = new XtermSink({ container });
    if (lastTerm === null) throw new Error("Terminal mock not constructed");
    if (resizeCallback === null)
      throw new Error("ResizeObserver not registered");
    const term = lastTerm;
    const cb = resizeCallback;

    sink.resize(80, 24);
    flushRaf();
    expect(term.resize).toHaveBeenCalledTimes(1);

    let fontSizeWrites = 0;
    let backing = term.options.fontSize;
    Object.defineProperty(term.options, "fontSize", {
      configurable: true,
      get: () => backing,
      set: (v) => {
        fontSizeWrites += 1;
        backing = v as number;
      },
    });

    cb(fakeEntries(1000, 300), {} as ResizeObserver);
    sink.dispose();
    flushRaf();
    expect(fontSizeWrites).toBe(0);
  });
});
