// src/chaos/index.ts
// Public entry for the chaos transport decorator — a fuzzing/resilience harness
// over the control-mode wire.
//
// [LAW:one-source-of-truth] Re-exports only. Pure (no Node deps): TmuxTransport
// is a type-only import erased at runtime, and the timing effect is an injected
// ChaosClock — so the same build runs in Node tests and the browser tutorial.

export { withChaos, planChunk, ManualClock } from "./transport.js";
export type {
  ChaosOptions,
  ChaosClock,
  ChaosPlan,
  LatencyWindow,
} from "./transport.js";

export { corruptChunk, ALL_CORRUPTIONS } from "./corrupt.js";
export type { CorruptionKind } from "./corrupt.js";

export { mulberry32, randomInt } from "./rng.js";
