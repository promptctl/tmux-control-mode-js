// packages/pane-terminal/tests/bench/g6-dispose-reclaim.bench.ts
//
// GATE 6 — dispose() reclaim: one construct+dispose cycle returns the heap to
// where it started.
//
// The contract under test:
//
//   "PaneStream + XtermSink hold no listeners, timers, DOM nodes, or closures
//   past dispose()." The dangerous, catchable class is a leak that retains a
//   HEAVY object graph — an XtermSink whose observer/listener survives dispose
//   keeps the terminal + DOM + observers alive (~100KB across STREAM_COUNT
//   sinks). XtermSink is where a single forgotten cleanup leaks heavy: its
//   observers/listeners reference the sink directly. (PaneStream is hardened
//   against this by construction — its one heavy field, `sink`, is reachable
//   only through the stream and is nulled on dispose, so a single forgotten
//   `off`/`clearTimeout` retains at most an emptied ~1KB husk, below this
//   gate's resolution. That is dispose working, not a gap.)
//
// Why MIN over N cycles instead of a single absolute delta:
//
//   `process.memoryUsage().heapUsed` after `gc()` is a NOISY random variable —
//   V8 does not compact deterministically, so any one draw wobbles. The prior
//   gate asserted ONE draw of a single construct/dispose delta was `<= 1MB`,
//   and on CI that draw read ~1.18MB with no leak present, reddening unrelated
//   PRs. The defect was structural, not a threshold to widen: the statistic
//   (one delta) had a no-leak distribution that overlapped the budget.
//   [LAW:types-are-the-program] — the predicate was not a true theorem of the
//   data.
//
//   The fix separates signal from noise by SHAPE. A leak is persistent: every
//   cycle nets the same positive retention, raising the FLOOR of the delta
//   distribution. GC noise is transient: it sometimes settles low, raising
//   only the CEILING. `MIN` over N independent cycles reads the floor — the
//   best-case settle. No leak ⇒ at least one of N cycles reclaims to baseline
//   ⇒ MIN small ⇒ GREEN, deterministically. A heavy leak ⇒ every cycle floors
//   at the retained-graph cost ⇒ MIN high ⇒ RED, deterministically. Measured
//   no-leak MIN is single-digit KB; a forgotten XtermSink listener floors at
//   ~100KB — a wide, stable gap the budget sits inside.
//
// Why the baseline is taken FRESH each cycle:
//
//   Each cycle's delta must reflect only THAT cycle's net retention. Sampling
//   `before` right after the per-cycle `gc()` means a leak reads its per-cycle
//   cost every iteration (prior cycles' leaks are already in `before`), so MIN
//   cannot be fooled low by an early cycle.
//
// Why we drain macrotasks each cycle:
//
//   FakeTmuxClient resolves subscribeRaw / unsubscribe / execute acks on
//   `setTimeout(0)`. A synchronous loop never yields, so those timer closures
//   pile up in Node's timer heap — accumulation of the TEST HARNESS, not of
//   dispose(). Draining (awaiting a few macrotasks) flushes them so the
//   measurement sees steady state. [LAW:no-silent-failure] — measuring the
//   harness's own backlog and blaming dispose() would send the next agent down
//   a phantom-leak hunt.
//
// Why we mock @xterm/xterm with PLAIN functions (not vi.fn):
//
//   The contract under test is OUR dispose code, not xterm's (xterm has its own
//   upstream suite). But `vi.fn()` spies are retained by vitest's mock registry
//   for the whole run so assertions/reset can reach them — 7 spies × STREAM_
//   COUNT sinks × N cycles, none collectable. That retention (~800KB per cycle,
//   dwarfing any real signal) was the dominant term in the old gate's "noise
//   floor". This gate asserts no call counts, so plain no-op functions are both
//   faithful and free of the spy-registry artifact. [FRAMING:representation] —
//   the instrumentation must not manufacture the floor it then measures.
//
// Status: GREEN as of tmux-test-gates-e33.3.1.

// @vitest-environment happy-dom

import { describe, it, expect, vi } from "vitest";
import { FakeTmuxClient } from "../../src/bench/index.js";
import { PaneStream } from "../../src/stream/index.js";

// Plain-function xterm mock. No vi.fn — see the header note on the spy-registry
// artifact. Every method is a no-op; the gate asserts dispose reclaim, not any
// call to the terminal.
vi.mock("@xterm/xterm", () => {
  const noop = (): void => undefined;
  class TerminalMock {
    options: { fontSize: number; theme: object; [k: string]: unknown };
    open = noop;
    write = noop;
    resize = noop;
    clear = noop;
    dispose = noop;
    focus = noop;
    scrollToBottom = noop;
    onData = (): { dispose: () => void } => ({ dispose: noop });
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

// Per-CYCLE net-retention budget. Measured no-leak MIN is single-digit KB; a
// forgotten XtermSink listener (retains the terminal+DOM+observer graph) floors
// at ~100KB. 64KB sits ~10× above no-leak noise and well below the leak floor —
// a wide, stable gap in both directions.
const RECLAIM_BUDGET_BYTES = 64 * 1024;
const STREAM_COUNT = 24;
// Independent construct/dispose cycles. MIN across these reads the best-case GC
// settle: with no leak at least one cycle reclaims to baseline; a heavy leak
// floors every cycle high. More cycles = more chances to settle low, so this is
// the false-positive safety margin.
const CYCLES = 24;
// Macrotask ticks drained per cycle. FakeTmuxClient's subscribe/unsubscribe/
// execute acks resolve on setTimeout(0); a handful of ticks flushes the whole
// per-cycle backlog (empirically settles no-leak MIN to single-digit KB).
const DRAIN_TICKS = 8;

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

const tick = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

async function drain(): Promise<void> {
  for (let i = 0; i < DRAIN_TICKS; i++) await tick();
}

// One construct → burst → dispose cycle. A leak means one of these dispose
// calls forgets a cleanup and the instance graph survives the return. The
// persistent retaining root for XtermSink's observer/listener leaks is the
// global `document`, so a forgotten removeEventListener/observer.disconnect
// accumulates across cycles regardless of the (per-cycle) client.
function runCycle(): void {
  const client = new FakeTmuxClient();
  const containers: HTMLElement[] = [];
  const sinks: XtermSink[] = [];
  const streams: PaneStream[] = [];
  for (let i = 0; i < STREAM_COUNT; i++) {
    const container = makeContainer();
    const sink = new XtermSink({ container });
    const stream = new PaneStream({
      client,
      paneId: i + 1,
    });
    stream.attach(sink);
    containers.push(container);
    sinks.push(sink);
    streams.push(stream);
  }

  // Drive a small burst so the activity-counter timer path is exercised before
  // disposal — a leak there would otherwise hide behind the "we never produced
  // a flush callback" path.
  const burst = new Uint8Array([0x41, 0x42, 0x43]);
  for (let i = 0; i < STREAM_COUNT; i++) client.injectOutput(i + 1, burst);

  // Tear down. Disposing the stream first matches the consumer-side contract
  // (PaneStream owns the byte handlers; XtermSink owns the DOM).
  for (const stream of streams) stream.dispose();
  for (const sink of sinks) sink.dispose();
  for (const container of containers) container.remove();
}

describe("Gate 6 — dispose() reclaim", () => {
  const gc = getGc();

  it.skipIf(gc === null)(
    `MIN net heap retained across ${CYCLES} construct/dispose cycles is within ${RECLAIM_BUDGET_BYTES}B`,
    async () => {
      const runGc = gc!;

      // Warm up: prime module-scope caches (font cache, xterm internals as
      // mocked) and flush construction timers so cycle 1 is not an outlier.
      runCycle();
      await drain();

      const deltas: number[] = [];
      for (let c = 0; c < CYCLES; c++) {
        // Fresh baseline per cycle: this cycle's delta reflects only this
        // cycle's net retention, so a leak reads its per-cycle cost every
        // iteration instead of being averaged away by early low cycles.
        runGc();
        runGc();
        const before = process.memoryUsage().heapUsed;

        runCycle();
        // Flush FakeTmuxClient's setTimeout-scheduled acks so the measurement
        // sees steady state, not the harness's pending-timer backlog.
        await drain();

        runGc();
        runGc();
        deltas.push(process.memoryUsage().heapUsed - before);
      }

      // MIN reads the best-case GC settle. No leak ⇒ at least one cycle
      // reclaims to baseline ⇒ MIN small. Heavy leak ⇒ every cycle floors high
      // ⇒ MIN high. This is the signal/noise separation the single-delta gate
      // lacked.
      const minDelta = Math.min(...deltas);
      const maxDelta = Math.max(...deltas);
      expect(
        minDelta,
        `MIN net retention ${minDelta}B across ${CYCLES} cycles ` +
          `(MAX ${maxDelta}B, budget ${RECLAIM_BUDGET_BYTES}B). ` +
          `A MIN above budget means EVERY cycle retained — likely a retained ` +
          `listener/observer/timer in PaneStream or XtermSink dispose().`,
      ).toBeLessThanOrEqual(RECLAIM_BUDGET_BYTES);
    },
    // Async now (drains macrotasks each cycle). ~1s locally; generous headroom
    // for a slow CI runner so a scheduling stall can't time-out the gate.
    30_000,
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
