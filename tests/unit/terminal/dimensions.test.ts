// tests/unit/terminal/dimensions.test.ts
// @vitest-environment happy-dom
//
// Unit tests for the renderer-agnostic dimensions math at
// src/terminal/dimensions.ts. The pure pair (`pixelsToGrid` /
// `gridToPixels`) gets exhaustive round-trip coverage; `measureCell`
// gets a happy-dom smoke run that asserts the probe is removed and the
// returned metrics are positive — happy-dom approximates layout enough
// to prove the function executes end-to-end without throwing.

import {
  measureCell,
  pixelsToGrid,
  gridToPixels,
  type CellMetrics,
  type FontSpec,
} from "../../../src/terminal/dimensions.js";

describe("pixelsToGrid / gridToPixels", () => {
  it("rounds toward zero and clamps to ≥1 on each axis", () => {
    const cell: CellMetrics = { cellWidthPx: 7.2, cellHeightPx: 14.4 };
    expect(pixelsToGrid({ widthPx: 800, heightPx: 600 }, cell)).toEqual({
      cols: 111, // floor(800 / 7.2) === 111
      rows: 41, // floor(600 / 14.4) === 41
    });
    expect(pixelsToGrid({ widthPx: 0, heightPx: 0 }, cell)).toEqual({
      cols: 1,
      rows: 1,
    });
  });

  it("gridToPixels is exact (no rounding)", () => {
    const cell: CellMetrics = { cellWidthPx: 7.2, cellHeightPx: 14.4 };
    expect(gridToPixels({ cols: 80, rows: 24 }, cell)).toEqual({
      widthPx: 576, // 80 * 7.2
      heightPx: 345.6, // 24 * 14.4
    });
  });

  it("round-trip pixels → grid → pixels never overflows the original", () => {
    const cell: CellMetrics = { cellWidthPx: 7.2, cellHeightPx: 14.4 };
    const cases: Array<{ widthPx: number; heightPx: number }> = [
      { widthPx: 800, heightPx: 600 },
      { widthPx: 1024, heightPx: 768 },
      { widthPx: 1920, heightPx: 1080 },
      { widthPx: 7.2, heightPx: 14.4 }, // exactly one cell
      { widthPx: 7.5, heightPx: 14.5 }, // sub-cell remainder
    ];
    for (const px of cases) {
      const grid = pixelsToGrid(px, cell);
      const px2 = gridToPixels(grid, cell);
      // Inverse is bounded by one cell on each axis (the floor's slack).
      const dx = px.widthPx - px2.widthPx;
      const dy = px.heightPx - px2.heightPx;
      expect(dx).toBeGreaterThanOrEqual(0);
      expect(dx).toBeLessThan(cell.cellWidthPx);
      expect(dy).toBeGreaterThanOrEqual(0);
      expect(dy).toBeLessThan(cell.cellHeightPx);
    }
  });
});

describe("measureCell", () => {
  const FONT: FontSpec = { family: "monospace", sizePx: 12 };

  // happy-dom does not perform real layout, so `getBoundingClientRect`
  // returns zeros by default. Stub it on the prototype with a synthetic
  // rect proportional to the probe's text length so the helper sees
  // realistic measurements (~7.2 px per glyph at 12 px font, line-height
  // 1.2 → 14.4 px row).
  beforeEach(() => {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
      function (this: Element) {
        const text = this.textContent ?? "";
        const width = text.length * 7.2;
        return {
          x: 0,
          y: 0,
          width,
          height: 14.4,
          top: 0,
          left: 0,
          right: width,
          bottom: 14.4,
          toJSON: () => ({}),
        } as DOMRect;
      },
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns positive cell metrics under a DOM", () => {
    const metrics = measureCell(FONT);
    expect(metrics.cellWidthPx).toBeCloseTo(7.2, 5);
    expect(metrics.cellHeightPx).toBeCloseTo(14.4, 5);
  });

  it("removes the probe element after measuring", () => {
    const before = document.body.children.length;
    measureCell(FONT);
    expect(document.body.children.length).toBe(before);
  });

  it("removes the probe even when getBoundingClientRect throws", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const realCreate = host.ownerDocument.createElement.bind(
      host.ownerDocument,
    );
    const spy = vi
      .spyOn(host.ownerDocument, "createElement")
      .mockImplementationOnce((tag: string) => {
        const el = realCreate(tag);
        Object.defineProperty(el, "getBoundingClientRect", {
          value: () => {
            throw new Error("boom");
          },
        });
        return el;
      });
    expect(() => measureCell(FONT, host)).toThrow("boom");
    expect(host.children.length).toBe(0);
    spy.mockRestore();
    document.body.removeChild(host);
  });

  it("appends to the supplied host (not document.body)", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    let probeWasInsideHost = false;
    const realAppend = host.appendChild.bind(host);
    const appendSpy = vi
      .spyOn(host, "appendChild")
      .mockImplementation((child: Node) => {
        probeWasInsideHost = true;
        return realAppend(child);
      });
    measureCell({ family: "monospace", sizePx: 12 }, host);
    expect(probeWasInsideHost).toBe(true);
    appendSpy.mockRestore();
    document.body.removeChild(host);
  });

  it("round-trips with pixelsToGrid / gridToPixels within one cell", () => {
    const cell = measureCell(FONT);
    const px = { widthPx: 800, heightPx: 600 };
    const grid = pixelsToGrid(px, cell);
    const px2 = gridToPixels(grid, cell);
    expect(px.widthPx - px2.widthPx).toBeGreaterThanOrEqual(0);
    expect(px.widthPx - px2.widthPx).toBeLessThan(cell.cellWidthPx);
    expect(px.heightPx - px2.heightPx).toBeGreaterThanOrEqual(0);
    expect(px.heightPx - px2.heightPx).toBeLessThan(cell.cellHeightPx);
  });
});
