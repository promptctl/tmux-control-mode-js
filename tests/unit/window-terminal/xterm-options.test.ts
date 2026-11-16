// The host's xterm.js options: what the checkpoint refuses, when two values
// are the same option, and the writes that move a pane from one set to the
// next.

import { describe, expect, it } from "vitest";
import {
  TERMINAL_OWNED,
  optionWrites,
  parseXtermOptions,
  sameOption,
  type XtermOptions,
} from "../../../src/window-terminal/render/xterm-options.js";

describe("parseXtermOptions", () => {
  it("passes the host's options through, a key given as undefined left out", () => {
    const activate = (): void => undefined;
    expect(
      parseXtermOptions({
        fontFamily: "Iosevka",
        linkHandler: { activate, allowNonHttpProtocols: true },
        theme: undefined,
      }),
    ).toEqual({
      fontFamily: "Iosevka",
      linkHandler: { activate, allowNonHttpProtocols: true },
    });
    expect(parseXtermOptions(undefined)).toEqual({});
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
    ["lineHeight", Number.NaN],
    ["scrollSensitivity", 0],
    ["fastScrollSensitivity", -1],
  ])("refuses %s %s, which xterm's setter would throw on", (key, value) => {
    expect(() => parseXtermOptions({ [key]: value } as XtermOptions)).toThrow(
      RangeError,
    );
  });

  it("names the refused value as it was given", () => {
    expect(() => parseXtermOptions({ lineHeight: Number.NaN })).toThrow(
      "xterm.lineHeight must be a number of at least 1; got NaN",
    );
    expect(() =>
      parseXtermOptions({ lineHeight: 10n } as unknown as XtermOptions),
    ).toThrow(
      new RangeError("xterm.lineHeight must be a number of at least 1; got 10"),
    );
  });

  it("accepts the edge of each range", () => {
    expect(() =>
      parseXtermOptions({
        cursorStyle: "underline",
        cursorWidth: 1,
        lineHeight: 1,
        scrollSensitivity: 0.1,
      }),
    ).not.toThrow();
  });
});

describe("sameOption", () => {
  it("plain objects and arrays compare by their contents", () => {
    expect(
      sameOption(
        { background: "#000", extendedAnsi: ["#111"] },
        { background: "#000", extendedAnsi: ["#111"] },
      ),
    ).toBe(true);
    expect(sameOption({ background: "#000" }, { background: "#001" })).toBe(
      false,
    );
    expect(sameOption({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(sameOption({ a: undefined }, { b: undefined })).toBe(false);
    expect(sameOption(["x"], { 0: "x" })).toBe(false);
  });

  it("functions, and objects that are not plain, compare by identity", () => {
    const f = (): void => undefined;
    expect(sameOption({ activate: f }, { activate: f })).toBe(true);
    expect(
      sameOption({ activate: f }, { activate: (): void => undefined }),
    ).toBe(false);
    class Logger {
      constructor(readonly name: string) {}
    }
    expect(sameOption(new Logger("a"), new Logger("a"))).toBe(false);
  });
});

describe("optionWrites", () => {
  const base = { fontFamily: "courier", cursorStyle: "block", theme: {} };

  it("writes each changed option, and an option left out returns to its base", () => {
    expect(
      optionWrites(
        { fontFamily: "Iosevka", cursorStyle: "bar" },
        { fontFamily: "Iosevka", theme: { background: "#000" } },
        base,
      ),
    ).toEqual([
      ["cursorStyle", "block"],
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
