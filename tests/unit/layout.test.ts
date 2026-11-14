// tests/unit/layout.test.ts
// parseWindowLayout against layout strings captured from tmux 3.8's
// %layout-change, with geometry as `list-panes` reported it.

import { describe, expect, it } from "vitest";
import { parseWindowLayout } from "../../src/protocol/layout.js";

// Panes %0 and %3 stacked on the left, %1 and %2 stacked on the right.
const NESTED =
  "1742,80x24,0,0{40x24,0,0[40x12,0,0,0,40x11,0,13,3],39x24,41,0[39x12,41,0,1,39x11,41,13,2]}";

const NESTED_PANES = [
  { paneId: 0, width: 40, height: 12, x: 0, y: 0 },
  { paneId: 3, width: 40, height: 11, x: 0, y: 13 },
  { paneId: 1, width: 39, height: 12, x: 41, y: 0 },
  { paneId: 2, width: 39, height: 11, x: 41, y: 13 },
];

describe("parseWindowLayout", () => {
  it("parses a single pane", () => {
    expect(parseWindowLayout("b260,80x24,0,0,3")).toEqual({
      kind: "parsed",
      panes: [{ paneId: 3, width: 80, height: 24, x: 0, y: 0 }],
    });
  });

  it("parses a left-right split", () => {
    expect(
      parseWindowLayout("8205,80x24,0,0{40x24,0,0,0,39x24,41,0,1}"),
    ).toEqual({
      kind: "parsed",
      panes: [
        { paneId: 0, width: 40, height: 24, x: 0, y: 0 },
        { paneId: 1, width: 39, height: 24, x: 41, y: 0 },
      ],
    });
  });

  it("parses top-bottom splits nested in a left-right split", () => {
    expect(parseWindowLayout(NESTED)).toEqual({
      kind: "parsed",
      panes: NESTED_PANES,
    });
  });

  it("accepts an uppercase checksum, as tmux's layout_parse does", () => {
    expect(parseWindowLayout("B260,80x24,0,0,3")).toMatchObject({
      kind: "parsed",
    });
  });

  it("parses a window with no tiled pane as an empty pane list", () => {
    // tmux 3.8, floating panes only: %layout-change @0 0000, 0000, *
    expect(parseWindowLayout("0000,")).toEqual({ kind: "parsed", panes: [] });
  });

  it("reports hostile nesting as malformed instead of overflowing the stack", () => {
    const depth = 5000;
    const body = "1x1,0,0[".repeat(depth) + "1x1,0,0,0" + "]".repeat(depth);
    expect(parseWindowLayout(`a360,${body}`)).toMatchObject({
      kind: "malformed",
      reason: expect.stringMatching(/nested deeper/),
    });
  });

  it.each([
    ["wrong checksum", "b261,80x24,0,0,3"],
    ["no checksum", "80x24,0,0,3"],
    ["unpadded checksum", "3d,13x100,0,0,0"],
    ["empty string", ""],
    ["JSON layout", '{"V":2,"L":{"t":"p","w":80,"h":24}}'],
  ])("reports %s as malformed", (_label, raw) => {
    expect(parseWindowLayout(raw)).toMatchObject({ kind: "malformed" });
  });

  // Valid checksums, so each case reaches the grammar rather than stopping
  // at the checksum.
  it.each([
    ["leaf without pane id", "c85e,80x24,0,0"],
    ["truncated split", "0311,80x24,0,0{40x24,0,0,0,39x24,41,0,1"],
    ["empty split", "32d2,80x24,0,0{}"],
    ["mismatched brackets", "81e5,80x24,0,0{40x24,0,0,0,39x24,41,0,1]"],
    ["trailing input", "595c,80x24,0,0,3,"],
    ["non-numeric field", "c861,80xab,0,0,3"],
    [
      "number past the safe-integer range",
      "96b0,80x24,0,0,99999999999999999999",
    ],
  ])("reports %s as a grammar failure", (_label, raw) => {
    const result = parseWindowLayout(raw);
    expect(result.kind).toBe("malformed");
    expect(result).not.toMatchObject({
      reason: expect.stringContaining("checksum"),
    });
  });

  it("names the failure in its reason", () => {
    const result = parseWindowLayout("b261,80x24,0,0,3");
    expect(result).toEqual({
      kind: "malformed",
      reason:
        'checksum b261 does not match body (expected b260) in "b261,80x24,0,0,3"',
    });
  });
});
