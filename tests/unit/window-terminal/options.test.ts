import { describe, it, expect } from "vitest";
import {
  parseSizing,
  parseHistory,
  type Sizing,
} from "../../../src/window-terminal/options.js";
import {
  parseWindowId,
  parsePaneId,
} from "../../../src/window-terminal/ids.js";

describe("parseSizing", () => {
  it("resolves a single font to a one-size range and defaults the floors to 1", () => {
    expect(parseSizing({ window: "box", font: 14 })).toEqual({
      window: "box",
      font: { min: 14, max: 14 },
      minCols: 1,
      minRows: 1,
    });
  });

  it("resolves the phone example", () => {
    expect(
      parseSizing({ window: "box", font: { min: 10, max: 16 }, minCols: 80 }),
    ).toEqual({
      window: "box",
      font: { min: 10, max: 16 },
      minCols: 80,
      minRows: 1,
    });
  });

  it("resolves each fit to the axes it fits", () => {
    const fit = (f: "width" | "height" | "both" | "none") => {
      const r = parseSizing({ window: "tmux", font: 12, fit: f });
      return r.window === "tmux" ? r.fit : null;
    };
    expect(fit("width")).toEqual({ width: true, height: false });
    expect(fit("height")).toEqual({ width: false, height: true });
    expect(fit("both")).toEqual({ width: true, height: true });
    expect(fit("none")).toEqual({ width: false, height: false });
  });

  const bad: [string, Sizing][] = [
    ["font below 1", { window: "box", font: 0 }],
    ["fractional font", { window: "box", font: 13.5 }],
    ["min above max", { window: "box", font: { min: 18, max: 11 } }],
    [
      "fractional range end",
      { window: "tmux", font: { min: 10, max: 15.5 }, fit: "both" },
    ],
    ["floor 0", { window: "box", font: 14, minCols: 0 }],
    ["floor above 10000", { window: "box", font: 14, minRows: 10001 }],
    ["fractional floor", { window: "box", font: 14, minCols: 79.5 }],
    ["unknown fit", { window: "tmux", font: 14, fit: "cover" as "both" }],
    ["unknown window", { window: "page" as "box", font: 14 }],
  ];
  it.each(bad)("throws RangeError for %s", (_what, sizing) => {
    expect(() => parseSizing(sizing)).toThrow(RangeError);
  });
});

describe("parseHistory", () => {
  it("defaults to tmux's default history-limit", () => {
    expect(parseHistory(undefined)).toBe(2000);
  });
  it("accepts 0", () => {
    expect(parseHistory(0)).toBe(0);
  });
  it.each([-1, 1.5, NaN])("throws RangeError for %s", (n) => {
    expect(() => parseHistory(n)).toThrow(RangeError);
  });
});

describe("ids", () => {
  it("parses tmux ids", () => {
    expect(parseWindowId("@3")).toBe("@3");
    expect(parsePaneId("%0")).toBe("%0");
  });
  it.each([
    "3",
    "%3",
    "@",
    "@03",
    "@-1",
    "@1.5",
    " @1",
    "@99999999999999999999",
  ])("rejects %j as a window id", (raw) => {
    expect(() => parseWindowId(raw)).toThrow(RangeError);
  });
  it("rejects a window id where a pane id is wanted", () => {
    expect(() => parsePaneId("@1")).toThrow(RangeError);
  });
  it("rejects a non-string", () => {
    expect(() => parseWindowId(3)).toThrow(RangeError);
  });
});
