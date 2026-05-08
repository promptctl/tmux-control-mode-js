// packages/pane-terminal/tests/unit/react-pane-terminal.test.tsx
//
// Unit tests for `<PaneTerminal>` — the React adapter. The contract is:
//
//   1. Mount runs exactly once per stream identity. No remount on style
//      props, no remount on rerenders that don't change `stream`.
//   2. Changing `fontSize` calls `sink.setFontSize` and does NOT call
//      `xterm.dispose()` (O10).
//   3. Changing `theme` calls `sink.setTheme` and does NOT call
//      `xterm.dispose()` (O10).
//   4. Unmount tears down (detach + dispose) — no leak.
//   5. StrictMode-style mount/unmount/remount: the *real* PaneStream issues
//      exactly 1 `capture-pane` over its lifetime even though the React
//      component mounts twice (gate #4 extension).
//
// xterm.js is mocked the same way the unit tests for XtermSink mock it.
// PaneStream is the real class for the gate-#4 test (verifying its
// re-attach fast path against React's mount churn) and a stub for the
// adapter-level tests (asserting the wiring).

// @vitest-environment happy-dom

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { StrictMode, act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

// ---------------------------------------------------------------------------
// xterm.js mock — single live mock instance accessible to tests; reset
// before each. Mirrors the pattern in xterm-sink.test.ts.
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
  onDataDispose: ReturnType<typeof vi.fn>;
}

const allTerms: MockTerminal[] = [];

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
      allTerms.push(this as unknown as MockTerminal);
    }
  }
  return { Terminal: TerminalMock };
});

// ---------------------------------------------------------------------------

import type { TerminalSink } from "../../src/sink/index.js";
import type { PaneStream } from "../../src/stream/index.js";
import { PaneStream as RealPaneStream } from "../../src/stream/index.js";
import type { PaneStreamClient } from "../../src/stream/index.js";
import { FakeTmuxClient } from "../../src/bench/index.js";
import { PaneTerminal } from "../../src/react/index.js";

class StubStream {
  attach = vi.fn<(sink: TerminalSink) => void>();
  detach = vi.fn<() => void>();
  sendKeys = vi.fn<(d: string) => Promise<void>>(() => Promise.resolve());
}

function asPaneStream(s: StubStream): PaneStream {
  return s as unknown as PaneStream;
}

// React 18 createRoot helpers — render and rerender synchronously inside
// `act()` so effects flush before assertions.
interface RenderHandle {
  readonly root: Root;
  readonly container: HTMLDivElement;
  rerender(node: ReactNode): void;
  unmount(): void;
}

function render(node: ReactNode): RenderHandle {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  return {
    root,
    container,
    rerender(next) {
      act(() => {
        root.render(next);
      });
    },
    unmount() {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

// ---------------------------------------------------------------------------

describe("<PaneTerminal> (React adapter)", () => {
  beforeEach(() => {
    allTerms.length = 0;
  });

  afterEach(() => {
    // happy-dom doesn't reset per-test; clear lingering body children.
    document.body.replaceChildren();
  });

  it("constructs the sink once and attaches the stream", () => {
    const stream = new StubStream();
    const h = render(<PaneTerminal stream={asPaneStream(stream)} fontSize={14} />);

    expect(allTerms).toHaveLength(1);
    expect(stream.attach).toHaveBeenCalledOnce();
    expect(stream.detach).not.toHaveBeenCalled();

    h.unmount();
    expect(stream.detach).toHaveBeenCalledOnce();
    expect(allTerms[0]?.dispose).toHaveBeenCalledOnce();
  });

  it("changing fontSize calls setFontSize and does NOT call xterm.dispose() (O10)", () => {
    const stream = new StubStream();
    const h = render(<PaneTerminal stream={asPaneStream(stream)} fontSize={14} />);

    expect(allTerms).toHaveLength(1);
    const term = allTerms[0]!;
    expect(term.options.fontSize).toBe(14);

    h.rerender(<PaneTerminal stream={asPaneStream(stream)} fontSize={18} />);

    // Only one Terminal was ever constructed; the size flipped in place.
    expect(allTerms).toHaveLength(1);
    expect(term.options.fontSize).toBe(18);
    expect(term.dispose).not.toHaveBeenCalled();
    expect(stream.detach).not.toHaveBeenCalled();

    h.unmount();
  });

  it("changing theme calls setTheme and does NOT call xterm.dispose() (O10)", () => {
    const stream = new StubStream();
    const initialTheme = { background: "#000000" };
    const h = render(
      <PaneTerminal stream={asPaneStream(stream)} theme={initialTheme} />,
    );

    expect(allTerms).toHaveLength(1);
    const term = allTerms[0]!;

    h.rerender(
      <PaneTerminal
        stream={asPaneStream(stream)}
        theme={{ background: "#101820" }}
      />,
    );

    expect(allTerms).toHaveLength(1);
    expect((term.options.theme as { background?: string }).background).toBe(
      "#101820",
    );
    expect(term.dispose).not.toHaveBeenCalled();

    h.unmount();
  });

  it("changing the stream prop tears down and reconstructs the sink", () => {
    const streamA = new StubStream();
    const streamB = new StubStream();
    const h = render(<PaneTerminal stream={asPaneStream(streamA)} />);

    expect(allTerms).toHaveLength(1);
    const termA = allTerms[0]!;
    expect(streamA.attach).toHaveBeenCalledOnce();

    h.rerender(<PaneTerminal stream={asPaneStream(streamB)} />);

    expect(allTerms).toHaveLength(2);
    const termB = allTerms[1]!;
    expect(termA.dispose).toHaveBeenCalledOnce();
    expect(streamA.detach).toHaveBeenCalledOnce();
    expect(streamB.attach).toHaveBeenCalledOnce();
    expect(termB.dispose).not.toHaveBeenCalled();

    h.unmount();
    expect(streamB.detach).toHaveBeenCalledOnce();
    expect(termB.dispose).toHaveBeenCalledOnce();
  });

  it("autoFocus calls sink.focus() exactly once after attach", () => {
    const stream = new StubStream();
    const h = render(
      <PaneTerminal stream={asPaneStream(stream)} autoFocus={true} />,
    );
    expect(allTerms[0]?.focus).toHaveBeenCalledOnce();
    h.unmount();
  });

  it("forwards xterm onData to stream.sendKeys", () => {
    const stream = new StubStream();
    const h = render(<PaneTerminal stream={asPaneStream(stream)} />);

    const handler = allTerms[0]!.onData.mock.calls[0]?.[0] as (
      d: string,
    ) => void;
    handler("hello\n");
    expect(stream.sendKeys).toHaveBeenCalledWith("hello\n");

    h.unmount();
  });

  // -------------------------------------------------------------------------
  // GATE 4 extension — StrictMode double-mount issues exactly 1 capture-pane
  // over the stream's lifetime. Uses the real PaneStream + FakeTmuxClient so
  // we exercise the cached-seed fast path PaneStream provides.
  // -------------------------------------------------------------------------

  it(
    "StrictMode mount/unmount/remount issues exactly 1 capture-pane (gate #4)",
    async () => {
      const client = new FakeTmuxClient();
      client.setCapturePaneResponse((cmd) =>
        cmd.startsWith("display-message") ? "0;0" : "row-0\nrow-1\n",
      );
      const stream = new RealPaneStream({
        client: client as unknown as PaneStreamClient,
        paneId: 1,
      });

      expect(client.capturePaneCount()).toBe(0);

      const h = render(
        <StrictMode>
          <PaneTerminal stream={stream} />
        </StrictMode>,
      );

      // capture-pane + cursor display-message both resolve via FakeTmuxClient
      // on the next macrotasks (see g4-remount-capture.test.ts for the
      // canonical pattern).
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
        await new Promise((r) => setTimeout(r, 0));
      });

      // StrictMode mounts twice synchronously: first mount → cleanup → second
      // mount. The first attach issues capture-pane; the second attach hits
      // PaneStream's cached-seed fast path. So count stays at 1.
      expect(client.capturePaneCount()).toBe(1);
      // ...and we should have constructed exactly two xterm Terminals (one
      // per StrictMode mount cycle).
      expect(allTerms).toHaveLength(2);

      h.unmount();
      stream.dispose();
    },
  );
});
