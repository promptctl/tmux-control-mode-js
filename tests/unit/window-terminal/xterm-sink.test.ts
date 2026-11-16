// tests/unit/window-terminal/xterm-sink.test.ts
//
// Unit tests for XtermSink's TerminalSink contract — the mutations it
// performs against a (mocked) xterm `Terminal`, and the lifecycle invariants
// it owes its callers. Covers:
//
//   - seed(captured, cursor): writes captured text + ANSI CUP escape exactly
//     when cursor is non-null. (Gate 4 fast-path correctness.)
//   - write(Uint8Array): forwards by reference; never decodes (Gate 5).
//   - resize(cols, rows): first call is deferred by one rAF; subsequent
//     calls are synchronous. (Demo's "Cannot read properties of undefined
//     (reading 'dimensions')" lesson.)
//   - setFont / setOptions / remeasure / clear: in-place; never reconstruct Terminal
//     and never call terminal.dispose(). (O10.)
//   - dispose(): tears down once; idempotent; subsequent ops are no-ops.
//   - isVisible: reflects IntersectionObserver + document.visibilityState.
//
// xterm.js is mocked at the module level so these tests never touch a real
// canvas/WebGL context — XtermSink's contract with xterm is "I call these
// methods in this order"; xterm's own correctness is upstream.
//
// [LAW:behavior-not-structure] We assert call counts and argument shapes
//   against the mock; we don't reach into XtermSink's private fields.

// @vitest-environment happy-dom

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// seed() carries raw bytes (same kind as write()). These fixtures are ASCII,
// so UTF-8 encoding is a 1:1 byte mapping; the helper keeps the assertions
// readable while exercising the byte contract.
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

// ---------------------------------------------------------------------------
// xterm.js mock — must be hoisted before importing XtermSink so the import
// resolves to this stub. The mock keeps the methods XtermSink calls and
// records them so assertions can target call shapes.
// ---------------------------------------------------------------------------

interface MockTerminal {
  options: { fontSize: number; theme: object; [k: string]: unknown };
  loaded: { addon: unknown; opened: boolean; cursorStyle: unknown }[];
  unicodeProviders: Map<string, unknown>;
  activeUnicode: string;
  element: HTMLElement | undefined;
  open: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  onData: MockEvent;
  onBinary: MockEvent;
}

// xterm's `IEvent<string>`: subscribe returns a disposable; `fire` stands in
// for xterm emitting the event, `listeners` counts live subscriptions.
interface MockEvent {
  (h: (data: string) => void): { dispose: () => void };
  fire(data: string): void;
  listeners(): number;
}

function mockEvent(): MockEvent {
  const hs = new Set<(data: string) => void>();
  const subscribe = (h: (data: string) => void) => {
    hs.add(h);
    return { dispose: () => hs.delete(h) };
  };
  return Object.assign(subscribe, {
    fire: (data: string) => hs.forEach((h) => h(data)),
    listeners: () => hs.size,
  });
}

// Single live mock instance accessible to tests; reset in beforeEach.
let lastTerm: MockTerminal | null = null;

vi.mock("@xterm/xterm", () => {
  class TerminalMock {
    options: { fontSize: number; theme: object; [k: string]: unknown };
    opened = false;
    element: HTMLElement | undefined;
    loaded: { addon: unknown; opened: boolean; cursorStyle: unknown }[] = [];
    unicodeProviders = new Map<string, unknown>();
    activeUnicode = "6";
    // As xterm does: the Unicode API is proposed, refused without
    // allowProposedApi, and only a registered version may be made active.
    get unicode() {
      if (this.options.allowProposedApi !== true) {
        throw new Error("You must set the allowProposedApi option");
      }
      const providers = this.unicodeProviders;
      const set = (v: string) => (this.activeUnicode = v);
      return {
        register: (p: { version: string }) => providers.set(p.version, p),
        set activeVersion(v: string) {
          if (!providers.has(v)) throw new Error(`unknown version ${v}`);
          set(v);
        },
      };
    }
    // As xterm does: the terminal's element holds its screen.
    open = vi.fn<(el: HTMLElement) => void>((container) => {
      this.opened = true;
      const doc = container.ownerDocument;
      this.element = doc.createElement("div");
      this.element.appendChild(doc.createElement("div")).className =
        "xterm-screen";
      container.appendChild(this.element);
    });
    write = vi.fn<(d: string | Uint8Array) => void>();
    resize = vi.fn<(c: number, r: number) => void>();
    clear = vi.fn<() => void>();
    dispose = vi.fn<() => void>();
    focus = vi.fn<() => void>();
    onData = mockEvent();
    onBinary = mockEvent();
    // As xterm does: an addon is the terminal's once loading starts, then
    // activates (and may throw).
    loadAddon(addon: { activate(t: unknown): void }) {
      this.loaded.push({
        addon,
        opened: this.opened,
        cursorStyle: this.options.cursorStyle,
      });
      addon.activate(this);
    }
    // As xterm does: every option has a value, its default where not given.
    constructor(opts: Record<string, unknown> = {}) {
      this.options = {
        fontSize: 15,
        theme: {},
        fontFamily: "courier-new, courier, monospace",
        lineHeight: 1,
        letterSpacing: 0,
        cursorStyle: "block",
        cursorBlink: false,
        allowProposedApi: false,
        ...opts,
      };
      lastTerm = this as unknown as MockTerminal;
    }
  }
  return { Terminal: TerminalMock };
});

// Import AFTER vi.mock so the mocked Terminal is used.
import { XtermSink } from "../../../src/window-terminal/render/xterm-sink.js";
import { TMUX_CELLS } from "../../../src/window-terminal/render/tmux-cells.js";
import { DEFAULT_FONT_FAMILY } from "../../../src/window-terminal/render/xterm-options.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContainer(): HTMLElement {
  const el = document.createElement("div");
  document.body.appendChild(el);
  return el;
}

// Records every value assigned to `obj[key]` from now on.
function countWrites(obj: object, key: string): () => unknown[] {
  const seen: unknown[] = [];
  let backing = (obj as Record<string, unknown>)[key];
  Object.defineProperty(obj, key, {
    configurable: true,
    get: () => backing,
    set: (v) => {
      seen.push(v);
      backing = v;
    },
  });
  return () => seen;
}

function newSink(): {
  sink: XtermSink;
  container: HTMLElement;
  term: MockTerminal;
} {
  const container = makeContainer();
  const sink = new XtermSink({ container });
  if (lastTerm === null) throw new Error("Terminal mock not constructed");
  return { sink, container, term: lastTerm };
}

// rAF stub — happy-dom provides a real one but firing it is async; for
// deterministic tests we replace it with a queue we flush manually.
let rafQueue: (() => void)[] = [];
let rafSeq = 0;
const realRaf = globalThis.requestAnimationFrame;
const realCaf = globalThis.cancelAnimationFrame;

function installFakeRaf(): void {
  rafQueue = [];
  rafSeq = 0;
  globalThis.requestAnimationFrame = ((cb: () => void) => {
    rafSeq += 1;
    rafQueue.push(cb);
    return rafSeq as unknown as number;
  }) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = vi.fn();
}

function flushRaf(): void {
  const q = rafQueue;
  rafQueue = [];
  for (const cb of q) cb();
}

beforeEach(() => {
  lastTerm = null;
  installFakeRaf();
});

afterEach(() => {
  globalThis.requestAnimationFrame = realRaf;
  globalThis.cancelAnimationFrame = realCaf;
  // Pull any container nodes off body so the next test's makeContainer
  // works against a clean tree.
  document.body.innerHTML = "";
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("XtermSink: seed", () => {
  it("writes captured text and a CUP escape when cursor is provided", () => {
    const { sink, term } = newSink();
    // Advance past the first-resize gate so seed() is applied immediately.
    sink.resize(80, 24);
    flushRaf();
    sink.seed(enc("hello\r\nworld"), { col: 4, row: 1 }, []);
    // Two writes: captured bytes, then the cursor escape + scrollToBottom cb.
    expect(term.write).toHaveBeenCalledTimes(2);
    expect(term.write).toHaveBeenNthCalledWith(1, enc("hello\r\nworld"));
    expect(term.write).toHaveBeenNthCalledWith(
      2,
      "\x1b[2;5H",
      expect.any(Function),
    );
    sink.dispose();
  });

  it("applies captured, CUP escape, THEN trailing bytes when cursor and trailing are both present", () => {
    // Gate-open path with the full combination: a non-null cursor makes
    // applySeed emit two term.write calls (captured + CUP), and non-empty
    // trailing follows — so the ordering is captured → CUP → each trailing chunk.
    const { sink, term } = newSink();
    sink.resize(80, 24);
    flushRaf();
    const t1 = new Uint8Array([0x41]);
    const t2 = new Uint8Array([0x42]);
    sink.seed(enc("grid"), { col: 4, row: 1 }, [t1, t2]);
    expect(term.write).toHaveBeenCalledTimes(4);
    expect(term.write).toHaveBeenNthCalledWith(1, enc("grid"));
    expect(term.write).toHaveBeenNthCalledWith(
      2,
      "\x1b[2;5H",
      expect.any(Function),
    );
    expect(term.write).toHaveBeenNthCalledWith(3, t1);
    expect(term.write).toHaveBeenNthCalledWith(4, t2);
    sink.dispose();
  });

  it("writes captured text without the CUP escape when cursor is null", () => {
    const { sink, term } = newSink();
    sink.resize(80, 24);
    flushRaf();
    sink.seed(enc("only text"), null, []);
    expect(term.write).toHaveBeenCalledTimes(1);
    expect(term.write).toHaveBeenCalledWith(
      enc("only text"),
      expect.any(Function),
    );
    sink.dispose();
  });

  it("seed after dispose is a no-op", () => {
    const { sink, term } = newSink();
    sink.dispose();
    sink.seed(enc("late"), { col: 0, row: 0 }, []);
    expect(term.write).not.toHaveBeenCalled();
  });

  it("seed before first resize is buffered; applied in the first-resize rAF", () => {
    const { sink, term } = newSink();
    sink.seed(enc("buffered"), { col: 2, row: 0 }, []);
    // rAF not yet fired — seed must be held, not applied.
    expect(term.write).not.toHaveBeenCalled();
    sink.resize(80, 24);
    expect(term.write).not.toHaveBeenCalled();
    // rAF fires: terminal.resize(), then applySeed().
    flushRaf();
    expect(term.resize).toHaveBeenCalledWith(80, 24);
    expect(term.write).toHaveBeenCalledTimes(2);
    expect(term.write).toHaveBeenNthCalledWith(1, enc("buffered"));
    expect(term.write).toHaveBeenNthCalledWith(
      2,
      "\x1b[1;3H",
      expect.any(Function),
    );
    sink.dispose();
  });

  it("a second seed() before the first rAF overwrites the first (latest wins)", () => {
    const { sink, term } = newSink();
    sink.seed(enc("first"), null, []);
    sink.seed(enc("second"), null, []);
    sink.resize(80, 24);
    flushRaf();
    // Only the second seed must reach xterm.
    expect(term.write).toHaveBeenCalledTimes(1);
    expect(term.write).toHaveBeenCalledWith(
      enc("second"),
      expect.any(Function),
    );
    sink.dispose();
  });

  it("a reseed before the first rAF drops the bytes buffered behind the earlier seed", () => {
    // The reseed's snapshot already contains them; replaying them after it
    // would duplicate output.
    const { sink, term } = newSink();
    sink.seed(enc("first"), null, [enc("behind-first")]);
    sink.write(enc("live"));
    sink.seed(enc("second"), null, [enc("behind-second")]);
    sink.resize(80, 24);
    flushRaf();
    expect(term.write.mock.calls.map((c) => c[0])).toEqual([
      enc("second"),
      enc("behind-second"),
    ]);
    sink.dispose();
  });
});

describe("XtermSink: write (live byte path)", () => {
  it("forwards a Uint8Array to terminal.write by reference", () => {
    const { sink, term } = newSink();
    // Advance past the first-resize gate so write() goes directly to terminal.
    sink.resize(80, 24);
    flushRaf();
    const bytes = new Uint8Array([0x1b, 0x5b, 0x33, 0x31, 0x6d]); // CSI 31 m
    sink.write(bytes);
    expect(term.write).toHaveBeenCalledTimes(1);
    expect(term.write).toHaveBeenCalledWith(bytes);
    // Identity — no copy. xterm.write accepts Uint8Array natively.
    expect(term.write.mock.calls[0][0]).toBe(bytes);
    sink.dispose();
  });

  it("write before first resize is buffered; drained after seed in the rAF", () => {
    const { sink, term } = newSink();
    const bytes1 = new Uint8Array([0x41]);
    const bytes2 = new Uint8Array([0x42]);
    sink.seed(enc("snap"), null, []);
    sink.write(bytes1);
    sink.write(bytes2);
    // Nothing forwarded to xterm yet.
    expect(term.write).not.toHaveBeenCalled();
    sink.resize(80, 24);
    flushRaf();
    // Order: seed (with scrollToBottom cb), then live bytes.
    expect(term.write).toHaveBeenCalledTimes(3);
    expect(term.write).toHaveBeenNthCalledWith(
      1,
      enc("snap"),
      expect.any(Function),
    );
    expect(term.write).toHaveBeenNthCalledWith(2, bytes1);
    expect(term.write).toHaveBeenNthCalledWith(3, bytes2);
    sink.dispose();
  });

  it("seed carrying trailing bytes before first resize drains snapshot → trailing → live, in order (SD2)", () => {
    // Exercises the seed()→trailing-loop→bufferWrite path directly: seed carries
    // its trailing bytes WHILE the gate is still buffering (no resize yet), so
    // the ordering flows through the seed value, not separate write() calls. The
    // first-resize rAF releases snapshot, then the seed's trailing, then any
    // subsequent live write — all in order.
    const { sink, term } = newSink();
    const t1 = new Uint8Array([0x41]);
    const t2 = new Uint8Array([0x42]);
    const live = new Uint8Array([0x43]);
    sink.seed(enc("SNAP"), null, [t1, t2]);
    sink.write(live);
    // Nothing reaches xterm before the first resize.
    expect(term.write).not.toHaveBeenCalled();
    sink.resize(80, 24);
    flushRaf();
    expect(term.resize).toHaveBeenCalledWith(80, 24);
    expect(term.write).toHaveBeenCalledTimes(4);
    expect(term.write).toHaveBeenNthCalledWith(
      1,
      enc("SNAP"),
      expect.any(Function),
    );
    expect(term.write).toHaveBeenNthCalledWith(2, t1);
    expect(term.write).toHaveBeenNthCalledWith(3, t2);
    expect(term.write).toHaveBeenNthCalledWith(4, live);
    sink.dispose();
  });

  it("post-dispose write is a no-op", () => {
    const { sink, term } = newSink();
    sink.dispose();
    sink.write(new Uint8Array([0x41]));
    expect(term.write).not.toHaveBeenCalled();
  });
});

describe("XtermSink: resize (first-resize defer)", () => {
  it("first resize is deferred by one rAF; subsequent are synchronous", () => {
    const { sink, term } = newSink();

    sink.resize(80, 24);
    // No synchronous resize on the very first call — xterm's renderer
    // hasn't booted yet, calling sync would crash on undefined dims.
    expect(term.resize).not.toHaveBeenCalled();

    flushRaf();
    expect(term.resize).toHaveBeenCalledTimes(1);
    expect(term.resize).toHaveBeenLastCalledWith(80, 24);

    // Second resize is synchronous.
    sink.resize(120, 30);
    expect(term.resize).toHaveBeenCalledTimes(2);
    expect(term.resize).toHaveBeenLastCalledWith(120, 30);

    sink.dispose();
  });

  it("multiple resizes before first rAF coalesce — uses the latest dims", () => {
    const { sink, term } = newSink();
    sink.resize(80, 24);
    sink.resize(100, 28);
    sink.resize(132, 40);
    expect(term.resize).not.toHaveBeenCalled();
    flushRaf();
    expect(term.resize).toHaveBeenCalledTimes(1);
    expect(term.resize).toHaveBeenLastCalledWith(132, 40);
    sink.dispose();
  });

  it("ignores degenerate dims (zero cols or rows)", () => {
    const { sink, term } = newSink();
    sink.resize(0, 24);
    sink.resize(80, 0);
    flushRaf();
    expect(term.resize).not.toHaveBeenCalled();
    sink.dispose();
  });
});

describe("XtermSink: pre-resize write buffer is bounded (kwv.3)", () => {
  // The buffer that holds live bytes before the first resize is drained ONLY
  // by a resize(), which is driven ONLY by tmux's pane-size subscription. If
  // that subscription failed the resize never comes — without a cap this buffer
  // grows forever behind a blank screen (the kwv.3 memory-leak-wearing-a-blank-
  // screen). These tests use ~1 MiB chunks; the cap is a few MiB, so a handful
  // of chunks crosses it while a single chunk does not.
  const MiB = 1024 * 1024;

  it("drains the buffer once it overflows — WITHOUT waiting for a resize", () => {
    const { sink, term } = newSink();
    const chunk = new Uint8Array(MiB);

    // Under the cap: buffered behind the first-resize defer, nothing to xterm.
    sink.write(chunk);
    expect(term.write).not.toHaveBeenCalled();
    expect(term.resize).not.toHaveBeenCalled();

    // Cross the cap (8 MiB total). The overflow forces a drain even though no
    // resize ever arrived: every chunk reaches the terminal (bounded there by
    // xterm's own scrollback), none stranded in an unbounded buffer.
    for (let i = 1; i < 8; i++) sink.write(chunk);
    expect(term.resize).not.toHaveBeenCalled();
    expect(term.write).toHaveBeenCalledTimes(8);

    // Post-drain writes go straight through — the buffer is not re-accumulating.
    sink.write(chunk);
    expect(term.write).toHaveBeenCalledTimes(9);
    sink.dispose();
  });

  it("a late resize after a cap-forced drain still reflows — rendering recovers", () => {
    const { sink, term } = newSink();
    const chunk = new Uint8Array(MiB);
    for (let i = 0; i < 8; i++) sink.write(chunk);
    expect(term.resize).not.toHaveBeenCalled();
    const drained = term.write.mock.calls.length;

    // The pane-size subscription finally succeeds (or a manual resize arrives):
    // the deferred first-resize still fires and reflows the already-written
    // content to the real geometry. Recovery, not a permanently wrong screen.
    sink.resize(80, 24);
    flushRaf();
    expect(term.resize).toHaveBeenCalledTimes(1);
    expect(term.resize).toHaveBeenLastCalledWith(80, 24);

    // Live bytes after recovery flow straight through.
    sink.write(chunk);
    expect(term.write).toHaveBeenCalledTimes(drained + 1);
    sink.dispose();
  });

  it("a cap-forced drain applies a pending seed BEFORE the buffered live bytes", () => {
    const { sink, term } = newSink();
    // Seed arrives before the first resize → held as pendingSeed.
    sink.seed(enc("SEED"), null, []);
    expect(term.write).not.toHaveBeenCalled();

    // Live bytes cross the cap → drain applies the seed first, then the bytes.
    const chunk = new Uint8Array(MiB);
    for (let i = 0; i < 8; i++) sink.write(chunk);
    expect(term.write.mock.calls[0]?.[0]).toEqual(enc("SEED"));
    expect(term.write).toHaveBeenCalledTimes(9); // 1 seed + 8 chunks
    sink.dispose();
  });

  it("a reseed after a cap-forced drain applies inline WITHOUT clearing (SD2)", () => {
    // After a cap-forced drain the gate is open but the first real resize has
    // not happened, so drained content + its scrollback sit on screen. A seed
    // arriving now is always a RESEED — a full pane_height-normalized snapshot
    // led by a screen-mode preamble, so writing it rewrites every visible row
    // by construction. It must NOT clear: a clear would blank the screen on a
    // failed (empty) reseed and discard the scrollback xterm accumulated during
    // the drain. Correctness rides on the tested normalization invariant, not a
    // reset. [LAW:no-ambient-temporal-coupling]
    const { sink, term } = newSink();
    const chunk = new Uint8Array(MiB);
    for (let i = 0; i < 8; i++) sink.write(chunk); // overflow → cap-forced drain
    expect(term.resize).not.toHaveBeenCalled();
    const beforeReseed = term.write.mock.calls.length;

    // Reseed arrives (still pre-first-resize): snapshot then trailing, no clear.
    sink.seed(enc("RESEED"), null, [new Uint8Array([0x41])]);

    expect(term.clear).not.toHaveBeenCalled();
    // The snapshot, then its trailing live byte, in order — nothing wiped.
    expect(term.write).toHaveBeenCalledTimes(beforeReseed + 2);
    expect(term.write.mock.calls[beforeReseed]?.[0]).toEqual(enc("RESEED"));
    expect(
      Array.from(term.write.mock.calls[beforeReseed + 1]?.[0] as Uint8Array),
    ).toEqual([0x41]);
    sink.dispose();
  });
});

describe("XtermSink: in-place option setters (O10)", () => {
  it("setFont writes options.fontSize without disposing the Terminal", () => {
    const { sink, term } = newSink();
    sink.setFont(20);
    expect(term.options.fontSize).toBe(20);
    expect(term.dispose).not.toHaveBeenCalled();
    sink.dispose();
  });

  it("setFont with the current size writes nothing (no xterm re-measure)", () => {
    const { sink, term } = newSink();
    sink.setFont(20);
    const writes = countWrites(term.options, "fontSize");
    sink.setFont(20);
    expect(writes()).toEqual([]);
    sink.setFont(22);
    expect(writes()).toEqual([22]);
    sink.dispose();
  });

  it("the renderer is read from the screen, and a listener hears it change until it detaches or the sink is disposed", async () => {
    const sink = new XtermSink({ container: makeContainer() });
    const screen = lastTerm?.element?.querySelector(".xterm-screen");
    if (screen === null || screen === undefined) {
      throw new Error("the terminal opened no screen");
    }
    // A renderer addon's link layer: WebGL's, or the canvas addon's.
    const linkLayer = document.createElement("canvas");
    linkLayer.className = "xterm-link-layer";
    const mutated = () => new Promise((r) => setTimeout(r, 0));
    const heard = vi.fn();
    const off = sink.onRendererChange(heard);
    expect(sink.renderer).toBe("dom");

    screen.appendChild(linkLayer);
    await mutated();
    expect(sink.renderer).toBe("canvas");
    expect(heard).toHaveBeenCalledOnce();

    off();
    linkLayer.remove();
    await mutated();
    expect(sink.renderer).toBe("dom");
    expect(heard).toHaveBeenCalledOnce();

    const later = vi.fn();
    sink.onRendererChange(later);
    sink.dispose();
    screen.appendChild(linkLayer);
    await mutated();
    expect(later).not.toHaveBeenCalled();
  });

  it("the host's options are set before the terminal opens, and each addon loads once, after it opens", () => {
    const a = { activate: vi.fn(), dispose: vi.fn() };
    const b = { activate: vi.fn(), dispose: vi.fn() };
    const addons = vi.fn(() => [a, b]);
    new XtermSink({
      container: makeContainer(),
      xterm: { cursorStyle: "bar" },
      addons,
    });
    const term = lastTerm;
    if (term === null) throw new Error("Terminal mock not constructed");
    expect(term.options).toMatchObject({
      cursorStyle: "bar",
      // The terminal's own choices beside the host's.
      fontFamily: DEFAULT_FONT_FAMILY,
      cursorBlink: true,
    });
    expect(addons).toHaveBeenCalledOnce();
    expect(term.loaded).toEqual([
      { addon: a, opened: true, cursorStyle: "bar" },
      { addon: b, opened: true, cursorStyle: "bar" },
    ]);
  });

  it("counts a character's cells as tmux does, with no option or addon from the host", () => {
    new XtermSink({ container: makeContainer() });
    const term = lastTerm;
    if (term === null) throw new Error("Terminal mock not constructed");
    expect(term.activeUnicode).toBe(TMUX_CELLS.version);
    expect(term.unicodeProviders.get(TMUX_CELLS.version)).toBe(TMUX_CELLS);
  });

  it("an addon that throws leaves no open terminal, and the addons not yet loaded are released", () => {
    const refused = new Error("proposed API not allowed");
    const a = { activate: vi.fn(), dispose: vi.fn() };
    const b = {
      activate: vi.fn(() => {
        throw refused;
      }),
      dispose: vi.fn(),
    };
    const c = { activate: vi.fn(), dispose: vi.fn() };
    expect(
      () =>
        new XtermSink({ container: makeContainer(), addons: () => [a, b, c] }),
    ).toThrow(refused);
    const term = lastTerm;
    if (term === null) throw new Error("Terminal mock not constructed");
    // xterm disposes a and b, which it holds, with the terminal.
    expect(term.dispose).toHaveBeenCalledOnce();
    expect(term.loaded.map((l) => l.addon)).toEqual([a, b]);
    expect(c.activate).not.toHaveBeenCalled();
    expect(c.dispose).toHaveBeenCalledOnce();
  });

  it("a release that throws as well loses neither error, and releases the rest", () => {
    const refused = new Error("proposed API not allowed");
    const stuck = new Error("cannot dispose");
    const b = {
      activate: vi.fn(() => {
        throw refused;
      }),
      dispose: vi.fn(),
    };
    const c = {
      activate: vi.fn(),
      dispose: vi.fn(() => {
        throw stuck;
      }),
    };
    const d = { activate: vi.fn(), dispose: vi.fn() };
    let thrown: unknown;
    try {
      new XtermSink({ container: makeContainer(), addons: () => [b, c, d] });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors).toEqual([refused, stuck]);
    expect(lastTerm?.dispose).toHaveBeenCalledOnce();
    expect(d.dispose).toHaveBeenCalledOnce();
  });

  it("a terminal that fails to open after it is constructed is disposed, and the error leaves as thrown", () => {
    const broken = new Error("no observer");
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function () {
        throw broken;
      }),
    );
    try {
      expect(() => new XtermSink({ container: makeContainer() })).toThrow(
        broken,
      );
      expect(lastTerm?.dispose).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("setOptions writes only what changed: a theme equal in a new object is left alone, a new function is written", () => {
    const { sink, term } = newSink();
    const first = vi.fn();
    sink.setOptions({
      theme: { background: "#000" },
      linkHandler: { activate: first },
    });
    const themes = countWrites(term.options, "theme");
    const handlers = countWrites(term.options, "linkHandler");
    const second = vi.fn();
    sink.setOptions({
      theme: { background: "#000" },
      linkHandler: { activate: second },
    });
    expect(themes()).toEqual([]);
    expect(handlers()).toEqual([{ activate: second }]);
    expect(term.dispose).not.toHaveBeenCalled();
    sink.dispose();
  });

  it("an option left out returns to its value before any host option: xterm's default, or the terminal's", () => {
    const { sink, term } = newSink();
    sink.setOptions({
      fontFamily: "Iosevka",
      cursorStyle: "bar",
      lineHeight: 1.2,
    });
    sink.setOptions({ lineHeight: 1.2 });
    expect(term.options).toMatchObject({
      fontFamily: DEFAULT_FONT_FAMILY,
      cursorStyle: "block",
      lineHeight: 1.2,
    });
    sink.dispose();
  });

  it("remeasure changes the font size and back, so xterm measures again", () => {
    const { sink, term } = newSink();
    sink.setFont(16);
    const writes = countWrites(term.options, "fontSize");
    sink.remeasure();
    expect(writes()).toEqual([17, 16]);
    expect(term.options.fontSize).toBe(16);
    sink.dispose();
  });

  it("clear forwards to terminal.clear without disposing", () => {
    const { sink, term } = newSink();
    sink.clear();
    expect(term.clear).toHaveBeenCalledOnce();
    expect(term.dispose).not.toHaveBeenCalled();
    sink.dispose();
  });
});

describe("XtermSink: dispose lifecycle", () => {
  it("dispose calls terminal.dispose exactly once", () => {
    const { sink, term } = newSink();
    sink.dispose();
    expect(term.dispose).toHaveBeenCalledOnce();
    sink.dispose();
    sink.dispose();
    expect(term.dispose).toHaveBeenCalledOnce();
  });

  it("post-dispose: write, seed, resize, setFont, setOptions, remeasure all no-op", () => {
    const { sink, term } = newSink();
    sink.dispose();
    sink.seed(enc("x"), null, []);
    sink.write(new Uint8Array([1]));
    sink.resize(80, 24);
    flushRaf();
    sink.setFont(99);
    sink.setOptions({ theme: { background: "#abc" } });
    sink.remeasure();
    sink.clear();
    sink.focus();
    expect(term.write).not.toHaveBeenCalled();
    expect(term.resize).not.toHaveBeenCalled();
    expect(term.clear).not.toHaveBeenCalled();
    expect(term.focus).not.toHaveBeenCalled();
  });

  it("isVisible returns false after dispose", () => {
    const { sink } = newSink();
    expect(sink.isVisible()).toBe(true);
    sink.dispose();
    expect(sink.isVisible()).toBe(false);
  });
});

describe("XtermSink: isVisible (IntersectionObserver + document visibility)", () => {
  it("defaults to true before any IO callback fires", () => {
    const { sink } = newSink();
    expect(sink.isVisible()).toBe(true);
    sink.dispose();
  });
});

describe("XtermSink: focus + onInput", () => {
  it("focus delegates to terminal.focus when alive", () => {
    const { sink, term } = newSink();
    sink.focus();
    expect(term.focus).toHaveBeenCalledOnce();
    sink.dispose();
  });

  it("typed text arrives as its UTF-8 bytes", () => {
    const { sink, term } = newSink();
    const got: Uint8Array[] = [];
    sink.onInput((b) => got.push(b));
    term.onData.fire("a\x1b[<0;10;5Mé");
    expect(got).toEqual([enc("a\x1b[<0;10;5Mé")]);
    sink.dispose();
  });

  it("a DEFAULT-encoded mouse report (onBinary) arrives byte-exact, coordinates ≥ 0x80 included", () => {
    // xterm sends `CSI M Cb Cx Cy` on onBinary, one byte per code unit. Column
    // 129 encodes as 0xa1 (32 + 129); as text it would become UTF-8 c2 a1.
    const { sink, term } = newSink();
    const got: Uint8Array[] = [];
    sink.onInput((b) => got.push(b));
    term.onBinary.fire("\x1b[M \xa1!");
    expect(got).toEqual([new Uint8Array([0x1b, 0x5b, 0x4d, 0x20, 0xa1, 0x21])]);
    sink.dispose();
  });

  it("unsubscribing detaches from both input events", () => {
    const { sink, term } = newSink();
    const unsub = sink.onInput(() => undefined);
    expect([term.onData.listeners(), term.onBinary.listeners()]).toEqual([
      1, 1,
    ]);
    unsub();
    expect([term.onData.listeners(), term.onBinary.listeners()]).toEqual([
      0, 0,
    ]);
    sink.dispose();
  });
});
