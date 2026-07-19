// packages/pane-terminal/tests/unit/xterm-sink.test.ts
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
//   - setFontSize / setTheme / clear: in-place; never reconstruct Terminal
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
  open: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  onData: ReturnType<typeof vi.fn>;
}

// Single live mock instance accessible to tests; reset in beforeEach.
let lastTerm: MockTerminal | null = null;

vi.mock("@xterm/xterm", () => {
  class TerminalMock {
    options: { fontSize: number; theme: object; [k: string]: unknown };
    open = vi.fn<(el: HTMLElement) => void>();
    write = vi.fn<(d: string | Uint8Array) => void>();
    resize = vi.fn<(c: number, r: number) => void>();
    clear = vi.fn<() => void>();
    dispose = vi.fn<() => void>();
    focus = vi.fn<() => void>();
    onData = vi.fn<(h: (data: string) => void) => { dispose: () => void }>(
      () => ({ dispose: vi.fn() }),
    );
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

// Import AFTER vi.mock so the mocked Terminal is used.
import { XtermSink } from "../../src/xterm-sink/index.js";
import { __resetCache } from "../../src/xterm-sink/font-cache.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContainer(): HTMLElement {
  const el = document.createElement("div");
  // Give it a non-zero box so fitFont() returns something meaningful.
  Object.defineProperty(el, "getBoundingClientRect", {
    value: () => ({
      width: 800,
      height: 240,
      top: 0,
      left: 0,
      bottom: 240,
      right: 800,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }),
  });
  document.body.appendChild(el);
  return el;
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
let rafQueue: Array<() => void> = [];
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
  __resetCache();
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
    expect(term.write).toHaveBeenNthCalledWith(2, "\x1b[2;5H", expect.any(Function));
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
    expect(term.write).toHaveBeenNthCalledWith(2, "\x1b[2;5H", expect.any(Function));
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
    expect(term.write).toHaveBeenCalledWith(enc("only text"), expect.any(Function));
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
    expect(term.write).toHaveBeenNthCalledWith(2, "\x1b[1;3H", expect.any(Function));
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
    expect(term.write).toHaveBeenCalledWith(enc("second"), expect.any(Function));
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
    expect(term.write).toHaveBeenNthCalledWith(1, enc("snap"), expect.any(Function));
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
    expect(term.write).toHaveBeenNthCalledWith(1, enc("SNAP"), expect.any(Function));
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
  it("setFontSize writes options.fontSize without disposing the Terminal", () => {
    const { sink, term } = newSink();
    sink.setFontSize(20);
    expect(term.options.fontSize).toBe(20);
    expect(term.dispose).not.toHaveBeenCalled();
    sink.dispose();
  });

  it("setFontSize is idempotent — same value does not re-write options", () => {
    const { sink, term } = newSink();
    sink.setFontSize(20);
    // Reset the watcher so we can detect further writes. Vitest mocks don't
    // detect property writes directly, so we use Object.defineProperty to
    // count assignments.
    let writes = 0;
    let backing = term.options.fontSize;
    Object.defineProperty(term.options, "fontSize", {
      configurable: true,
      get: () => backing,
      set: (v) => {
        writes += 1;
        backing = v as number;
      },
    });
    sink.setFontSize(20);
    expect(writes).toBe(0); // same value: no write
    sink.setFontSize(22);
    expect(writes).toBe(1); // different value: one write
    sink.dispose();
  });

  it("setTheme merges into the existing theme without reconstructing", () => {
    const { sink, term } = newSink();
    sink.setTheme({ background: "#000" });
    expect(term.dispose).not.toHaveBeenCalled();
    expect((term.options.theme as { background?: string }).background).toBe(
      "#000",
    );
    sink.setTheme({ foreground: "#fff" });
    expect((term.options.theme as { background?: string }).background).toBe(
      "#000",
    );
    expect((term.options.theme as { foreground?: string }).foreground).toBe(
      "#fff",
    );
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

  it("post-dispose: write, seed, resize, setFontSize all no-op", () => {
    const { sink, term } = newSink();
    sink.dispose();
    sink.seed(enc("x"), null, []);
    sink.write(new Uint8Array([1]));
    sink.resize(80, 24);
    flushRaf();
    sink.setFontSize(99);
    sink.setTheme({ background: "#abc" });
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

describe("XtermSink: focus + onData", () => {
  it("focus delegates to terminal.focus when alive", () => {
    const { sink, term } = newSink();
    sink.focus();
    expect(term.focus).toHaveBeenCalledOnce();
    sink.dispose();
  });

  it("onData returns an unsubscribe function that disposes the listener", () => {
    const { sink, term } = newSink();
    const handler = vi.fn();
    const unsub = sink.onData(handler);
    expect(term.onData).toHaveBeenCalledWith(handler);
    expect(typeof unsub).toBe("function");
    // The returned function should not throw; we cannot easily assert that
    // it disposes the listener without leaking mock internals — the spec is
    // that it's a function and can be called safely.
    expect(() => unsub()).not.toThrow();
    sink.dispose();
  });
});
