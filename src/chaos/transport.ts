// src/chaos/transport.ts
// withChaos — a transport DECORATOR that perturbs the inbound control-mode
// stream: it drops, corrupts, and delays the chunks a wrapped transport hands
// the client, so the parser and command state machine are exercised against a
// lossy, hostile wire. It wraps ANY TmuxTransport — the in-process MockTmuxServer
// (deterministic fuzzing in tests/the browser) or a real `spawnTmux` (chaos over
// live tmux) — because it speaks only the transport interface.
//
// [LAW:decomposition] Two parts, cut clean:
//   - DECISION (planChunk, pure): given a chunk and the seeded generator, decide
//     drop / corrupt / how long to delay. A pure function of its inputs — the
//     whole reason a chaotic run is reproducible from its seed.
//   - ACTING (withChaos): subscribe to the inner transport, run the decision,
//     then either drop the chunk or hand it to the ChaosClock for delivery. The
//     only effects (timing, fan-out to consumers) live here, at the boundary.
//   [LAW:effects-at-boundaries]
//
// Chaos is INBOUND-ONLY (server→client). `send`/`onClose`/`close` pass straight
// through: dropping a client command would desync the mock's command FIFO from
// the client's pending-promise FIFO — a transport-correlation failure, not the
// parser/state-machine stress this ticket is about. Outbound chaos is a separate
// concern and deliberately out of scope. [LAW:decomposition]

import type { TmuxTransport } from "../transport/types.js";
import { mulberry32 } from "./rng.js";
import {
  corruptChunk,
  ALL_CORRUPTIONS,
  type CorruptionKind,
} from "./corrupt.js";

// ---------------------------------------------------------------------------
// Timing boundary — the one owned effect
// ---------------------------------------------------------------------------

/**
 * The scheduler chaos uses to realise latency. Injecting it keeps `withChaos`
 * free of ambient timing: production passes nothing (a real `setTimeout` clock),
 * tests pass a {@link ManualClock} and advance time by hand so delayed/reordered
 * delivery is deterministic and assertable. [LAW:no-ambient-temporal-coupling]
 */
export interface ChaosClock {
  /** Run `fn` after `delayMs` of this clock's time has elapsed. */
  schedule(fn: () => void, delayMs: number): void;
}

const realClock: ChaosClock = {
  schedule: (fn, delayMs) => {
    setTimeout(fn, delayMs);
  },
};

/**
 * A deterministic, hand-advanced {@link ChaosClock}. Callbacks fire only when
 * {@link advance} (or {@link runAll}) carries virtual time past their due point,
 * and ties fire in scheduling order — so reordering produced by jittered latency
 * (a later chunk with a shorter delay overtaking an earlier one) is exactly
 * reproducible. The owner of time, made explicit. [LAW:no-shared-mutable-globals]
 */
export class ManualClock implements ChaosClock {
  private now = 0;
  private seq = 0;
  private readonly queue: { dueAt: number; seq: number; fn: () => void }[] = [];

  schedule(fn: () => void, delayMs: number): void {
    this.queue.push({
      dueAt: this.now + Math.max(0, delayMs),
      seq: this.seq++,
      fn,
    });
  }

  /** Number of callbacks still waiting to fire. */
  get pending(): number {
    return this.queue.length;
  }

  /**
   * Advance virtual time by `ms`, firing every callback that comes due — in
   * (dueAt, then scheduling-order) order. Callbacks scheduled DURING this call
   * (e.g. delivery driving the client to send a command, prompting more inbound
   * chunks) are honoured if they come due within the window, so a synchronous
   * request/response settles in one `advance`.
   */
  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      const next = this.earliestDue(target);
      if (next === undefined) break;
      this.now = Math.max(this.now, next.dueAt);
      this.remove(next);
      next.fn();
    }
    this.now = Math.max(this.now, target);
  }

  /** Fire all pending callbacks regardless of their due time (drain). */
  runAll(): void {
    for (;;) {
      const next = this.earliestDue(Infinity);
      if (next === undefined) break;
      this.now = Math.max(this.now, next.dueAt);
      this.remove(next);
      next.fn();
    }
  }

  private earliestDue(
    target: number,
  ): { dueAt: number; seq: number; fn: () => void } | undefined {
    let best: { dueAt: number; seq: number; fn: () => void } | undefined;
    for (const item of this.queue) {
      if (item.dueAt > target) continue;
      if (
        best === undefined ||
        item.dueAt < best.dueAt ||
        (item.dueAt === best.dueAt && item.seq < best.seq)
      ) {
        best = item;
      }
    }
    return best;
  }

  private remove(item: { seq: number }): void {
    const idx = this.queue.findIndex((q) => q.seq === item.seq);
    this.queue.splice(idx, 1);
  }
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** A latency window in milliseconds; `min === max` is a fixed delay (no jitter). */
export interface LatencyWindow {
  readonly min: number;
  readonly max: number;
}

/**
 * What chaos to inject. Every field is optional with a benign default (a pass-
 * through transport), so `withChaos(t)` is a no-op you can dial up.
 */
export interface ChaosOptions {
  /** P(an inbound chunk is dropped entirely), in `[0, 1]`. Default `0`. */
  readonly dropRate?: number;
  /** P(an inbound chunk is corrupted before delivery), in `[0, 1]`. Default `0`. */
  readonly corruptRate?: number;
  /** Delivery delay window in ms; jitter within it reorders chunks. Default `{0,0}`. */
  readonly latencyMs?: LatencyWindow;
  /** Which corruptions are in play when a chunk is corrupted. Default: all. */
  readonly corruptions?: readonly CorruptionKind[];
  /** Seed for the built-in generator — note it to replay a run. Default fixed. */
  readonly seed?: number;
  /** Override the generator entirely (takes precedence over `seed`). */
  readonly random?: () => number;
  /** Timing owner. Default: a real `setTimeout` clock. Tests pass {@link ManualClock}. */
  readonly clock?: ChaosClock;
}

/** Default seed — fixed so a bare `withChaos(t, {corruptRate: …})` replays identically. */
const DEFAULT_SEED = 0x9e3779b9;

// ---------------------------------------------------------------------------
// Pure decision core
// ---------------------------------------------------------------------------

/** The decided fate of one chunk — a description the boundary then acts on. */
export type ChaosPlan =
  | { readonly kind: "drop" }
  | {
      readonly kind: "deliver";
      readonly payload: string;
      readonly delayMs: number;
    };

interface PlanParams {
  readonly random: () => number;
  readonly dropRate: number;
  readonly corruptRate: number;
  readonly latency: LatencyWindow;
  readonly kinds: readonly CorruptionKind[];
}

/**
 * Decide what happens to one inbound chunk — pure, total, and ordered so the
 * draw sequence is stable for a given seed (drop check, then corrupt check, then
 * latency). Returns a description; performing it is the boundary's job.
 */
export function planChunk(chunk: string, p: PlanParams): ChaosPlan {
  if (p.random() < p.dropRate) return { kind: "drop" };
  const payload =
    p.random() < p.corruptRate ? corruptChunk(chunk, p.random, p.kinds) : chunk;
  const delayMs = sampleLatency(p.random, p.latency);
  return { kind: "deliver", payload, delayMs };
}

function sampleLatency(random: () => number, w: LatencyWindow): number {
  if (w.max <= w.min) return w.min;
  return Math.round(w.min + random() * (w.max - w.min));
}

// ---------------------------------------------------------------------------
// withChaos — the decorator
// ---------------------------------------------------------------------------

/**
 * Wrap a transport so its inbound stream is perturbed per {@link ChaosOptions}.
 * The returned transport is a drop-in `TmuxTransport`: `new TmuxClient(withChaos(
 * mock, {corruptRate: 0.1}))` runs the whole library against a lossy wire.
 *
 * Zero-latency delivery stays SYNCHRONOUS (the chunk is handed on in the same
 * tick the inner transport produced it), preserving the mock's deterministic
 * ordering; only a positive delay is routed through the {@link ChaosClock}. So
 * drop/corrupt-only chaos needs no clock advancing at all.
 */
export function withChaos(
  inner: TmuxTransport,
  opts: ChaosOptions = {},
): TmuxTransport {
  const random = opts.random ?? mulberry32(opts.seed ?? DEFAULT_SEED);
  const clock = opts.clock ?? realClock;
  const dropRate = validateRate(opts.dropRate ?? 0, "dropRate");
  const corruptRate = validateRate(opts.corruptRate ?? 0, "corruptRate");
  const latency = validateLatency(opts.latencyMs ?? { min: 0, max: 0 });
  const kinds = opts.corruptions ?? ALL_CORRUPTIONS;

  const consumers: ((chunk: string) => void)[] = [];
  const deliver = (payload: string): void => {
    for (const cb of consumers) cb(payload);
  };

  inner.onData((chunk) => {
    const plan = planChunk(chunk, {
      random,
      dropRate,
      corruptRate,
      latency,
      kinds,
    });
    if (plan.kind === "drop") return;
    if (plan.delayMs > 0)
      clock.schedule(() => deliver(plan.payload), plan.delayMs);
    else deliver(plan.payload);
  });

  return {
    send: (command) => inner.send(command),
    onData: (cb) => {
      consumers.push(cb);
    },
    onClose: (cb) => inner.onClose(cb),
    close: () => inner.close(),
  };
}

// [LAW:no-silent-failure] An out-of-range rate or backwards latency window is a
// programming error in the harness setup; fail loudly at construction rather
// than silently clamping (which would quietly change the chaos the author asked
// for, defeating reproducibility).
function validateRate(rate: number, name: string): number {
  if (!(rate >= 0 && rate <= 1)) {
    throw new RangeError(`withChaos: ${name} must be in [0, 1], got ${rate}`);
  }
  return rate;
}

function validateLatency(w: LatencyWindow): LatencyWindow {
  if (!(w.min >= 0) || !(w.max >= w.min)) {
    throw new RangeError(
      `withChaos: latencyMs must satisfy 0 <= min <= max, got {min: ${w.min}, max: ${w.max}}`,
    );
  }
  return w;
}
