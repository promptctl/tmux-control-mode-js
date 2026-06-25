// examples/web-multiplexer/web/image-extract-engine.test.ts
//
// Pure tests for the inline-image extractor. Fixtures are REAL: the PNG and both
// sixels were produced by ImageMagick (`magick … png:-` / `… sixel:-`), so the
// decoder is verified against tool output, not against my own assumptions about
// the wire format. [LAW:behavior-not-structure] every test asserts a decoded
// image's content (pixels / mime / attribution), never the engine's internals.

import { describe, it, expect } from "vitest";
import {
  ImageExtractEngine,
  type ExtractedImage,
} from "./image-extract-engine.ts";

// --- helpers ---------------------------------------------------------------

const ESC = "\x1b";
const BEL = "\x07";
const ST = `${ESC}\\`;

/** Latin-1 encode a control-sequence string to raw bytes. */
function bytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

function b64(data: number[]): string {
  return Buffer.from(data).toString("base64");
}

/** A real 1×1 PNG (ImageMagick `magick -size 1x1 xc:'#cc2121' png:-`). */
const PNG_1x1_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQMAAAAl21bKAAAAIGNIUk0AAHomAACAhAAA+gAAAIDo" +
  "AAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGUExURcwhIf///yfcj/0AAAABYktHRAH/Ai3eAAAAB3RJ" +
  "TUUH6gYZCggzo8QROQAAACV0RVh0ZGF0ZTpjcmVhdGUAMjAyNi0wNi0yNVQxMDowODo1MSswMDow" +
  "MC2b3uIAAAAldEVYdGRhdGU6bW9kaWZ5ADIwMjYtMDYtMjVUMTA6MDg6NTErMDA6MDBcxmZeAAAA" +
  "KHRFWHRkYXRlOnRpbWVzdGFtcAAyMDI2LTA2LTI1VDEwOjA4OjUxKzAwOjAwC9NHgQAAAApJREFU" +
  "CNdjYAAAAAIAAeIhvDMAAAAASUVORK5CYII=";

/** ImageMagick sixel for a 4×4 solid red square. */
const SIXEL_RED_4x4 = `${ESC}P0;0;0q"1;1;4;4#0;2;100;0;0#0!4N-${ST}`;

/** ImageMagick sixel: 2×2 — (0,0) red, (1,1) blue, the other two white. */
const SIXEL_2x2 = `${ESC}P0;0;0q"1;1;2;2#0;2;100;0;0#1;2;0;0;100#2;2;100;100;100#2A@$#0@#1A-${ST}`;

function iterm2(b64Payload: string, args = "inline=1"): string {
  return `${ESC}]1337;File=${args}:${b64Payload}${BEL}`;
}

function feed(
  engine: ImageExtractEngine,
  paneId: number,
  s: string,
): ExtractedImage[] {
  return engine.pushBytes(paneId, bytes(s));
}

function pixel(
  img: ExtractedImage,
  x: number,
  y: number,
): [number, number, number, number] {
  if (img.payload.kind !== "raster") throw new Error("not a raster");
  const { width, rgba } = img.payload;
  const d = (y * width + x) * 4;
  return [rgba[d]!, rgba[d + 1]!, rgba[d + 2]!, rgba[d + 3]!];
}

// --- iTerm2 ----------------------------------------------------------------

describe("iTerm2 OSC 1337", () => {
  it("decodes an inline PNG and sniffs its MIME", () => {
    const engine = new ImageExtractEngine(100);
    const out = feed(engine, 1, iterm2(PNG_1x1_B64));
    expect(out).toHaveLength(1);
    expect(out[0]!.protocol).toBe("iterm2");
    expect(out[0]!.payload.kind).toBe("encoded");
    if (out[0]!.payload.kind === "encoded") {
      expect(out[0]!.payload.mime).toBe("image/png");
      // PNG magic survived the base64 round-trip.
      expect([...out[0]!.payload.bytes.slice(0, 4)]).toEqual([
        0x89, 0x50, 0x4e, 0x47,
      ]);
    }
  });

  it("terminates on ST as well as BEL", () => {
    const engine = new ImageExtractEngine(100);
    const seq = `${ESC}]1337;File=inline=1:${PNG_1x1_B64}${ST}`;
    expect(feed(engine, 1, seq)).toHaveLength(1);
  });

  it("decodes the base64 filename into the label", () => {
    const engine = new ImageExtractEngine(100);
    const name = Buffer.from("cat.png").toString("base64");
    const out = feed(engine, 1, iterm2(PNG_1x1_B64, `name=${name};inline=1`));
    expect(out[0]!.label).toBe("cat.png");
  });

  it("ignores non-image OSC (titles, hyperlinks)", () => {
    const engine = new ImageExtractEngine(100);
    expect(feed(engine, 1, `${ESC}]0;my terminal title${BEL}`)).toHaveLength(0);
    expect(feed(engine, 1, `${ESC}]8;;https://example.com${ST}`)).toHaveLength(
      0,
    );
  });
});

// --- Kitty -----------------------------------------------------------------

describe("Kitty APC graphics", () => {
  it("decodes a single-chunk PNG (f=100)", () => {
    const engine = new ImageExtractEngine(100);
    const seq = `${ESC}_Gf=100,a=T;${PNG_1x1_B64}${ST}`;
    const out = feed(engine, 1, seq);
    expect(out).toHaveLength(1);
    expect(out[0]!.protocol).toBe("kitty");
    expect(out[0]!.payload.kind).toBe("encoded");
  });

  it("decodes raw RGBA (f=32) into the correct pixels", () => {
    const engine = new ImageExtractEngine(100);
    // 2×1: red then green, fully opaque.
    const raw = b64([255, 0, 0, 255, 0, 255, 0, 255]);
    const seq = `${ESC}_Gf=32,s=2,v=1,a=T;${raw}${ST}`;
    const out = feed(engine, 1, seq);
    expect(out).toHaveLength(1);
    expect(out[0]!.payload.kind).toBe("raster");
    expect(pixel(out[0]!, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(pixel(out[0]!, 1, 0)).toEqual([0, 255, 0, 255]);
  });

  it("widens raw RGB (f=24) to opaque RGBA", () => {
    const engine = new ImageExtractEngine(100);
    const raw = b64([10, 20, 30]); // one pixel, no alpha
    const out = feed(engine, 1, `${ESC}_Gf=24,s=1,v=1,a=T;${raw}${ST}`);
    expect(pixel(out[0]!, 0, 0)).toEqual([10, 20, 30, 255]);
  });

  it("reassembles a multi-chunk transfer (m=1 … m=0)", () => {
    const engine = new ImageExtractEngine(100);
    const half = Math.floor(PNG_1x1_B64.length / 2);
    const a = PNG_1x1_B64.slice(0, half);
    const z = PNG_1x1_B64.slice(half);
    // No image until the final chunk arrives.
    expect(feed(engine, 1, `${ESC}_Gf=100,a=T,m=1;${a}${ST}`)).toHaveLength(0);
    const out = feed(engine, 1, `${ESC}_Gm=0;${z}${ST}`);
    expect(out).toHaveLength(1);
    if (out[0]!.payload.kind === "encoded") {
      expect(out[0]!.payload.mime).toBe("image/png");
    }
  });
});

// --- Sixel -----------------------------------------------------------------

describe("Sixel DCS", () => {
  it("decodes a 4×4 solid-red square (ImageMagick fixture)", () => {
    const engine = new ImageExtractEngine(100);
    const out = feed(engine, 1, SIXEL_RED_4x4);
    expect(out).toHaveLength(1);
    expect(out[0]!.protocol).toBe("sixel");
    if (out[0]!.payload.kind === "raster") {
      expect(out[0]!.payload.width).toBe(4);
      expect(out[0]!.payload.height).toBe(4);
    }
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        expect(pixel(out[0]!, x, y)).toEqual([255, 0, 0, 255]);
      }
    }
  });

  it("places pixels at the right coordinates (2×2 geometry)", () => {
    const engine = new ImageExtractEngine(100);
    const out = feed(engine, 1, SIXEL_2x2);
    expect(out).toHaveLength(1);
    expect(pixel(out[0]!, 0, 0)).toEqual([255, 0, 0, 255]); // top-left red
    expect(pixel(out[0]!, 1, 0)).toEqual([255, 255, 255, 255]); // white
    expect(pixel(out[0]!, 0, 1)).toEqual([255, 255, 255, 255]); // white
    expect(pixel(out[0]!, 1, 1)).toEqual([0, 0, 255, 255]); // bottom-right blue
  });

  it("rejects non-sixel DCS strings", () => {
    const engine = new ImageExtractEngine(100);
    // DECRQSS-style DCS — has no `q` introducer in the param position.
    expect(feed(engine, 1, `${ESC}P$qm${ST}`)).toHaveLength(0);
  });
});

// --- streaming robustness --------------------------------------------------

describe("streaming across chunk boundaries", () => {
  it("reassembles a sequence split mid-base64 across two chunks", () => {
    const engine = new ImageExtractEngine(100);
    const full = iterm2(PNG_1x1_B64);
    const cut = Math.floor(full.length / 2);
    expect(feed(engine, 1, full.slice(0, cut))).toHaveLength(0);
    expect(feed(engine, 1, full.slice(cut))).toHaveLength(1);
  });

  it("handles a sequence split between ESC and the \\ of its terminator", () => {
    const engine = new ImageExtractEngine(100);
    const body = `${ESC}]1337;File=inline=1:${PNG_1x1_B64}`;
    expect(feed(engine, 1, body + ESC)).toHaveLength(0); // ESC of ST, no \ yet
    expect(feed(engine, 1, "\\")).toHaveLength(1); // the \ completes ST
  });

  it("attributes interleaved bytes from two panes correctly", () => {
    const engine = new ImageExtractEngine(100);
    const a = SIXEL_RED_4x4;
    const acut = Math.floor(a.length / 2);
    feed(engine, 11, a.slice(0, acut)); // pane 11 mid-sixel
    const bOut = feed(engine, 22, SIXEL_2x2); // pane 22 completes first
    expect(bOut).toHaveLength(1);
    expect(bOut[0]!.paneId).toBe(22);
    const aOut = feed(engine, 11, a.slice(acut)); // pane 11 completes
    expect(aOut).toHaveLength(1);
    expect(aOut[0]!.paneId).toBe(11);
  });

  it("discards surrounding terminal noise and resyncs", () => {
    const engine = new ImageExtractEngine(100);
    const stream =
      `bash$ ls -la\r\n${ESC}[32mfile.txt${ESC}[0m\r\n` +
      iterm2(PNG_1x1_B64) +
      `bash$ echo done\r\n`;
    const out = feed(engine, 1, stream);
    expect(out).toHaveLength(1);
    expect(out[0]!.protocol).toBe("iterm2");
  });

  it("emits nothing for an unterminated sequence (no half-images)", () => {
    const engine = new ImageExtractEngine(100);
    const partial = `${ESC}]1337;File=inline=1:${PNG_1x1_B64}`; // no BEL/ST
    expect(feed(engine, 1, partial)).toHaveLength(0);
    expect(engine.images).toHaveLength(0);
  });
});

// --- engine bookkeeping ----------------------------------------------------

describe("engine feed", () => {
  it("evicts oldest images past capacity (FIFO)", () => {
    const engine = new ImageExtractEngine(2);
    feed(engine, 1, iterm2(PNG_1x1_B64));
    feed(engine, 1, SIXEL_RED_4x4);
    feed(engine, 1, SIXEL_2x2);
    expect(engine.images).toHaveLength(2);
    expect(engine.images[0]!.protocol).toBe("sixel"); // first iterm2 evicted
  });

  it("counts distinct tapped panes and clears", () => {
    const engine = new ImageExtractEngine(100);
    feed(engine, 1, iterm2(PNG_1x1_B64));
    feed(engine, 2, SIXEL_RED_4x4);
    expect(engine.tappedPaneCount).toBe(2);
    expect(engine.images).toHaveLength(2);
    engine.clear();
    expect(engine.tappedPaneCount).toBe(0);
    expect(engine.images).toHaveLength(0);
  });

  it("assigns monotonic ids in arrival order", () => {
    const engine = new ImageExtractEngine(100);
    const a = feed(engine, 1, iterm2(PNG_1x1_B64))[0]!;
    const b = feed(engine, 2, SIXEL_RED_4x4)[0]!;
    expect(b.id).toBeGreaterThan(a.id);
  });
});
