// The host's xterm.js options at their checkpoint, judged by the real
// xterm.js: what passes, what is refused and how, the font a cell is drawn
// in, and the writes that move a pane from one set to the next.

// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_FONT_FAMILY,
  optionWrites,
  parseXtermOptions,
  sameOption,
  TERMINAL_OWNED,
  type XtermOptions,
} from "../../../src/window-terminal/render/xterm-options.js";

describe("parseXtermOptions", () => {
  it("passes the host's options through, a key given as undefined left out", () => {
    const activate = vi.fn();
    const parsed = parseXtermOptions({
      fontFamily: "Iosevka",
      linkHandler: { activate, allowNonHttpProtocols: true },
      theme: undefined,
    });
    expect(parsed.given).toEqual({
      fontFamily: "Iosevka",
      linkHandler: { activate, allowNonHttpProtocols: true },
    });
    expect(parseXtermOptions(undefined).given).toEqual({});
  });

  it("the cell font is xterm's, with the host's options over the terminal's defaults", () => {
    expect(parseXtermOptions(undefined).font).toEqual({
      fontFamily: DEFAULT_FONT_FAMILY,
      lineHeight: 1,
      letterSpacing: 0,
    });
    expect(
      parseXtermOptions({
        fontFamily: "Iosevka",
        lineHeight: 1.2,
        letterSpacing: 1,
      }).font,
    ).toEqual({ fontFamily: "Iosevka", lineHeight: 1.2, letterSpacing: 1 });
  });

  it.each(TERMINAL_OWNED)("refuses %s, which the terminal sets", (key) => {
    expect(() => parseXtermOptions({ [key]: 1 } as XtermOptions)).toThrow(
      new RangeError(
        `xterm.${key} is set by the window terminal, not the host`,
      ),
    );
  });

  it.each([
    ["cursorStyle", "beam"],
    ["cursorWidth", 0],
    ["lineHeight", 0.9],
    ["scrollSensitivity", 0],
    ["fastScrollSensitivity", -1],
  ])("refuses %s %s as xterm does, naming the option", (key, value) => {
    const thrown: unknown = (() => {
      try {
        parseXtermOptions({ [key]: value } as XtermOptions);
      } catch (e) {
        return e;
      }
    })();
    expect(thrown).toBeInstanceOf(RangeError);
    expect((thrown as Error).message).toMatch(new RegExp(`^xterm\\.${key}: `));
    expect((thrown as Error).cause).toBeInstanceOf(Error);
  });

  it("accepts the edge of each range", () => {
    expect(() =>
      parseXtermOptions({
        cursorStyle: "underline",
        cursorWidth: 1,
        lineHeight: 1,
        scrollSensitivity: 0.1,
        fastScrollSensitivity: 0.1,
      }),
    ).not.toThrow();
  });
});

describe("sameOption", () => {
  it("plain objects and arrays compare by their contents", () => {
    expect(sameOption({ background: "#000" }, { background: "#000" })).toBe(
      true,
    );
    expect(sameOption({ a: { b: [1, 2] } }, { a: { b: [1, 2] } })).toBe(true);
    expect(sameOption({ background: "#000" }, { background: "#111" })).toBe(
      false,
    );
    expect(sameOption({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(sameOption([1], { 0: 1 })).toBe(false);
  });

  it("functions, and objects that are not plain, compare by identity", () => {
    const f = (): void => undefined;
    expect(sameOption({ activate: f }, { activate: f })).toBe(true);
    expect(
      sameOption({ activate: () => undefined }, { activate: () => undefined }),
    ).toBe(false);
    expect(sameOption(new Date(0), new Date(0))).toBe(false);
    expect(sameOption(Number.NaN, Number.NaN)).toBe(true);
  });
});

describe("optionWrites", () => {
  const base = { fontFamily: "Base", cursorStyle: "block", theme: {} };

  it("writes each changed option, and an option left out returns to its base", () => {
    expect(
      optionWrites(
        { fontFamily: "Iosevka", cursorStyle: "bar" },
        { cursorStyle: "bar", theme: { background: "#000" } },
        base,
      ),
    ).toEqual([
      ["fontFamily", "Base"],
      ["theme", { background: "#000" }],
    ]);
  });

  it("the same options, in new objects, write nothing", () => {
    expect(
      optionWrites(
        { theme: { background: "#000" } },
        { theme: { background: "#000" } },
        base,
      ),
    ).toEqual([]);
  });
});
