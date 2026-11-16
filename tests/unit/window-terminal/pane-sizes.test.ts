// tests/unit/window-terminal/pane-sizes.test.ts
//
// The pane-size report's parser. Lifecycle and fan-out are asserted through
// `PaneStream` in pane-stream.test.ts.

import { describe, it, expect } from "vitest";
import { parsePaneSizes } from "../../../src/window-terminal/engine/pane-sizes.js";

describe("parsePaneSizes", () => {
  it("reads every pane's width;height", () => {
    expect(parsePaneSizes("%0=100;30,%12=80;24,")).toEqual(
      new Map([
        [0, { cols: 100, rows: 30 }],
        [12, { cols: 80, rows: 24 }],
      ]),
    );
  });

  it("takes a pane repeated by a linked window once", () => {
    expect(parsePaneSizes("%3=90;20,%4=10;5,%3=90;20,")).toEqual(
      new Map([
        [3, { cols: 90, rows: 20 }],
        [4, { cols: 10, rows: 5 }],
      ]),
    );
  });

  it("reads a server with no panes as no sizes", () => {
    expect(parsePaneSizes("")).toEqual(new Map());
  });

  it("is no report unless every entry is a pane id and a decimal width;height", () => {
    for (const value of [
      "%1=80;24", // unterminated
      "%1=0x50;24,",
      "%1=1e2;24,",
      "%1=80;24;1,",
      "%1=80;0,",
      "%1= 80;24,",
      "1=80;24,",
      "%01=80;24,",
      "%1=80;24,garbage,",
    ]) {
      expect(parsePaneSizes(value), value).toBeNull();
    }
  });
});
