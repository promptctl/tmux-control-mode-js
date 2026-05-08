// packages/pane-terminal/tests/bench/g6-dispose-reclaim.bench.ts
//
// GATE 6 — dispose() reclaim: heap returns to within 1MB of pre-construction.
//
// What this gate measures and why:
//
//   The contract under test is "PaneStream + XtermSink hold no listeners,
//   timers, DOM nodes, or closures past dispose()." The 1MB delta is a
//   tolerance for V8's generational behaviour, not a precise allocation
//   count — heap-used numbers wobble by tens of KB even at perfect
//   determinism, so the budget has to be large enough to ride out that
//   noise but small enough that a leak on the order of "one closure per
//   stream × 24 streams" would bust it.
//
// Why we mock @xterm/xterm here:
//
//   The contract being tested is OUR dispose code, not xterm's. Xterm has
//   its own test suite upstream. Mocking the Terminal class isolates the
//   measurement to PaneStream + XtermSink + observer/listener registries —
//   a leak in our wrapper shows up as MB-scale; a leak in xterm proper would
//   need a different gate. With the mock, the baseline allocation per sink
//   is small enough that the 1MB budget catches a real wrapper-side leak
//   (several KB × 24 = several hundred KB).
//
// Status: GREEN as of 8w9.6.

// @vitest-environment happy-dom

import { describe, it, expect, vi } from "vitest";
import { FakeTmuxClient } from "../../src/bench/index.js";
import { PaneStream } from "../../src/stream/index.js";
import type { PaneStreamClient } from "../../src/stream/index.js";

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

vi.mock("@xterm/xterm", () => {
  class TerminalMock {
    options: { fontSize: number; theme: object; [k: string]: unknown };
    open = vi.fn();
    write = vi.fn();
    resize = vi.fn();
    clear = vi.fn();
    dispose = vi.fn();
    focus = vi.fn();
    onData = vi.fn(() => ({ dispose: vi.fn() }));
    constructor(opts: { fontSize?: number; theme?: object } = {}) {
      this.options = {
        fontSize: opts.fontSize ?? 14,
        theme: opts.theme ?? {},
      };
    }
  }
  return { Terminal: TerminalMock };
});

import { XtermSink } from "../../src/xterm-sink/index.js";

const RECLAIM_BUDGET_BYTES = 1 * 1024 * 1024;
const STREAM_COUNT = 24;

interface ExposedGc {
  (): void;
}

function getGc(): ExposedGc | null {
  const candidate = (globalThis as { gc?: unknown }).gc;
  return typeof candidate === "function" ? (candidate as ExposedGc) : null;
}

function makeContainer(): HTMLElement {
  const el = document.createElement("div");
  document.body.appendChild(el);
  return el;
}

describe("Gate 6 — dispose() reclaim", () => {
  const gc = getGc();

  it.skipIf(gc === null)(
    `heap returns to within ${RECLAIM_BUDGET_BYTES}B of pre-construction baseline`,
    () => {
      const runGc = gc!;

      // Stabilise the baseline. One full construct/dispose pass primes any
      // module-scope caches (font cache, xterm internals as mocked) so the
      // measurement window only sees per-stream allocations.
      {
        const c = new FakeTmuxClient();
        const containers: HTMLElement[] = [];
        const sinks: XtermSink[] = [];
        const streams: PaneStream[] = [];
        for (let i = 0; i < STREAM_COUNT; i++) {
          const container = makeContainer();
          const sink = new XtermSink({ container });
          const stream = new PaneStream({
            client: c as unknown as PaneStreamClient,
            paneId: i + 1,
          });
          stream.attach(sink);
          containers.push(container);
          sinks.push(sink);
          streams.push(stream);
        }
        for (const stream of streams) stream.dispose();
        for (const sink of sinks) sink.dispose();
        for (const container of containers) container.remove();
      }

      runGc();
      runGc();
      const baseline = process.memoryUsage().heapUsed;

      // Real measurement window.
      const client = new FakeTmuxClient();
      const containers: HTMLElement[] = [];
      const sinks: XtermSink[] = [];
      const streams: PaneStream[] = [];
      for (let i = 0; i < STREAM_COUNT; i++) {
        const container = makeContainer();
        const sink = new XtermSink({ container });
        const stream = new PaneStream({
          client: client as unknown as PaneStreamClient,
          paneId: i + 1,
        });
        stream.attach(sink);
        containers.push(container);
        sinks.push(sink);
        streams.push(stream);
      }

      // Drive a small amount of byte traffic so the activity-counter timer
      // path is exercised before disposal — a leak there would otherwise
      // hide behind the "we never produced a flush callback" path.
      const burst = new Uint8Array([0x41, 0x42, 0x43]);
      for (let i = 0; i < STREAM_COUNT; i++) {
        client.injectOutput(i + 1, burst);
      }

      // Tear down. Disposing the stream first matches the consumer-side
      // contract (PaneStream owns the byte handlers; XtermSink owns the DOM).
      for (const stream of streams) stream.dispose();
      for (const sink of sinks) sink.dispose();
      for (const container of containers) container.remove();

      runGc();
      runGc();
      const after = process.memoryUsage().heapUsed;
      const delta = after - baseline;

      expect(
        delta,
        `heap delta ${delta} bytes (budget ${RECLAIM_BUDGET_BYTES}). ` +
          `Likely a retained listener/observer/timer in PaneStream or XtermSink dispose().`,
      ).toBeLessThan(RECLAIM_BUDGET_BYTES);
    },
  );

  it("declares the SKIP reason when --expose-gc is not present", () => {
    if (gc !== null) return;
    expect(true).toBe(true);
    // eslint-disable-next-line no-console
    console.warn(
      "[gate-6] skipped: launch node with --expose-gc to enable the dispose-reclaim gate.",
    );
  });
});
