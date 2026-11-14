// packages/pane-terminal/src/xterm-sink/font-cache.ts
//
// Module-scope monospace-character measurement cache keyed by
// `(fontFamily, fontWeight)`. One DOM probe per unique key — every subsequent
// `fitFont()` is pure arithmetic against the cached `(charW, charH)` numbers.
//
// Why module-scope and not per-XtermSink instance: at 24 detached panes the
// per-instance variant burns 24× the layout work for the same answer. The
// cache is the design's O8 made mechanical — a measurement that should
// happen once per (family, weight) on a page.
//
// Why one re-measure on `document.fonts.load(...)`: when the page first
// renders, the requested font may not have arrived yet — `getBoundingClientRect`
// returns the *fallback* font's metrics. Once the real font loads, those
// numbers are stale by exactly one px-per-char. We refresh the cached entry
// once, atomically, when the font's `load()` promise resolves; subsequent
// `getMetrics` calls return the corrected numbers without re-measuring.
//
// [LAW:one-source-of-truth] Every fitFont() in the package reads from this
//   cache. There is no second measurement path.
// [LAW:single-enforcer] The fallback→real-font refresh happens at most once
//   per `(family, weight)` — we track inflight loads in `inflightLoads`.
// [LAW:dataflow-not-control-flow] `fitFont()` is pure arithmetic; the only
//   variability lives in the cached numbers, never in whether measurement runs.

export interface FontMetrics {
  /** Pixels per character width, measured at 12px font size. */
  readonly charW: number;
  /** Pixels per row (line-height = 1.2), measured at 12px font size. */
  readonly charH: number;
}

/**
 * Inputs to the largest-fitting-font calculation. Pure data — no DOM, no
 * xterm. The function is intentionally exported so non-XtermSink consumers
 * (e.g. the toolbar's "Resize to fit" button in the demo) can compute the
 * same answer without instantiating a sink.
 */
export interface FitFontInputs {
  readonly cols: number;
  readonly rows: number;
  readonly containerW: number;
  readonly containerH: number;
  readonly fontFamily: string;
  readonly fontWeight?: string;
  readonly fontMin: number;
  readonly fontMax: number;
}

const PROBE_FONT_SIZE = 12;
const PROBE_LINE_HEIGHT = 1.2;
const PROBE_SAMPLE_COUNT = 100;

type Key = string;

const cache = new Map<Key, FontMetrics>();
const inflightLoads = new Map<Key, Promise<void>>();

function keyFor(family: string, weight: string): Key {
  return `${family}|${weight}`;
}

/**
 * Synchronous measurement of a monospace cell at `PROBE_FONT_SIZE` px.
 * Called at most twice per (family, weight): once on the first cache miss
 * (with whatever font is currently loaded — possibly the fallback), and
 * once after `document.fonts.load(...)` resolves for that family.
 *
 * Falls back to a sensible default when no DOM is available (Node/SSR) so
 * `fitFont()` callers don't have to know about the environment.
 */
function measure(family: string, weight: string): FontMetrics {
  if (typeof document === "undefined" || document.body === null) {
    // Reasonable monospace defaults. These won't match the real font, but
    // they keep the math finite in test/SSR contexts.
    return { charW: 7.2, charH: 14.4 };
  }
  const probe = document.createElement("div");
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  probe.style.fontFamily = family;
  probe.style.fontWeight = weight;
  probe.style.fontSize = `${PROBE_FONT_SIZE}px`;
  probe.style.lineHeight = String(PROBE_LINE_HEIGHT);
  probe.style.whiteSpace = "pre";
  // 100 'M's so subpixel rounding averages out.
  probe.textContent = "M".repeat(PROBE_SAMPLE_COUNT);
  document.body.appendChild(probe);
  const rect = probe.getBoundingClientRect();
  const charW = rect.width / PROBE_SAMPLE_COUNT;
  const charH = rect.height;
  document.body.removeChild(probe);
  // Defensive against zero-width measurements (happy-dom's getBoundingClientRect
  // returns 0×0 when no layout engine is present): fall back to defaults so
  // the arithmetic in fitFont() doesn't divide by zero. This is the trust
  // boundary between "we have a real layout engine" and "we don't".
  if (charW <= 0 || charH <= 0) {
    return { charW: 7.2, charH: 14.4 };
  }
  return { charW, charH };
}

/**
 * Return the cached metrics for `(family, weight)`, measuring on the first
 * call and queuing one font-load refresh in the background. Synchronous —
 * the first call returns whatever was loaded at measurement time; if the
 * real font loads later, the cache is silently corrected and the *next*
 * `getMetrics` call returns the better numbers.
 */
export function getMetrics(family: string, weight = "normal"): FontMetrics {
  const k = keyFor(family, weight);
  const hit = cache.get(k);
  if (hit !== undefined) return hit;

  const measured = measure(family, weight);
  cache.set(k, measured);

  // Kick off a font-load refresh once per key. The inflight Map prevents
  // a flurry of concurrent loads if N panes share a family. Hoisting
  // `document.fonts` into a local before reading `.load` is deliberate:
  // some DOM shims expose `fonts` as a present-but-null property, which
  // would make `typeof fonts.load` throw TypeError on the property
  // access — the `"fonts" in document` test only confirms presence, not
  // value validity. The null check is at a real trust boundary
  // (DOM-API availability across browsers/shims/SSR), not a defensive
  // null guard in the [LAW:no-defensive-null-guards] sense.
  if (!inflightLoads.has(k) && typeof document !== "undefined") {
    const fonts = (document as { fonts?: FontFaceSet | null }).fonts;
    if (fonts != null && typeof fonts.load === "function") {
      const promise = fonts
        .load(`${weight} ${PROBE_FONT_SIZE}px ${family}`)
        .then(() => {
          cache.set(k, measure(family, weight));
        })
        .catch(() => {
          // Font unavailable — keep the fallback metrics. No throw: this
          // is a best-effort refresh, not a contract.
        });
      inflightLoads.set(k, promise as Promise<void>);
    }
  }

  return measured;
}

/**
 * Compute the largest integer font size in `[fontMin, fontMax]` such that
 * `cols × rows` fits inside `containerW × containerH`. Pure arithmetic
 * against the module cache — the only source of variability is the cached
 * `(charW, charH)`, which is a value flowing across one boundary, not a
 * mode the function switches on.
 *
 * Returns the clamped value even when the ideal size is below `fontMin`
 * (the caller decides whether to flag "container is too small for this
 * pane geometry"; this function does not).
 */
export function fitFont(inputs: FitFontInputs): number {
  const { cols, rows, containerW, containerH } = inputs;
  if (cols <= 0 || rows <= 0 || containerW <= 0 || containerH <= 0) {
    return inputs.fontMin;
  }
  const { charW, charH } = getMetrics(inputs.fontFamily, inputs.fontWeight);
  // charW/charH measured at PROBE_FONT_SIZE — px-per-cell scales linearly
  // with font size. Ideal font size is the largest that lets all cols/rows
  // fit on at least one axis.
  const maxByWidth = (containerW / cols) * (PROBE_FONT_SIZE / charW);
  const maxByHeight = (containerH / rows) * (PROBE_FONT_SIZE / charH);
  const ideal = Math.floor(Math.min(maxByWidth, maxByHeight));
  if (ideal < inputs.fontMin) return inputs.fontMin;
  if (ideal > inputs.fontMax) return inputs.fontMax;
  return ideal;
}

// ---------------------------------------------------------------------------
// Test-only entry points
// ---------------------------------------------------------------------------

/**
 * Wipe the module-scope cache. Tests call this in `beforeEach` so each
 * scenario starts from a clean state — production code never invokes this.
 */
export function __resetCache(): void {
  cache.clear();
  inflightLoads.clear();
}

/**
 * Snapshot the cache for assertions. Returns a frozen array of `[key, metrics]`
 * tuples — useful when a test wants to verify "exactly one entry exists for
 * this family", which is the cache-hit-or-miss contract this module owes.
 */
export function __cacheEntries(): readonly (readonly [Key, FontMetrics])[] {
  return Object.freeze(Array.from(cache.entries()));
}

/**
 * Await the inflight font.load() refresh for a given (family, weight) — used
 * by tests that want to assert "after fonts.ready, the cache reflects the
 * real metrics." Returns immediately when no refresh is pending.
 */
export async function __awaitFontLoad(
  family: string,
  weight = "normal",
): Promise<void> {
  const p = inflightLoads.get(keyFor(family, weight));
  if (p === undefined) return;
  await p;
}
