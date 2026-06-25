// examples/web-multiplexer/web/escape-parse-engine.test.ts
//
// Pure tests for the escape-code playground engine. [LAW:behavior-not-structure]
// every test asserts a decoded *meaning* — the bytes an escape notation expands
// to, or the structured event a byte run classifies as — never the parser's
// internals.

import { describe, it, expect } from "vitest";
import {
  interpretEscapes,
  parseEscapes,
  analyze,
  type EscapeEvent,
} from "./escape-parse-engine.ts";

/** UTF-8 encode a string to bytes (what the engine parses). */
function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/** Latin-1 encode — for crafting raw control-byte runs directly. */
function raw(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

const ESC = "\x1b";

describe("interpretEscapes", () => {
  it("expands \\e and \\E to ESC (0x1b)", () => {
    expect(interpretEscapes("\\e")).toBe("\x1b");
    expect(interpretEscapes("\\E")).toBe("\x1b");
  });

  it("expands a full SGR sequence written with \\e", () => {
    expect(interpretEscapes("\\e[31mRED\\e[0m")).toBe("\x1b[31mRED\x1b[0m");
  });

  it("expands named C escapes", () => {
    expect(interpretEscapes("a\\nb\\tc\\r")).toBe("a\nb\tc\r");
    expect(interpretEscapes("\\a\\b\\f\\v")).toBe("\x07\x08\x0c\x0b");
  });

  it("expands \\xHH hex (1 and 2 digits)", () => {
    expect(interpretEscapes("\\x1b")).toBe("\x1b");
    expect(interpretEscapes("\\x7")).toBe("\x07");
    expect(interpretEscapes("\\x41")).toBe("A");
  });

  it("expands \\NNN octal including \\033 to ESC", () => {
    expect(interpretEscapes("\\033")).toBe("\x1b");
    expect(interpretEscapes("\\0")).toBe("\x00");
    expect(interpretEscapes("\\101")).toBe("A");
  });

  it("expands \\uHHHH to a Unicode code point", () => {
    expect(interpretEscapes("\\u2588")).toBe("█"); // FULL BLOCK
    // Short \u keeps the backslash literal.
    expect(interpretEscapes("\\u25")).toBe("\\u25");
  });

  it("collapses \\\\ to a single backslash", () => {
    expect(interpretEscapes("a\\\\b")).toBe("a\\b");
  });

  it("keeps an unrecognized escape's backslash literal", () => {
    // A Windows path should survive untouched-ish: \U is not a known escape.
    expect(interpretEscapes("C:\\Users")).toBe("C:\\Users");
    expect(interpretEscapes("\\q")).toBe("\\q");
  });

  it("keeps a trailing lone backslash literal", () => {
    expect(interpretEscapes("end\\")).toBe("end\\");
  });
});

describe("parseEscapes — text and C0", () => {
  it("classifies a plain printable run as one text event", () => {
    const ev = parseEscapes(enc("hello world"));
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ kind: "text", text: "hello world" });
  });

  it("decodes multi-byte UTF-8 text correctly", () => {
    const ev = parseEscapes(enc("héllo→"));
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ kind: "text", text: "héllo→" });
    // byteLength is the UTF-8 length, not the code-point count.
    expect((ev[0] as Extract<EscapeEvent, { kind: "text" }>).byteLength).toBe(
      enc("héllo→").length,
    );
  });

  it("emits a c0 event per control byte with a name", () => {
    const ev = parseEscapes(enc("a\nb\t"));
    expect(ev.map((e) => e.kind)).toEqual(["text", "c0", "text", "c0"]);
    expect(ev[1]).toMatchObject({ kind: "c0", name: "LF", byte: 0x0a });
    expect(ev[3]).toMatchObject({ kind: "c0", name: "HT", byte: 0x09 });
  });

  it("labels an unknown control byte by hex", () => {
    const ev = parseEscapes(raw("\x01"));
    expect(ev[0]).toMatchObject({
      kind: "c0",
      name: "0x01",
      desc: "control 0x01",
    });
  });
});

describe("parseEscapes — CSI", () => {
  it("classifies a cursor-position sequence", () => {
    const ev = parseEscapes(enc(`${ESC}[10;5H`));
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({
      kind: "csi",
      params: "10;5",
      final: "H",
    });
    expect((ev[0] as Extract<EscapeEvent, { kind: "csi" }>).desc).toContain(
      "cursor position",
    );
  });

  it("recognizes private-mode set (alt screen ?1049h)", () => {
    const ev = parseEscapes(enc(`${ESC}[?1049h`));
    expect(ev[0]).toMatchObject({ kind: "csi", params: "?1049", final: "h" });
    expect((ev[0] as Extract<EscapeEvent, { kind: "csi" }>).desc).toContain(
      "private mode set",
    );
  });

  it("reports byteLength spanning the whole sequence", () => {
    const seq = `${ESC}[1;31m`;
    const ev = parseEscapes(enc(seq));
    expect((ev[0] as Extract<EscapeEvent, { kind: "csi" }>).byteLength).toBe(
      seq.length,
    );
  });
});

describe("parseEscapes — SGR decoding", () => {
  function sgr(seq: string): Extract<EscapeEvent, { kind: "csi" }> {
    const ev = parseEscapes(enc(seq));
    expect(ev[0].kind).toBe("csi");
    return ev[0] as Extract<EscapeEvent, { kind: "csi" }>;
  }

  it("decodes basic foreground colors", () => {
    const e = sgr(`${ESC}[31m`);
    expect(e.sgr).toBeDefined();
    expect(e.sgr?.[0]).toMatchObject({ label: "fg red", plane: "fg" });
    expect(e.sgr?.[0].color).toBeDefined();
  });

  it("decodes a compound attribute list (bold + bg green)", () => {
    const e = sgr(`${ESC}[1;42m`);
    expect(e.sgr?.map((t) => t.label)).toEqual(["bold", "bg green"]);
  });

  it("treats an empty SGR as reset", () => {
    const e = sgr(`${ESC}[m`);
    expect(e.sgr).toEqual([{ label: "reset all" }]);
  });

  it("decodes bright foreground (90–97)", () => {
    const e = sgr(`${ESC}[92m`);
    expect(e.sgr?.[0]).toMatchObject({ label: "fg bright green", plane: "fg" });
  });

  it("decodes 256-color extended foreground (38;5;n)", () => {
    const e = sgr(`${ESC}[38;5;208m`);
    expect(e.sgr).toHaveLength(1);
    expect(e.sgr?.[0]).toMatchObject({
      label: "fg 256-color #208",
      plane: "fg",
    });
    expect(e.sgr?.[0].color).toMatch(/^rgb\(/);
  });

  it("decodes truecolor extended background (48;2;r;g;b)", () => {
    const e = sgr(`${ESC}[48;2;10;20;30m`);
    expect(e.sgr?.[0]).toMatchObject({
      label: "bg truecolor 10,20,30",
      plane: "bg",
      color: "rgb(10,20,30)",
    });
  });

  it("decodes a truecolor token followed by a simple one", () => {
    const e = sgr(`${ESC}[38;2;255;0;0;1m`);
    expect(e.sgr?.map((t) => t.label)).toEqual([
      "fg truecolor 255,0,0",
      "bold",
    ]);
  });
});

describe("parseEscapes — OSC", () => {
  it("classifies a window-title set terminated by ST", () => {
    const ev = parseEscapes(enc(`${ESC}]0;my title${ESC}\\`));
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({
      kind: "osc",
      ps: "0",
      payload: "my title",
      terminator: "ST",
    });
    expect((ev[0] as Extract<EscapeEvent, { kind: "osc" }>).desc).toContain(
      "window title",
    );
  });

  it("accepts BEL as an OSC terminator", () => {
    const ev = parseEscapes(enc(`${ESC}]2;t\x07`));
    expect(ev[0]).toMatchObject({ kind: "osc", ps: "2", terminator: "BEL" });
  });

  it("marks an unterminated OSC as terminator none", () => {
    const ev = parseEscapes(enc(`${ESC}]0;no end`));
    expect(ev[0]).toMatchObject({ kind: "osc", ps: "0", terminator: "none" });
  });

  it("labels the OSC 8 hyperlink command", () => {
    const ev = parseEscapes(enc(`${ESC}]8;;https://x.test${ESC}\\`));
    expect((ev[0] as Extract<EscapeEvent, { kind: "osc" }>).desc).toContain(
      "hyperlink",
    );
  });
});

describe("parseEscapes — ESC and string sequences", () => {
  it("classifies RIS (ESC c) full reset", () => {
    const ev = parseEscapes(enc(`${ESC}c`));
    expect(ev[0]).toMatchObject({ kind: "esc", final: "c" });
    expect((ev[0] as Extract<EscapeEvent, { kind: "esc" }>).desc).toContain(
      "reset",
    );
  });

  it("classifies a charset designation (ESC ( B)", () => {
    const ev = parseEscapes(enc(`${ESC}(B`));
    expect(ev[0]).toMatchObject({
      kind: "esc",
      intermediates: "(",
      final: "B",
    });
  });

  it("classifies a DCS string as opaque", () => {
    const ev = parseEscapes(enc(`${ESC}Pq#0;2;0;0;0${ESC}\\`));
    expect(ev[0]).toMatchObject({
      kind: "string",
      type: "DCS",
      terminator: "ST",
    });
  });

  it("classifies an APC string", () => {
    const ev = parseEscapes(enc(`${ESC}_Gf=100${ESC}\\`));
    expect(ev[0]).toMatchObject({
      kind: "string",
      type: "APC",
      terminator: "ST",
    });
  });
});

describe("parseEscapes — incomplete tails", () => {
  it("reports a lone trailing ESC", () => {
    const ev = parseEscapes(enc(`hi${ESC}`));
    expect(ev[ev.length - 1]).toMatchObject({
      kind: "incomplete",
      desc: "lone ESC at end of input",
    });
  });

  it("reports a CSI with no final byte", () => {
    const ev = parseEscapes(enc(`${ESC}[1;2`));
    expect(ev[ev.length - 1]).toMatchObject({ kind: "incomplete" });
  });
});

describe("parseEscapes — mixed real-world stream", () => {
  it("splits a colored line with cursor moves into ordered events", () => {
    const ev = parseEscapes(enc(`${ESC}[2J${ESC}[31mError:${ESC}[0m done\n`));
    expect(ev.map((e) => e.kind)).toEqual([
      "csi", // 2J erase display
      "csi", // 31m SGR
      "text", // "Error:"
      "csi", // 0m reset
      "text", // " done"
      "c0", // \n
    ]);
  });
});

describe("analyze — the view's one-call entry", () => {
  it("interprets notation, then yields the exact bytes sent", () => {
    const a = analyze("\\e[32mok\\e[0m");
    expect(a.interpreted).toBe("\x1b[32mok\x1b[0m");
    // The bytes are the UTF-8 of the interpreted string — what sendKeys transmits.
    expect(a.bytes).toEqual(new TextEncoder().encode("\x1b[32mok\x1b[0m"));
    expect(a.events.map((e) => e.kind)).toEqual(["csi", "text", "csi"]);
  });

  it("round-trips: every event's byteLength sums to the total byte count", () => {
    const a = analyze("\\e[1;38;5;82mHELLO\\e[0m\\n");
    const sum = a.events.reduce(
      (acc, e) => acc + ("byteLength" in e ? e.byteLength : 1),
      0,
    );
    expect(sum).toBe(a.bytes.length);
  });
});
