// examples/web-multiplexer/web/inspector-presentation.test.ts
//
// Isolation tests for the Protocol Inspector's presentation policy. Pure:
// a WireEntry in, display data out — no JSX, no MobX. These pin the
// per-direction arrow/color/type/summary mapping, the badge color, the
// payload text, and the duration formatter the view renders verbatim.
// [LAW:behavior-not-structure]

import { describe, it, expect } from "vitest";
import {
  presentFor,
  badgeColor,
  renderPayload,
  formatMs,
} from "./inspector-presentation.ts";
import type { WireEntry } from "./bridge.ts";

const labels = new Map<number, string>([[5, "$0:@1.%5"]]);
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("presentFor — direction → display shape", () => {
  it("presents an outbound execute with its command as summary", () => {
    const w: WireEntry = {
      dir: "out",
      ts: 0,
      msg: { kind: "execute", id: "7", command: "list-panes" },
    };
    const p = presentFor(w, labels);
    expect(p).toMatchObject({
      arrow: "↑",
      type: "execute #7",
      summary: "list-panes",
    });
  });

  it("presents an outbound sendKeys with target + escaped keys", () => {
    const w: WireEntry = {
      dir: "out",
      ts: 0,
      msg: { kind: "sendKeys", id: "8", target: "%5", keys: "a\r" },
    };
    const p = presentFor(w, labels);
    expect(p.type).toBe("sendKeys #8");
    expect(p.summary).toBe("%5  a\\r");
  });

  it("labels payload-less outbound kinds by their own kind, not detach", () => {
    // The type column derives its label from msg.kind, so firehose
    // toggles and detaches each read truthfully with an empty summary —
    // never the old fallthrough that mislabeled everything "detach".
    const cases: WireEntry[] = [
      { dir: "out", ts: 0, msg: { kind: "detach", id: "1" } },
      { dir: "out", ts: 0, msg: { kind: "startFirehose", id: "2" } },
      { dir: "out", ts: 0, msg: { kind: "stopFirehose", id: "3" } },
    ];
    expect(cases.map((w) => presentFor(w, labels).type)).toEqual([
      "detach #1",
      "startFirehose #2",
      "stopFirehose #3",
    ]);
    for (const w of cases) expect(presentFor(w, labels).summary).toBe("");
  });

  it("presents an inbound event via the shared summarizer", () => {
    const w: WireEntry = {
      dir: "in-event",
      ts: 0,
      event: { type: "output", paneId: 5, data: bytes("hi") },
    };
    const p = presentFor(w, labels);
    expect(p).toMatchObject({
      arrow: "↓",
      type: "%output",
      summary: `$0:@1.%5  "hi"`,
    });
  });

  it("marks a failed response type with !err", () => {
    const w: WireEntry = {
      dir: "in-response",
      ts: 0,
      id: "3",
      latencyMs: 12,
      request: null,
      response: {
        commandNumber: 3,
        timestamp: 0,
        output: ["line1", "line2"],
        success: false,
      },
    };
    const p = presentFor(w, labels);
    expect(p.type).toBe("response #3 !err");
    expect(p.summary).toBe("line1 …+1");
  });

  it("presents an inbound error with its message", () => {
    const w: WireEntry = {
      dir: "in-error",
      ts: 0,
      id: "9",
      message: "no such pane",
    };
    const p = presentFor(w, labels);
    expect(p).toMatchObject({
      arrow: "⚠",
      type: "error #9",
      summary: "no such pane",
    });
  });
});

describe("badgeColor", () => {
  it("maps each direction to a stable Mantine color", () => {
    expect(badgeColor("out")).toBe("blue");
    expect(badgeColor("in-event")).toBe("teal");
    expect(badgeColor("in-response")).toBe("grape");
    expect(badgeColor("in-error")).toBe("red");
  });
});

describe("renderPayload", () => {
  it("pretty-prints an outbound message as JSON", () => {
    const w: WireEntry = {
      dir: "out",
      ts: 0,
      msg: { kind: "detach", id: "1" },
    };
    expect(renderPayload(w)).toBe(
      JSON.stringify({ kind: "detach", id: "1" }, null, 2),
    );
  });

  it("pretty-prints a firehose-toggle message verbatim as JSON", () => {
    const w: WireEntry = {
      dir: "out",
      ts: 0,
      msg: { kind: "startFirehose", id: "2" },
    };
    expect(renderPayload(w)).toBe(
      JSON.stringify({ kind: "startFirehose", id: "2" }, null, 2),
    );
  });

  it("renders output-event bytes as an escaped byte view, not raw JSON", () => {
    const w: WireEntry = {
      dir: "in-event",
      ts: 0,
      event: { type: "output", paneId: 5, data: bytes("hi") },
    };
    const text = renderPayload(w);
    expect(text).toContain("paneId=%5");
    expect(text).toContain("<2 bytes>");
  });

  it("notes when a response's request was evicted from the ring", () => {
    const w: WireEntry = {
      dir: "in-response",
      ts: 0,
      id: "3",
      latencyMs: 5,
      request: null,
      response: { commandNumber: 3, timestamp: 0, output: [], success: true },
    };
    expect(renderPayload(w)).toContain("(request evicted from ring)");
  });
});

describe("formatMs", () => {
  it("formats sub-millisecond, millisecond, and second ranges", () => {
    expect(formatMs(0.4)).toBe("<1ms");
    expect(formatMs(42)).toBe("42ms");
    expect(formatMs(1500)).toBe("1.50s");
  });
});
