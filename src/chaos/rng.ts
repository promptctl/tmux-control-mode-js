// src/chaos/rng.ts
// A seeded, deterministic pseudo-random generator. Pure TypeScript — no Node.js
// deps, no `Math.random()`, no clock. Same seed → same sequence, forever.
//
// This is the keystone of the chaos harness: chaos that cannot be reproduced is
// useless as a fuzzer, because a failure you cannot replay is a failure you
// cannot fix. By seeding every perturbation decision from this generator, a
// chaotic run is a *pure function of its seed* — note the seed, replay the bug.
// [LAW:no-ambient-temporal-coupling] randomness is an owned, injected value
// stream, never an ambient draw from the platform.

/**
 * mulberry32 — a tiny, fast, well-distributed 32-bit PRNG. Returns a generator
 * producing floats in `[0, 1)`. Chosen for being self-contained (no state object
 * to thread, no Node `crypto`) so the whole chaos layer stays browser-safe and
 * pure.
 *
 * The arithmetic is the canonical mulberry32 step; the only contract callers
 * depend on is determinism: `mulberry32(s)` and a second `mulberry32(s)` yield
 * identical sequences.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Inclusive-low, exclusive-high integer draw: `[lo, hi)`. `lo` when `hi <= lo`. */
export function randomInt(
  random: () => number,
  lo: number,
  hi: number,
): number {
  if (hi <= lo) return lo;
  return lo + Math.floor(random() * (hi - lo));
}
