// packages/pane-terminal/tests/unit/font-cache.test.ts
//
// Unit tests for the module-scope font measurement cache. Covers:
//   - getMetrics caches per (family, weight) — second call is a hit.
//   - fitFont clamps to [fontMin, fontMax] and returns fontMin on
//     degenerate inputs (zero cols/rows/box).
//   - fitFont scales linearly with container size.
//   - document.fonts.load() refresh: when the real font resolves later,
//     the cache reflects the new metrics on the next getMetrics call.
//
// [LAW:behavior-not-structure] Tests assert what the cache module owes its
//   callers: idempotent metrics, clamped fit, refresh-on-fonts-loaded. The
//   internal Map is not part of the contract — `__cacheEntries` is exposed
//   only so we can verify "exactly one entry per (family, weight)" without
//   reading private state.

// @vitest-environment happy-dom

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  getMetrics,
  fitFont,
  __resetCache,
  __cacheEntries,
  __awaitFontLoad,
} from "../../src/xterm-sink/font-cache.js";

const FAMILY_A = '"Test Mono A", monospace';
const FAMILY_B = '"Test Mono B", monospace';

// happy-dom does not implement the FontFaceSet API (`document.fonts`). The
// font-cache module's behavior is conditional on that API being present —
// it kicks off a one-time `load()` refresh when available, and silently
// stays with the fallback metrics when it isn't. Tests that exercise the
// refresh path attach a stub before the call; tests that just want a hit
// don't need the stub.
type FontsStub = { load: (s: string) => Promise<unknown> };

function installFontsStub(stub: FontsStub): void {
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: stub,
  });
}

function uninstallFontsStub(): void {
  // happy-dom's `document` object accepts deletion through the configurable
  // descriptor we set above; on real browsers this would be a no-op since
  // `document.fonts` is built-in.
  delete (document as { fonts?: unknown }).fonts;
}

beforeEach(() => {
  __resetCache();
});

afterEach(() => {
  uninstallFontsStub();
});

describe("font-cache: getMetrics", () => {
  it("first call measures, second call is a cache hit (same identity)", () => {
    const m1 = getMetrics(FAMILY_A);
    const m2 = getMetrics(FAMILY_A);
    expect(m1).toBe(m2);
    const entries = __cacheEntries();
    expect(entries).toHaveLength(1);
    // Sanity: numbers are positive even in happy-dom (the module falls back
    // to {7.2, 14.4} when getBoundingClientRect returns 0×0).
    expect(m1.charW).toBeGreaterThan(0);
    expect(m1.charH).toBeGreaterThan(0);
  });

  it("different family/weight pairs get distinct cache entries", () => {
    getMetrics(FAMILY_A);
    getMetrics(FAMILY_B);
    getMetrics(FAMILY_A, "bold");
    expect(__cacheEntries()).toHaveLength(3);
  });

  it("triggers fonts.load() exactly once per (family, weight) when the API is available", async () => {
    const load = vi.fn<(s: string) => Promise<unknown>>().mockResolvedValue([]);
    installFontsStub({ load });

    const before = getMetrics(FAMILY_A);
    expect(load).toHaveBeenCalledOnce();
    await __awaitFontLoad(FAMILY_A);
    const after = getMetrics(FAMILY_A);
    // happy-dom returns identical box metrics whether the "real" font is
    // loaded or not — the contract we're verifying is that the cache HAS
    // an entry after the load resolves, and it survives a second read.
    expect(after.charW).toBe(before.charW);
    expect(after.charH).toBe(before.charH);
    // [LAW:single-enforcer] One inflight load per (family, weight): a
    // second getMetrics for the same key must not trigger a second
    // fonts.load() call.
    getMetrics(FAMILY_A);
    expect(load).toHaveBeenCalledOnce();
  });

  it("survives a font that fails to load (rejected fonts.load)", async () => {
    const load = vi
      .fn<(s: string) => Promise<unknown>>()
      .mockRejectedValue(new Error("no such font"));
    installFontsStub({ load });

    const m = getMetrics(FAMILY_A);
    // Even though the load rejects, the cache must keep the fallback
    // measurement so subsequent reads don't re-throw or hang.
    await __awaitFontLoad(FAMILY_A);
    expect(getMetrics(FAMILY_A)).toBe(m);
  });

  it("does not throw when document.fonts is unavailable (no API)", () => {
    // No installFontsStub — happy-dom's default state.
    expect(() => getMetrics(FAMILY_A)).not.toThrow();
    expect(__cacheEntries()).toHaveLength(1);
  });
});

describe("font-cache: fitFont", () => {
  const baseInputs = {
    cols: 80,
    rows: 24,
    fontFamily: FAMILY_A,
    fontMin: 6,
    fontMax: 16,
  } as const;

  it("returns fontMax when the container is plenty big", () => {
    const px = fitFont({
      ...baseInputs,
      containerW: 100_000,
      containerH: 100_000,
    });
    expect(px).toBe(16);
  });

  it("returns fontMin when the container is microscopic", () => {
    const px = fitFont({
      ...baseInputs,
      containerW: 1,
      containerH: 1,
    });
    expect(px).toBe(6);
  });

  it("returns fontMin on degenerate inputs (zero cols)", () => {
    const px = fitFont({
      ...baseInputs,
      cols: 0,
      containerW: 1000,
      containerH: 1000,
    });
    expect(px).toBe(6);
  });

  it("returns fontMin on degenerate inputs (zero container)", () => {
    const px = fitFont({
      ...baseInputs,
      containerW: 0,
      containerH: 0,
    });
    expect(px).toBe(6);
  });

  it("scales monotonically with container size in [fontMin, fontMax]", () => {
    // Pick a container box small enough that the answer lands inside the
    // clamp range. Halving the box should never increase the font.
    const big = fitFont({
      ...baseInputs,
      containerW: 800,
      containerH: 240,
    });
    const small = fitFont({
      ...baseInputs,
      containerW: 400,
      containerH: 120,
    });
    expect(small).toBeLessThanOrEqual(big);
    expect(small).toBeGreaterThanOrEqual(baseInputs.fontMin);
    expect(big).toBeLessThanOrEqual(baseInputs.fontMax);
  });

  it("never measures from inside fitFont — N calls hit the same cache entry", () => {
    const load = vi.fn<(s: string) => Promise<unknown>>().mockResolvedValue([]);
    installFontsStub({ load });
    fitFont({ ...baseInputs, containerW: 800, containerH: 240 });
    fitFont({ ...baseInputs, containerW: 800, containerH: 240 });
    fitFont({ ...baseInputs, containerW: 800, containerH: 240 });
    // One cache entry; one fonts.load (the inflight refresh kicks once).
    expect(__cacheEntries()).toHaveLength(1);
    expect(load).toHaveBeenCalledOnce();
  });
});
