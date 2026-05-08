// packages/pane-terminal/tests/unit/vanilla-mount.test.ts
//
// Unit tests for `mountPaneTerminal` — the vanilla mirror of the React
// adapter. The adapter is intentionally tiny; the tests are correspondingly
// behavioural, asserting only the wiring contract:
//
//   - construct calls `stream.attach(sink)` exactly once;
//   - dispose tears down (offKeys → detach → sink.dispose) exactly once;
//   - dispose is idempotent — a second call is a no-op;
//   - the live `sink` field is the constructed XtermSink (escape hatch).
//
// xterm.js is mocked the same way `xterm-sink.test.ts` does — XtermSink's
// own contract is upstream and tested there; here we just verify the
// adapter calls XtermSink in the right order.

// @vitest-environment happy-dom

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// xterm.js mock — must be hoisted before the import of mountPaneTerminal so
// it resolves to this stub. We only care about call counts on the methods
// XtermSink touches; xterm's own correctness is upstream.
// ---------------------------------------------------------------------------

let lastTerm: {
  options: { fontSize: number; theme: object; [k: string]: unknown };
  open: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  onData: ReturnType<typeof vi.fn>;
  onDataDispose: ReturnType<typeof vi.fn>;
} | null = null;

vi.mock("@xterm/xterm", () => {
  class TerminalMock {
    options: { fontSize: number; theme: object; [k: string]: unknown };
    open = vi.fn<(el: HTMLElement) => void>();
    write = vi.fn<(d: string | Uint8Array) => void>();
    resize = vi.fn<(c: number, r: number) => void>();
    clear = vi.fn<() => void>();
    dispose = vi.fn<() => void>();
    focus = vi.fn<() => void>();
    onDataDispose = vi.fn<() => void>();
    onData = vi.fn<(h: (data: string) => void) => { dispose: () => void }>(
      () => ({ dispose: this.onDataDispose }),
    );
    constructor(init: Record<string, unknown>) {
      this.options = {
        fontSize: (init.fontSize as number | undefined) ?? 14,
        theme: (init.theme as object | undefined) ?? {},
      };
      lastTerm = this as unknown as NonNullable<typeof lastTerm>;
    }
  }
  return { Terminal: TerminalMock };
});

// ---------------------------------------------------------------------------
// PaneStream stub — duck-types the surface mountPaneTerminal touches
// (attach, detach, sendKeys). Imported via the *type* boundary in the
// adapter, so casting through `unknown` here is the local-trust seam.
// ---------------------------------------------------------------------------

import type { TerminalSink } from "../../src/sink/index.js";
import type { PaneStream } from "../../src/stream/index.js";
import { mountPaneTerminal } from "../../src/vanilla/index.js";

class StubStream {
  attach = vi.fn<(sink: TerminalSink) => void>();
  detach = vi.fn<() => void>();
  sendKeys = vi.fn<(d: string) => Promise<void>>(() => Promise.resolve());
}

function asPaneStream(s: StubStream): PaneStream {
  return s as unknown as PaneStream;
}

// ---------------------------------------------------------------------------

describe("mountPaneTerminal (vanilla adapter)", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    lastTerm = null;
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("constructs an XtermSink and attaches it to the stream exactly once", () => {
    const stream = new StubStream();
    const handle = mountPaneTerminal(asPaneStream(stream), container, {
      fontSize: 14,
    });

    expect(lastTerm).not.toBeNull();
    expect(lastTerm!.open).toHaveBeenCalledOnce();
    expect(lastTerm!.open).toHaveBeenCalledWith(container);
    expect(stream.attach).toHaveBeenCalledOnce();
    expect(stream.attach.mock.calls[0]?.[0]).toBe(handle.sink);
    expect(stream.detach).not.toHaveBeenCalled();
  });

  it("forwards xterm onData to stream.sendKeys", () => {
    const stream = new StubStream();
    mountPaneTerminal(asPaneStream(stream), container);

    // Pull the registered onData handler from the mock and invoke it as
    // xterm would when the user types.
    const onDataCalls = lastTerm!.onData.mock.calls;
    expect(onDataCalls).toHaveLength(1);
    const handler = onDataCalls[0]?.[0] as (d: string) => void;
    handler("ls\r");

    expect(stream.sendKeys).toHaveBeenCalledOnce();
    expect(stream.sendKeys).toHaveBeenCalledWith("ls\r");
  });

  it("dispose tears down in safe order (offKeys → detach → sink.dispose)", () => {
    const stream = new StubStream();
    const handle = mountPaneTerminal(asPaneStream(stream), container);

    const callOrder: string[] = [];
    lastTerm!.onDataDispose.mockImplementation(() => callOrder.push("offKeys"));
    stream.detach.mockImplementation(() => callOrder.push("detach"));
    lastTerm!.dispose.mockImplementation(() => callOrder.push("dispose"));

    handle.dispose();

    expect(callOrder).toEqual(["offKeys", "detach", "dispose"]);
  });

  it("dispose is idempotent — a second call is a no-op", () => {
    const stream = new StubStream();
    const handle = mountPaneTerminal(asPaneStream(stream), container);

    handle.dispose();
    handle.dispose();
    handle.dispose();

    expect(stream.detach).toHaveBeenCalledOnce();
    expect(lastTerm!.dispose).toHaveBeenCalledOnce();
    expect(lastTerm!.onDataDispose).toHaveBeenCalledOnce();
  });

  it("exposes the live sink for advanced consumers (focus, setFontSize, setTheme)", () => {
    const stream = new StubStream();
    const handle = mountPaneTerminal(asPaneStream(stream), container, {
      fontSize: 12,
    });

    handle.sink.focus();
    handle.sink.setFontSize(18);
    handle.sink.setTheme({ background: "#000000" });

    expect(lastTerm!.focus).toHaveBeenCalledOnce();
    expect(lastTerm!.options.fontSize).toBe(18);
    expect((lastTerm!.options.theme as { background?: string }).background).toBe(
      "#000000",
    );
    // No reconstruction; only the original Terminal instance exists.
    expect(lastTerm!.dispose).not.toHaveBeenCalled();
  });
});
