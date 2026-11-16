// Cell sizes measured the way xterm.js 5.5 measures them, through a stub
// window: an OffscreenCanvas whose "W" is 0.6em wide and 1.2em tall, a device
// pixel ratio, a `document.fonts` and a resolution media query the test fires.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createCellMeasure,
  type CellFont,
} from "../../../src/window-terminal/sizing/cell-metrics.js";

const measured: string[] = [];
let charScale = { width: 0.6, height: 1.2 };

class FakeOffscreenCanvas {
  getContext() {
    return {
      font: "",
      measureText(text: string) {
        measured.push(`${this.font}|${text}`);
        const px = Number.parseFloat(this.font);
        return {
          width: px * charScale.width,
          fontBoundingBoxAscent: px,
          fontBoundingBoxDescent: px * (charScale.height - 1),
        };
      },
    };
  }
}

interface StubWindow {
  win: Window;
  fonts: EventTarget;
  setDpr(dpr: number): void;
  queries: { media: string; listeners: number }[];
}

function stubWindow(dpr: number): StubWindow {
  const fonts = new EventTarget();
  const queries: StubWindow["queries"] = [];
  const mqls: (EventTarget & { media: string })[] = [];
  let ratio = dpr;
  const win = {
    get devicePixelRatio() {
      return ratio;
    },
    document: { fonts },
    matchMedia(media: string) {
      const entry = { media, listeners: 0 };
      queries.push(entry);
      const t = new EventTarget() as EventTarget & { media: string };
      t.media = media;
      const add = t.addEventListener.bind(t);
      const remove = t.removeEventListener.bind(t);
      t.addEventListener = (
        ...a: Parameters<EventTarget["addEventListener"]>
      ) => {
        entry.listeners += 1;
        add(...a);
      };
      t.removeEventListener = (
        ...a: Parameters<EventTarget["removeEventListener"]>
      ) => {
        entry.listeners -= 1;
        remove(...a);
      };
      mqls.push(t);
      return t;
    },
  } as unknown as Window;
  return {
    win,
    fonts,
    queries,
    setDpr(next) {
      ratio = next;
      mqls.at(-1)?.dispatchEvent(new Event("change"));
    },
  };
}

beforeEach(() => {
  measured.length = 0;
  charScale = { width: 0.6, height: 1.2 };
  vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const font = (
  fontFamily: string,
  lineHeight: number,
  letterSpacing = 0,
): CellFont => ({ fontFamily, lineHeight, letterSpacing });

describe("createCellMeasure", () => {
  it("letter spacing widens the cell by its whole device pixels, as xterm draws it", () => {
    const { win } = stubWindow(2);
    const m = createCellMeasure(win);
    // 10px: char 6 wide, 12 device px; +round(1.4) = 13 device px, / 2.
    expect(m.cellAt(font("Mono", 1, 1.4))(10).width).toBe(6.5);
    // -round(-2.6) = -3: 9 device px.
    expect(m.cellAt(font("Mono", 1, -2.6))(10).width).toBe(4.5);
    m.dispose();
  });

  it("cell width is the char width; height rounds the char height up to device pixels, then scales by line height", () => {
    const { win } = stubWindow(2);
    const m = createCellMeasure(win);
    // 10px: char 6 x 12. dpr 2: ceil(24) = 24, x1.25 = 30, floor 30 / 2 = 15.
    expect(m.cellAt(font("Mono", 1.25))(10)).toEqual({ width: 6, height: 15 });
    // 13px: char 7.8 x 15.6. ceil(31.2) = 32, x1 = 32, / 2 = 16.
    expect(m.cellAt(font("Mono", 1))(13)).toEqual({ width: 7.8, height: 16 });
    m.dispose();
  });

  it("measures each font and size once", () => {
    const { win } = stubWindow(1);
    const m = createCellMeasure(win);
    const at = m.cellAt(font("Mono", 1));
    at(12);
    at(12);
    m.cellAt(font("Mono", 1))(12);
    at(14);
    expect(measured).toEqual(["12px Mono|W", "14px Mono|W"]);
    m.dispose();
  });

  it("a font finishing loading measures again and tells every listener", () => {
    const { win, fonts } = stubWindow(1);
    const m = createCellMeasure(win);
    const changed = vi.fn();
    m.onChange(changed);
    expect(m.cellAt(font("Mono", 1))(10).width).toBe(6);
    charScale = { width: 0.5, height: 1.2 };
    fonts.dispatchEvent(new Event("loadingdone"));
    expect(changed).toHaveBeenCalledOnce();
    expect(m.cellAt(font("Mono", 1))(10).width).toBe(5);
    m.dispose();
  });

  it("a device pixel ratio change measures at the new ratio and watches for the next one", () => {
    const stub = stubWindow(1);
    const m = createCellMeasure(stub.win);
    const changed = vi.fn();
    m.onChange(changed);
    expect(m.cellAt(font("Mono", 1))(13).height).toBe(16); // ceil(15.6)
    stub.setDpr(2);
    expect(changed).toHaveBeenCalledOnce();
    expect(m.cellAt(font("Mono", 1))(13).height).toBe(16); // ceil(31.2) / 2
    expect(stub.queries.map((q) => [q.media, q.listeners])).toEqual([
      ["(resolution: 1dppx)", 0],
      ["(resolution: 2dppx)", 1],
    ]);
    m.dispose();
    expect(stub.queries.at(-1)?.listeners).toBe(0);
  });

  it("a font that measures to nothing throws instead of guessing a size", () => {
    const { win } = stubWindow(1);
    charScale = { width: 0, height: 0 };
    const m = createCellMeasure(win);
    expect(() => m.cellAt(font("Missing", 1))(12)).toThrow(
      /cannot measure 12px Missing/,
    );
    m.dispose();
  });

  it("after dispose, no change reaches a listener", () => {
    const { win, fonts } = stubWindow(1);
    const m = createCellMeasure(win);
    const changed = vi.fn();
    m.onChange(changed);
    m.dispose();
    fonts.dispatchEvent(new Event("loadingdone"));
    expect(changed).not.toHaveBeenCalled();
  });
});
