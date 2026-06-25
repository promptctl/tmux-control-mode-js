// examples/web-multiplexer/web/image-extract-engine.ts
//
// ImageExtractEngine — the pure core of the inline-image extractor: a streaming
// sniffer that pulls iTerm2 (OSC 1337), Kitty (APC `_G` graphics) and Sixel
// (DCS) image escape sequences out of the raw byte stream of every pane, decodes
// them, and emits a bounded ring of ExtractedImage. This is the "parsing depth"
// showcase: terminals would never let you see these images at all (they render
// to the focused screen only), but the bridge firehose hands us the raw pty
// bytes of EVERY pane, sequences intact.
//
// [LAW:effects-at-boundaries] Zero IO, zero MobX, no DOM. Bytes in, decoded
//   images out — a pure function of the byte stream, exhaustively unit-tested.
//   The firehose subscription, the blob URLs and the <canvas>/<img> rendering
//   all live at the boundary (ImageExtractorStore / ImageExtractorView).
// [LAW:no-ambient-temporal-coupling] A sequence may be split across arbitrary
//   firehose chunk boundaries — even between the ESC and the `\` of a String
//   Terminator. The per-pane SequenceScanner carries all parser state across
//   pushBytes calls; correctness never depends on a sequence arriving whole.
// [LAW:dataflow-not-control-flow] Every chunk runs the same scan → decode →
//   append pipeline. Non-image bytes are the empty-output case (the ground
//   state consumes and discards them), not a skipped branch.

/** A decoded, renderable image extracted from one pane's byte stream. */
export interface ExtractedImage {
  /** Monotonic id; orders the gallery feed. */
  readonly id: number;
  readonly paneId: number;
  readonly protocol: "iterm2" | "kitty" | "sixel";
  /**
   * [LAW:dataflow-not-control-flow] The render distinction is "already a
   * browser-decodable file" vs "raw pixels we must paint" — not the source
   * protocol. The view branches on `kind`, never on `protocol`.
   */
  readonly payload: ImagePayload;
  /** Bytes the sequence occupied on the wire (introducer..terminator). */
  readonly wireBytes: number;
  /** Short human label, e.g. `PNG 120×80` or an iTerm2 filename. */
  readonly label: string;
}

export type ImagePayload =
  | {
      readonly kind: "encoded";
      /** Sniffed MIME of the encoded file (image/png, image/jpeg, …). */
      readonly mime: string;
      readonly bytes: Uint8Array;
    }
  | {
      readonly kind: "raster";
      readonly width: number;
      readonly height: number;
      /** Row-major RGBA, length === width * height * 4. */
      readonly rgba: Uint8ClampedArray;
    };

// Control bytes.
const ESC = 0x1b;
const BEL = 0x07;
const BACKSLASH = 0x5c; // ST is ESC \
const OSC_INTRO = 0x5d; // ESC ]
const APC_INTRO = 0x5f; // ESC _
const DCS_INTRO = 0x50; // ESC P

/**
 * Cap on a single in-progress sequence. A terminator that never arrives (a pane
 * spewing a half-written graphics sequence) must not grow unbounded; on overflow
 * we abandon the sequence and resync. 16 MiB comfortably holds a full-screen PNG.
 */
const MAX_SEQUENCE_BYTES = 16 * 1024 * 1024;

/**
 * Cap on a decoded raster (sixel / kitty raw). Bounds the cost of a malicious or
 * absurd raster-attribute header before we allocate the RGBA buffer.
 */
const MAX_RASTER_PIXELS = 8_000_000;

type Mode = "ground" | "esc" | "osc" | "apc" | "dcs";

/**
 * Parser for ONE pane, resumable across chunk boundaries. The scanner walks the
 * VT500 escape grammar only as deep as needed to frame OSC/APC/DCS *strings*; it
 * deliberately ignores CSI and everything else (those carry no images and
 * contain no ESC, so dropping back to `ground` resyncs cleanly).
 */
class SequenceScanner {
  private mode: Mode = "ground";
  private buf: number[] = [];
  /** In a string mode, an ESC was seen and we're checking for the `\` of ST. */
  private sawEsc = false;

  /**
   * In-flight Kitty multi-chunk assembly. Kitty splits a large image into
   * successive `_G` sequences carrying `m=1` (more follow) until a final `m=0`.
   * The control keys ride the first chunk; later chunks carry only the payload.
   */
  private kitty: { control: Map<string, string>; parts: string[] } | null =
    null;

  /**
   * Feed raw bytes; append any newly completed images to `out`. Returns nothing
   * — the caller owns the ring. Decoders that fail or hit an unsupported variant
   * yield no image (they are not errors; an unknown format is simply not shown).
   */
  push(
    data: Uint8Array,
    paneId: number,
    sink: (img: DecodedSequence) => void,
  ): void {
    for (let i = 0; i < data.length; i++) {
      const b = data[i]!;
      switch (this.mode) {
        case "ground":
          if (b === ESC) this.mode = "esc";
          break;
        case "esc":
          if (b === OSC_INTRO) this.beginString("osc");
          else if (b === APC_INTRO) this.beginString("apc");
          else if (b === DCS_INTRO) this.beginString("dcs");
          else if (b === ESC)
            this.mode = "esc"; // ESC ESC: restart the introducer
          else this.mode = "ground"; // CSI / other escape — not an image carrier
          break;
        case "osc":
        case "apc":
        case "dcs":
          this.consumeStringByte(b, paneId, sink);
          break;
      }
    }
  }

  private beginString(mode: Exclude<Mode, "ground" | "esc">): void {
    this.mode = mode;
    this.buf = [];
    this.sawEsc = false;
  }

  /** Handle one byte while accumulating an OSC/APC/DCS string body. */
  private consumeStringByte(
    b: number,
    paneId: number,
    sink: (img: DecodedSequence) => void,
  ): void {
    if (this.sawEsc) {
      // Previous byte was ESC inside the string.
      if (b === BACKSLASH) {
        this.finishString(paneId, sink); // ESC \ = ST → sequence complete
      } else {
        // A stray ESC aborts the current (malformed) string. Resync: reprocess
        // this byte through the escape grammar so we don't lose a new sequence
        // that started right after the abort.
        this.abandon();
        if (b === ESC) this.mode = "esc";
        else this.mode = "ground";
      }
      this.sawEsc = false;
      return;
    }
    if (b === ESC) {
      this.sawEsc = true; // could be the start of ST
      return;
    }
    if (b === BEL && this.mode === "osc") {
      this.finishString(paneId, sink); // OSC also terminates on BEL
      return;
    }
    this.buf.push(b);
    if (this.buf.length > MAX_SEQUENCE_BYTES) this.abandon();
  }

  /** Drop the in-progress string and return to ground. */
  private abandon(): void {
    this.mode = "ground";
    this.buf = [];
  }

  /** A complete string body is in `buf`; dispatch it to the right decoder. */
  private finishString(
    paneId: number,
    sink: (img: DecodedSequence) => void,
  ): void {
    const mode = this.mode;
    const body = this.buf;
    const wireBytes = body.length;
    this.mode = "ground";
    this.buf = [];

    if (mode === "osc") {
      const img = decodeIterm2(body);
      if (img !== null) sink({ ...img, paneId, wireBytes });
      return;
    }
    if (mode === "dcs") {
      const img = decodeSixel(body);
      if (img !== null) sink({ ...img, paneId, wireBytes });
      return;
    }
    // APC: Kitty graphics, possibly one chunk of a multi-chunk transfer.
    this.consumeKittyChunk(body, paneId, wireBytes, sink);
  }

  /**
   * Fold one `_G` chunk into the pending assembly, decoding when the final
   * (`m=0` / absent) chunk arrives. Keeps the control from the first chunk.
   */
  private consumeKittyChunk(
    body: number[],
    paneId: number,
    wireBytes: number,
    sink: (img: DecodedSequence) => void,
  ): void {
    if (body.length === 0 || body[0] !== 0x47 /* 'G' */) return;
    const text = bytesToLatin1(body.slice(1));
    const semi = text.indexOf(";");
    const controlText = semi === -1 ? text : text.slice(0, semi);
    const payload = semi === -1 ? "" : text.slice(semi + 1);
    const control = parseKvList(controlText, ",");

    const more = control.get("m") === "1";
    if (this.kitty === null) {
      this.kitty = { control, parts: [payload] };
    } else {
      this.kitty.parts.push(payload);
    }
    if (more) return; // wait for the final chunk

    const assembled = this.kitty;
    this.kitty = null;
    const img = decodeKitty(assembled.control, assembled.parts.join(""));
    if (img !== null) sink({ ...img, paneId, wireBytes });
  }
}

/** A decoded image awaiting paneId/wireBytes/id assignment by the engine. */
type DecodedSequence = Omit<ExtractedImage, "id">;

export class ImageExtractEngine {
  private readonly scanners = new Map<number, SequenceScanner>();
  private readonly ring: ExtractedImage[] = [];
  private nextId = 1;

  /** @param capacity max images retained in the gallery (FIFO eviction). */
  constructor(private readonly capacity: number) {}

  /**
   * Feed one raw pane byte chunk. Returns the images this chunk newly completed
   * (possibly empty). A single image may span many chunks; the per-pane scanner
   * carries the parser state until its terminator arrives.
   */
  pushBytes(paneId: number, data: Uint8Array): ExtractedImage[] {
    let scanner = this.scanners.get(paneId);
    if (scanner === undefined) {
      scanner = new SequenceScanner();
      this.scanners.set(paneId, scanner);
    }
    const added: ExtractedImage[] = [];
    scanner.push(data, paneId, (seq) => {
      const img: ExtractedImage = { ...seq, id: this.nextId++ };
      this.ring.push(img);
      added.push(img);
    });
    if (this.ring.length > this.capacity) {
      this.ring.splice(0, this.ring.length - this.capacity);
    }
    return added;
  }

  /** The current bounded, chronological image feed. */
  get images(): readonly ExtractedImage[] {
    return this.ring;
  }

  /** Number of distinct panes that have fed the engine bytes this session. */
  get tappedPaneCount(): number {
    return this.scanners.size;
  }

  /** Drop all images and per-pane carry-over (e.g. on disconnect). */
  clear(): void {
    this.ring.length = 0;
    this.scanners.clear();
  }
}

// ---------------------------------------------------------------------------
// Decoders (pure: bytes/strings in, ExtractedImage payload out, never throw)
// ---------------------------------------------------------------------------

type DecodeResult = Omit<ExtractedImage, "id" | "paneId" | "wireBytes">;

/**
 * iTerm2 inline image: OSC body is `1337;File=<k=v>;…:<base64>`. Anything else
 * on OSC (titles, hyperlinks, other 1337 verbs) is not an image → null.
 */
function decodeIterm2(body: number[]): DecodeResult | null {
  const text = bytesToLatin1(body);
  if (!text.startsWith("1337;File=")) return null;
  const colon = text.indexOf(":");
  if (colon === -1) return null;
  const argText = text.slice("1337;".length, colon); // "File=...;..."
  const base64 = text.slice(colon + 1);
  const bytes = decodeBase64(base64);
  if (bytes === null || bytes.length === 0) return null;

  const args = parseIterm2Args(argText);
  const mime = sniffMime(bytes);
  const name = decodeIterm2Name(args.get("name"));
  const label = name ?? `${mimeShort(mime)} ${bytes.length}B`;
  return {
    protocol: "iterm2",
    payload: { kind: "encoded", mime, bytes },
    label,
  };
}

/** iTerm2 File args are `File=key=val;key=val` — the leading `File=` then KVs. */
function parseIterm2Args(argText: string): Map<string, string> {
  const eq = argText.indexOf("=");
  const kvText = eq === -1 ? "" : argText.slice(eq + 1); // strip the `File=`
  return parseKvList(kvText, ";");
}

function decodeIterm2Name(nameB64: string | undefined): string | null {
  if (nameB64 === undefined) return null;
  const bytes = decodeBase64(nameB64);
  if (bytes === null) return null;
  return bytesToLatin1([...bytes]);
}

/**
 * Kitty graphics. `f` = format: 100 PNG (default for a=T transfers), 24 RGB,
 * 32 RGBA. PNG → encoded; raw RGB/RGBA → raster (needs `s`/`v` dimensions).
 */
function decodeKitty(
  control: Map<string, string>,
  payloadB64: string,
): DecodeResult | null {
  const bytes = decodeBase64(payloadB64);
  if (bytes === null || bytes.length === 0) return null;
  const format = control.get("f") ?? "100";

  if (format === "100") {
    const mime = sniffMime(bytes);
    return {
      protocol: "kitty",
      payload: { kind: "encoded", mime, bytes },
      label: `${mimeShort(mime)} ${bytes.length}B`,
    };
  }
  if (format === "24" || format === "32") {
    const width = parseIntOr(control.get("s"), 0);
    const height = parseIntOr(control.get("v"), 0);
    if (width <= 0 || height <= 0 || width * height > MAX_RASTER_PIXELS)
      return null;
    const rgba = expandRawToRgba(bytes, width, height, format === "32" ? 4 : 3);
    if (rgba === null) return null;
    return {
      protocol: "kitty",
      payload: { kind: "raster", width, height, rgba },
      label: `RGB${format === "32" ? "A" : ""} ${width}×${height}`,
    };
  }
  return null;
}

/** Widen packed RGB/RGBA pixel bytes into a full RGBA buffer. */
function expandRawToRgba(
  bytes: Uint8Array,
  width: number,
  height: number,
  channels: 3 | 4,
): Uint8ClampedArray | null {
  const pixels = width * height;
  if (bytes.length < pixels * channels) return null;
  const rgba = new Uint8ClampedArray(pixels * 4);
  for (let p = 0; p < pixels; p++) {
    const src = p * channels;
    const dst = p * 4;
    rgba[dst] = bytes[src]!;
    rgba[dst + 1] = bytes[src + 1]!;
    rgba[dst + 2] = bytes[src + 2]!;
    rgba[dst + 3] = channels === 4 ? bytes[src + 3]! : 255;
  }
  return rgba;
}

// ---------------------------------------------------------------------------
// Sixel decoder (DCS body: `<P1;P2;P3>q<sixel data>`) → RGBA raster
// ---------------------------------------------------------------------------

interface Rgb {
  r: number;
  g: number;
  b: number;
}

/**
 * Decode a Sixel DCS body to RGBA. Handles raster attributes (`"`), color
 * registers (`#Pc` select / `#Pc;Pu;…` define), run-length (`!Pn`), carriage
 * return (`$`) and band advance (`-`). Sixels are 6 vertical pixels per data
 * char (`?`..`~`), LSB = topmost row of the current band.
 */
function decodeSixel(body: number[]): DecodeResult | null {
  const text = bytesToLatin1(body);
  const qIdx = text.indexOf("q");
  if (qIdx === -1) return null;
  // Bytes before `q` must be the numeric DCS params (P1;P2;P3) — reject other
  // DCS strings (DECRQSS, termcap, etc.) so we only ever decode real sixels.
  if (!/^[0-9;]*$/.test(text.slice(0, qIdx))) return null;
  const data = text.slice(qIdx + 1);

  const palette = defaultSixelPalette();
  // Grid stored as rows of color-index numbers (-1 = untouched/transparent).
  const grid: number[][] = [];
  let bandRow = 0; // index of the current 6-row band
  let x = 0;
  let curColor = 0;
  let maxX = 0;
  let declaredWidth = 0;
  let declaredHeight = 0;

  const paintColumn = (col: number): void => {
    const value = col - 0x3f; // 0..63, 6 significant bits
    for (let bit = 0; bit < 6; bit++) {
      if ((value & (1 << bit)) === 0) continue;
      const y = bandRow * 6 + bit;
      const row = (grid[y] ??= []);
      row[x] = curColor;
    }
    x++;
    if (x > maxX) maxX = x;
    if (x * (bandRow * 6 + 6) > MAX_RASTER_PIXELS) throw new SixelTooBig();
  };

  try {
    for (let i = 0; i < data.length; ) {
      const ch = data[i]!;
      const code = ch.charCodeAt(0);
      if (code >= 0x3f && code <= 0x7e) {
        paintColumn(code);
        i++;
      } else if (ch === "!") {
        const { value, next } = readInt(data, i + 1);
        const repeatCode = data.charCodeAt(next);
        i = next + 1;
        if (repeatCode >= 0x3f && repeatCode <= 0x7e) {
          for (let r = 0; r < value; r++) paintColumn(repeatCode);
        }
      } else if (ch === "#") {
        i = applyColorOp(data, i + 1, palette, (sel) => (curColor = sel));
      } else if (ch === '"') {
        // Raster attributes: Pan;Pad;Ph;Pv — we use Ph/Pv as size hints.
        const ras = readIntList(data, i + 1);
        i = ras.next;
        declaredWidth = ras.values[2] ?? 0;
        declaredHeight = ras.values[3] ?? 0;
      } else if (ch === "$") {
        x = 0;
        i++;
      } else if (ch === "-") {
        bandRow++;
        x = 0;
        i++;
      } else {
        i++; // ignore unknown control bytes
      }
    }
  } catch (err) {
    if (err instanceof SixelTooBig) return null;
    throw err;
  }

  const width = declaredWidth > 0 ? declaredWidth : maxX;
  const height = declaredHeight > 0 ? declaredHeight : grid.length;
  if (width <= 0 || height <= 0 || width * height > MAX_RASTER_PIXELS)
    return null;

  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const row = grid[y];
    for (let px = 0; px < width; px++) {
      const dst = (y * width + px) * 4;
      const ci = row?.[px];
      if (ci === undefined || ci < 0) {
        rgba[dst + 3] = 0; // transparent where nothing was painted
        continue;
      }
      const color = palette.get(ci) ?? { r: 0, g: 0, b: 0 };
      rgba[dst] = color.r;
      rgba[dst + 1] = color.g;
      rgba[dst + 2] = color.b;
      rgba[dst + 3] = 255;
    }
  }
  return {
    protocol: "sixel",
    payload: { kind: "raster", width, height, rgba },
    label: `Sixel ${width}×${height}`,
  };
}

class SixelTooBig extends Error {}

/**
 * Apply a `#` color op starting at `start` (just past the `#`). Either selects a
 * register (`#Pc`) or defines one (`#Pc;Pu;Px;Py;Pz`, Pu=2 RGB / Pu=1 HLS).
 * Returns the index just past the op.
 */
function applyColorOp(
  data: string,
  start: number,
  palette: Map<number, Rgb>,
  select: (idx: number) => void,
): number {
  const { values, next } = readIntList(data, start);
  const reg = values[0] ?? 0;
  if (values.length >= 5) {
    const system = values[1];
    const a = values[2] ?? 0;
    const b = values[3] ?? 0;
    const c = values[4] ?? 0;
    palette.set(reg, system === 1 ? hlsToRgb(a, b, c) : pctToRgb(a, b, c));
  }
  select(reg);
  return next;
}

/** Sixel RGB params are 0–100 percentages. */
function pctToRgb(r: number, g: number, b: number): Rgb {
  const s = (v: number) =>
    Math.round((Math.min(100, Math.max(0, v)) * 255) / 100);
  return { r: s(r), g: s(g), b: s(b) };
}

/** Sixel HLS: hue 0–360, lightness/saturation 0–100. */
function hlsToRgb(h: number, l: number, s: number): Rgb {
  const ln = Math.min(100, Math.max(0, l)) / 100;
  const sn = Math.min(100, Math.max(0, s)) / 100;
  if (sn === 0) {
    const v = Math.round(ln * 255);
    return { r: v, g: v, b: v };
  }
  const q = ln < 0.5 ? ln * (1 + sn) : ln + sn - ln * sn;
  const p = 2 * ln - q;
  // Sixel hue is offset: 0 = blue. Convert to standard hue (0 = red) by -120°.
  const hk = (((h - 120) % 360) + 360) / 360;
  const ch = (t: number) => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  return {
    r: Math.round(ch(hk + 1 / 3) * 255),
    g: Math.round(ch(hk) * 255),
    b: Math.round(ch(hk - 1 / 3) * 255),
  };
}

/** A small default palette so a sixel that never defines colors still renders. */
function defaultSixelPalette(): Map<number, Rgb> {
  const p = new Map<number, Rgb>();
  const base: Rgb[] = [
    { r: 0, g: 0, b: 0 },
    { r: 51, g: 51, b: 204 },
    { r: 204, g: 33, b: 33 },
    { r: 51, g: 204, b: 51 },
    { r: 204, g: 51, b: 204 },
    { r: 51, g: 204, b: 204 },
    { r: 204, g: 204, b: 51 },
    { r: 135, g: 135, b: 135 },
  ];
  for (let i = 0; i < 256; i++) p.set(i, base[i % base.length]!);
  return p;
}

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

/** Read a run of ASCII digits at `start`; returns the value and the next index. */
function readInt(s: string, start: number): { value: number; next: number } {
  let i = start;
  while (i < s.length && s.charCodeAt(i) >= 0x30 && s.charCodeAt(i) <= 0x39)
    i++;
  const value = i > start ? Number.parseInt(s.slice(start, i), 10) : 0;
  return { value, next: i };
}

/** Read a `;`-separated list of ints at `start`; returns values + next index. */
function readIntList(
  s: string,
  start: number,
): { values: number[]; next: number } {
  const values: number[] = [];
  let i = start;
  for (;;) {
    const r = readInt(s, i);
    values.push(r.value);
    i = r.next;
    if (s.charCodeAt(i) === 0x3b /* ; */) {
      i++;
      continue;
    }
    break;
  }
  return { values, next: i };
}

function parseIntOr(s: string | undefined, fallback: number): number {
  if (s === undefined) return fallback;
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) ? n : fallback;
}

/** Parse a `sep`-separated list of `key=value` pairs into a Map. */
function parseKvList(text: string, sep: string): Map<string, string> {
  const map = new Map<string, string>();
  if (text.length === 0) return map;
  for (const part of text.split(sep)) {
    const eq = part.indexOf("=");
    if (eq === -1) map.set(part, "");
    else map.set(part.slice(0, eq), part.slice(eq + 1));
  }
  return map;
}

/** Latin-1 decode: bytes 0–255 map 1:1 to char codes; lossless for ASCII bodies. */
function bytesToLatin1(bytes: ArrayLike<number>): string {
  let out = "";
  // Chunk to avoid String.fromCharCode argument-count limits on large bodies.
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const end = Math.min(i + CHUNK, bytes.length);
    out += String.fromCharCode(...Array.prototype.slice.call(bytes, i, end));
  }
  return out;
}

const B64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * Tolerant base64 → bytes. Self-contained (no atob) so the engine is
 * env-agnostic and fully testable; ignores whitespace and missing padding,
 * returns null on a non-base64 character so a malformed sequence is dropped
 * rather than silently mis-decoded. [LAW:no-silent-failure]
 */
function decodeBase64(input: string): Uint8Array | null {
  const lut = base64Lut();
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    if (ch === 0x3d /* = */) break; // padding: ignore the tail
    if (ch === 0x0a || ch === 0x0d || ch === 0x20 || ch === 0x09) continue; // ws
    const v = lut[ch];
    if (v === undefined) return null;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

let _b64Lut: (number | undefined)[] | null = null;
function base64Lut(): (number | undefined)[] {
  if (_b64Lut !== null) return _b64Lut;
  const lut: (number | undefined)[] = new Array(128).fill(undefined);
  for (let i = 0; i < B64_ALPHABET.length; i++) {
    lut[B64_ALPHABET.charCodeAt(i)] = i;
  }
  _b64Lut = lut;
  return lut;
}

/** Sniff a MIME type from the leading magic bytes of an encoded image. */
function sniffMime(bytes: Uint8Array): string {
  if (matches(bytes, [0x89, 0x50, 0x4e, 0x47])) return "image/png";
  if (matches(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (matches(bytes, [0x47, 0x49, 0x46, 0x38])) return "image/gif";
  if (matches(bytes, [0x42, 0x4d])) return "image/bmp";
  if (
    matches(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    bytes.length >= 12 &&
    matches(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50])
  ) {
    return "image/webp";
  }
  return "application/octet-stream";
}

function matches(bytes: Uint8Array, prefix: number[]): boolean {
  if (bytes.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++)
    if (bytes[i] !== prefix[i]) return false;
  return true;
}

function mimeShort(mime: string): string {
  const slash = mime.indexOf("/");
  return (slash === -1 ? mime : mime.slice(slash + 1)).toUpperCase();
}
