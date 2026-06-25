// examples/web-multiplexer/web/escape-parse-engine.ts
//
// EscapeParseEngine — the pure core of the escape-code playground. Two
// functions, no IO:
//
//   interpretEscapes(text)  — turn human escape notation (`\e[31m`, `\x1b`,
//                             `\n`, `\033`) into the actual string the user
//                             means to send.
//   parseEscapes(bytes)     — classify a byte run into a discriminated union of
//                             VT500 events (text / C0 / CSI / OSC / ESC / string
//                             / incomplete), each carrying a human description.
//
// The playground is string-native by deliberate design. [LAW:one-source-of-truth]
//   the send path is the library's `sendKeys`, which transmits `send-keys -H`
//   over `utf8HexBytes(s)` — the UTF-8 encoding of the JS string. So the bytes
//   this demo *displays and parses* are exactly `TextEncoder.encode(s)`, the
//   same bytes the library puts on the wire. For the entire 7-bit ANSI
//   repertoire (every escape sequence in the showcase) that encoding is the
//   byte sequence verbatim; the round-trip is byte-faithful and what you see is
//   what is sent. No second byte representation to drift from.
//
// [LAW:effects-at-boundaries] Zero IO, zero MobX, no DOM. Bytes/strings in,
//   structured events out — a pure function, exhaustively unit-tested. The pane
//   lifecycle and the terminal rendering live at the boundary (the store/view).
// [LAW:dataflow-not-control-flow] `parseEscapes` walks one state machine and
//   emits one event per syntactic unit. "Not an escape sequence" is the `text`
//   event (a value), never a skipped branch.

// ---------------------------------------------------------------------------
// interpretEscapes — human escape notation → real string
// ---------------------------------------------------------------------------

const NAMED_ESCAPES: Readonly<Record<string, number>> = {
  // Terminal convention: `\e` / `\E` is ESC. Not C, but every shell prompt and
  // `printf '\e[...'` uses it, so the playground honors it.
  e: 0x1b,
  E: 0x1b,
  a: 0x07, // BEL
  b: 0x08, // BS
  t: 0x09, // HT
  n: 0x0a, // LF
  v: 0x0b, // VT
  f: 0x0c, // FF
  r: 0x0d, // CR
};

function isOctalDigit(ch: string): boolean {
  return ch >= "0" && ch <= "7";
}

function isHexDigit(ch: string): boolean {
  return (
    (ch >= "0" && ch <= "9") ||
    (ch >= "a" && ch <= "f") ||
    (ch >= "A" && ch <= "F")
  );
}

/**
 * Interpret C-style escape notation into the literal string the user intends.
 * Recognized: `\e`/`\E` (ESC), `\a \b \t \n \v \f \r`, `\xHH` (1–2 hex),
 * `\uHHHH` (4 hex), `\NNN` (1–3 octal), `\\`. An unrecognized escape (`\q`,
 * a path's `C:\Users`) keeps the backslash literal and re-processes the next
 * character normally — least-surprising for a playground where most input is
 * not actually escaped.
 *
 * [LAW:no-silent-failure] Nothing is silently dropped: an unknown escape
 *   survives as a literal backslash rather than vanishing, so the byte view
 *   always honestly reflects what gets sent.
 */
export function interpretEscapes(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch !== "\\") {
      out += ch;
      i += 1;
      continue;
    }
    // A trailing lone backslash is a literal backslash.
    if (i + 1 >= text.length) {
      out += "\\";
      i += 1;
      continue;
    }
    const next = text[i + 1];
    const named = NAMED_ESCAPES[next];
    if (named !== undefined) {
      out += String.fromCharCode(named);
      i += 2;
      continue;
    }
    if (next === "\\") {
      out += "\\";
      i += 2;
      continue;
    }
    if (next === "x") {
      // \xH or \xHH
      let hex = "";
      let j = i + 2;
      while (j < text.length && hex.length < 2 && isHexDigit(text[j])) {
        hex += text[j];
        j += 1;
      }
      if (hex.length > 0) {
        out += String.fromCodePoint(parseInt(hex, 16));
        i = j;
        continue;
      }
      // `\x` with no hex digit — keep the backslash literal.
      out += "\\";
      i += 1;
      continue;
    }
    if (next === "u") {
      // \uHHHH (exactly 4 hex). Anything short keeps the backslash literal.
      let hex = "";
      let j = i + 2;
      while (j < text.length && hex.length < 4 && isHexDigit(text[j])) {
        hex += text[j];
        j += 1;
      }
      if (hex.length === 4) {
        out += String.fromCodePoint(parseInt(hex, 16));
        i = j;
        continue;
      }
      out += "\\";
      i += 1;
      continue;
    }
    if (isOctalDigit(next)) {
      // \N, \NN, or \NNN
      let oct = "";
      let j = i + 1;
      while (j < text.length && oct.length < 3 && isOctalDigit(text[j])) {
        oct += text[j];
        j += 1;
      }
      out += String.fromCodePoint(parseInt(oct, 8) & 0xff);
      i = j;
      continue;
    }
    // Unrecognized escape: keep the backslash literal, re-process `next`.
    out += "\\";
    i += 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// parseEscapes — byte run → discriminated union of VT events
// ---------------------------------------------------------------------------

/** One decoded SGR (Select Graphic Rendition) attribute. */
export interface SgrToken {
  /** Human label, e.g. `bold`, `fg red`, `fg 256-color #5 (cyan)`. */
  readonly label: string;
  /** Concrete CSS color when this token selects one (for a UI swatch). */
  readonly color?: string;
  /** Which plane the color applies to, when `color` is set. */
  readonly plane?: "fg" | "bg";
}

export type EscapeEvent =
  | {
      readonly kind: "text";
      readonly text: string;
      readonly byteLength: number;
    }
  | {
      readonly kind: "c0";
      readonly byte: number;
      readonly name: string;
      readonly desc: string;
    }
  | {
      readonly kind: "csi";
      /** Raw parameter bytes between `ESC [` and the final, e.g. `1;31`. */
      readonly params: string;
      /** Intermediate bytes (0x20–0x2f), usually empty. */
      readonly intermediates: string;
      /** Final byte as a character, e.g. `m`, `H`, `A`. */
      readonly final: string;
      readonly desc: string;
      /** Decoded SGR attributes when `final === "m"`. */
      readonly sgr?: readonly SgrToken[];
      readonly byteLength: number;
    }
  | {
      readonly kind: "osc";
      /** The numeric command (`Ps`) before the first `;`, e.g. `0`, `1337`. */
      readonly ps: string;
      readonly payload: string;
      readonly terminator: "ST" | "BEL" | "none";
      readonly desc: string;
      readonly byteLength: number;
    }
  | {
      readonly kind: "esc";
      /** Intermediate bytes (0x20–0x2f), e.g. `(` in `ESC ( B`. */
      readonly intermediates: string;
      readonly final: string;
      readonly desc: string;
      readonly byteLength: number;
    }
  | {
      readonly kind: "string";
      readonly type: "DCS" | "APC" | "PM" | "SOS";
      readonly payload: string;
      readonly terminator: "ST" | "BEL" | "none";
      readonly desc: string;
      readonly byteLength: number;
    }
  | {
      /** A sequence that ran off the end of the input — shown so a half-typed
       *  escape is visible rather than silently swallowed. */
      readonly kind: "incomplete";
      readonly raw: string;
      readonly desc: string;
      readonly byteLength: number;
    };

const ESC = 0x1b;
const BEL = 0x07;
const ST_FINAL = 0x5c; // `\` — second byte of String Terminator `ESC \`

const C0_NAMES: Readonly<Record<number, readonly [string, string]>> = {
  0x00: ["NUL", "null"],
  0x07: ["BEL", "bell"],
  0x08: ["BS", "backspace"],
  0x09: ["HT", "tab"],
  0x0a: ["LF", "line feed (newline)"],
  0x0b: ["VT", "vertical tab"],
  0x0c: ["FF", "form feed"],
  0x0d: ["CR", "carriage return"],
  0x7f: ["DEL", "delete"],
};

const CSI_FINALS: Readonly<Record<string, string>> = {
  A: "cursor up",
  B: "cursor down",
  C: "cursor forward",
  D: "cursor back",
  E: "cursor next line",
  F: "cursor previous line",
  G: "cursor horizontal absolute (column)",
  H: "cursor position (row;col)",
  f: "cursor position (row;col)",
  J: "erase in display",
  K: "erase in line",
  L: "insert lines",
  M: "delete lines",
  P: "delete characters",
  S: "scroll up",
  T: "scroll down",
  X: "erase characters",
  "@": "insert characters",
  d: "line position absolute (row)",
  m: "select graphic rendition (SGR)",
  n: "device status report",
  r: "set scrolling region",
  s: "save cursor position",
  u: "restore cursor position",
  h: "set mode",
  l: "reset mode",
};

const OSC_PS: Readonly<Record<string, string>> = {
  "0": "set icon name + window title",
  "1": "set icon name",
  "2": "set window title",
  "4": "set/query color palette",
  "7": "set working directory",
  "8": "hyperlink",
  "9": "post notification (iTerm2/growl)",
  "10": "set foreground color",
  "11": "set background color",
  "52": "clipboard set/query",
  "133": "shell prompt mark (FinalTerm/iTerm2)",
  "1337": "iTerm2 proprietary (file, set var, …)",
};

const SGR_SIMPLE: Readonly<Record<number, string>> = {
  0: "reset all",
  1: "bold",
  2: "dim",
  3: "italic",
  4: "underline",
  5: "blink",
  7: "reverse video",
  8: "conceal",
  9: "strikethrough",
  21: "double underline",
  22: "normal intensity",
  23: "not italic",
  24: "not underlined",
  25: "not blinking",
  27: "not reversed",
  28: "reveal",
  29: "not strikethrough",
  39: "default foreground",
  49: "default background",
};

// 16-color names in SGR order (30–37 fg / 40–47 bg; bright at 90–97 / 100–107).
const COLOR_NAMES = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
] as const;

// CSS for the basic + bright palette (xterm-ish), indexed 0–15.
const PALETTE_16 = [
  "#000000",
  "#cd0000",
  "#00cd00",
  "#cdcd00",
  "#0000ee",
  "#cd00cd",
  "#00cdcd",
  "#e5e5e5",
  "#7f7f7f",
  "#ff0000",
  "#00ff00",
  "#ffff00",
  "#5c5cff",
  "#ff00ff",
  "#00ffff",
  "#ffffff",
] as const;

/** Resolve an xterm 256-color index to CSS — used for SGR `38;5;n` swatches. */
function css256(n: number): string {
  if (n < 16) return PALETTE_16[n] ?? "#000000";
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return `rgb(${v},${v},${v})`;
  }
  const c = n - 16;
  const r = Math.floor(c / 36);
  const g = Math.floor((c % 36) / 6);
  const b = c % 6;
  const step = (x: number): number => (x === 0 ? 0 : 55 + x * 40);
  return `rgb(${step(r)},${step(g)},${step(b)})`;
}

/**
 * Decode a CSI `m` parameter list into SGR tokens. Handles simple attributes,
 * the 30–37/40–47 + 90–97/100–107 palette, and the `38/48;5;n` (256) and
 * `38/48;2;r;g;b` (truecolor) extended forms. An empty parameter string means
 * SGR 0 (reset), per the spec.
 */
function decodeSgr(params: string): SgrToken[] {
  const nums =
    params === ""
      ? [0]
      : params.split(";").map((p) => (p === "" ? 0 : parseInt(p, 10)));
  const tokens: SgrToken[] = [];
  for (let i = 0; i < nums.length; i++) {
    const n = nums[i];
    if (Number.isNaN(n)) continue;
    const simple = SGR_SIMPLE[n];
    if (simple !== undefined) {
      tokens.push({ label: simple });
      continue;
    }
    if (n >= 30 && n <= 37) {
      tokens.push({
        label: `fg ${COLOR_NAMES[n - 30]}`,
        color: PALETTE_16[n - 30],
        plane: "fg",
      });
      continue;
    }
    if (n >= 40 && n <= 47) {
      tokens.push({
        label: `bg ${COLOR_NAMES[n - 40]}`,
        color: PALETTE_16[n - 40],
        plane: "bg",
      });
      continue;
    }
    if (n >= 90 && n <= 97) {
      tokens.push({
        label: `fg bright ${COLOR_NAMES[n - 90]}`,
        color: PALETTE_16[n - 90 + 8],
        plane: "fg",
      });
      continue;
    }
    if (n >= 100 && n <= 107) {
      tokens.push({
        label: `bg bright ${COLOR_NAMES[n - 100]}`,
        color: PALETTE_16[n - 100 + 8],
        plane: "bg",
      });
      continue;
    }
    if (n === 38 || n === 48) {
      const plane: "fg" | "bg" = n === 38 ? "fg" : "bg";
      const mode = nums[i + 1];
      if (mode === 5 && i + 2 < nums.length) {
        const idx = nums[i + 2];
        tokens.push({
          label: `${plane} 256-color #${idx}`,
          color: css256(idx),
          plane,
        });
        i += 2;
        continue;
      }
      if (mode === 2 && i + 4 < nums.length) {
        const r = nums[i + 2];
        const g = nums[i + 3];
        const b = nums[i + 4];
        tokens.push({
          label: `${plane} truecolor ${r},${g},${b}`,
          color: `rgb(${r},${g},${b})`,
          plane,
        });
        i += 4;
        continue;
      }
      tokens.push({ label: `${plane} extended color (malformed)` });
      continue;
    }
    tokens.push({ label: `SGR ${n}` });
  }
  return tokens;
}

function describeCsi(
  params: string,
  intermediates: string,
  final: string,
): string {
  const base = CSI_FINALS[final];
  const isPrivate = params.startsWith("?");
  const prefix = isPrivate ? "private mode " : "";
  const name = base ?? `CSI ${final}`;
  const detail = params === "" ? "" : ` (${params})`;
  const inter = intermediates === "" ? "" : ` [int ${intermediates}]`;
  if (isPrivate && (final === "h" || final === "l")) {
    return `${prefix}${final === "h" ? "set" : "reset"}${detail}${inter}`;
  }
  return `${name}${detail}${inter}`;
}

function describeEsc(intermediates: string, final: string): string {
  if (intermediates === "") {
    const known: Readonly<Record<string, string>> = {
      c: "RIS — full reset",
      D: "index (line feed)",
      E: "next line",
      H: "set tab stop",
      M: "reverse index",
      "7": "save cursor (DECSC)",
      "8": "restore cursor (DECRC)",
      "=": "keypad application mode",
      ">": "keypad numeric mode",
    };
    return known[final] ?? `ESC ${final}`;
  }
  if (intermediates === "(" || intermediates === ")") {
    return `designate ${intermediates === "(" ? "G0" : "G1"} charset → ${final}`;
  }
  return `ESC ${intermediates}${final}`;
}

const STRING_INTRO: Readonly<Record<number, "DCS" | "APC" | "PM" | "SOS">> = {
  0x50: "DCS", // ESC P
  0x5f: "APC", // ESC _
  0x5e: "PM", // ESC ^
  0x58: "SOS", // ESC X
};

const STRING_DESC: Readonly<Record<string, string>> = {
  DCS: "device control string",
  APC: "application program command",
  PM: "privacy message",
  SOS: "start of string",
};

/**
 * Classify a byte run into structured VT events. Single forward pass; the input
 * is a complete buffer (the playground's textarea), so — unlike the image
 * sniffer's resumable scanner — no cross-chunk state is carried. A sequence
 * that runs off the end becomes one `incomplete` event so a half-typed escape
 * stays visible. [LAW:dataflow-not-control-flow]
 */
export function parseEscapes(bytes: Uint8Array): EscapeEvent[] {
  const events: EscapeEvent[] = [];
  const decoder = new TextDecoder("utf-8");
  let i = 0;
  const n = bytes.length;

  const isParamByte = (b: number): boolean => b >= 0x30 && b <= 0x3f;
  const isIntermediate = (b: number): boolean => b >= 0x20 && b <= 0x2f;
  const isFinal = (b: number): boolean => b >= 0x40 && b <= 0x7e;

  while (i < n) {
    const b = bytes[i];

    // --- ESC-introduced sequences ---
    if (b === ESC) {
      const start = i;
      if (i + 1 >= n) {
        events.push({
          kind: "incomplete",
          raw: "ESC",
          desc: "lone ESC at end of input",
          byteLength: 1,
        });
        break;
      }
      const second = bytes[i + 1];

      // CSI: ESC [
      if (second === 0x5b) {
        let j = i + 2;
        let params = "";
        while (j < n && isParamByte(bytes[j])) {
          params += String.fromCharCode(bytes[j]);
          j += 1;
        }
        let intermediates = "";
        while (j < n && isIntermediate(bytes[j])) {
          intermediates += String.fromCharCode(bytes[j]);
          j += 1;
        }
        if (j < n && isFinal(bytes[j])) {
          const final = String.fromCharCode(bytes[j]);
          j += 1;
          const sgr = final === "m" ? decodeSgr(params) : undefined;
          events.push({
            kind: "csi",
            params,
            intermediates,
            final,
            desc: describeCsi(params, intermediates, final),
            ...(sgr !== undefined ? { sgr } : {}),
            byteLength: j - start,
          });
          i = j;
          continue;
        }
        events.push({
          kind: "incomplete",
          raw: `ESC [ ${params}${intermediates}`,
          desc: "CSI with no final byte",
          byteLength: j - start,
        });
        break;
      }

      // OSC: ESC ]
      if (second === 0x5d) {
        const { ps, payload, terminator, end } = scanString(bytes, i + 2);
        events.push({
          kind: "osc",
          ps,
          payload,
          terminator,
          desc: `OSC ${ps}${OSC_PS[ps] !== undefined ? ` — ${OSC_PS[ps]}` : ""}`,
          byteLength: end - start,
        });
        i = end;
        if (terminator === "none") break;
        continue;
      }

      // DCS / APC / PM / SOS string sequences
      const stringType = STRING_INTRO[second];
      if (stringType !== undefined) {
        const { payload, terminator, end } = scanString(bytes, i + 2);
        events.push({
          kind: "string",
          type: stringType,
          payload,
          terminator,
          desc: `${stringType} — ${STRING_DESC[stringType]}`,
          byteLength: end - start,
        });
        i = end;
        if (terminator === "none") break;
        continue;
      }

      // nF / Fp / Fe escapes: optional intermediates then a final.
      let j = i + 1;
      let intermediates = "";
      while (j < n && isIntermediate(bytes[j])) {
        intermediates += String.fromCharCode(bytes[j]);
        j += 1;
      }
      if (j < n && bytes[j] >= 0x30 && bytes[j] <= 0x7e) {
        const final = String.fromCharCode(bytes[j]);
        j += 1;
        events.push({
          kind: "esc",
          intermediates,
          final,
          desc: describeEsc(intermediates, final),
          byteLength: j - start,
        });
        i = j;
        continue;
      }
      events.push({
        kind: "incomplete",
        raw: `ESC ${intermediates}`,
        desc: "ESC with no final byte",
        byteLength: j - start,
      });
      break;
    }

    // --- C0 control bytes (not ESC) ---
    if (b < 0x20 || b === 0x7f) {
      const entry = C0_NAMES[b];
      const hex = b.toString(16).padStart(2, "0");
      events.push({
        kind: "c0",
        byte: b,
        name: entry !== undefined ? entry[0] : `0x${hex}`,
        desc: entry !== undefined ? entry[1] : `control 0x${hex}`,
      });
      i += 1;
      continue;
    }

    // --- printable run: accumulate until the next control/ESC byte ---
    let j = i;
    while (j < n && bytes[j] >= 0x20 && bytes[j] !== 0x7f && bytes[j] !== ESC) {
      j += 1;
    }
    const slice = bytes.subarray(i, j);
    events.push({
      kind: "text",
      text: decoder.decode(slice),
      byteLength: slice.length,
    });
    i = j;
  }

  return events;
}

/**
 * Scan an OSC/DCS/APC/PM/SOS string body starting at `from`, up to a String
 * Terminator (`ESC \`) or BEL. Returns the leading numeric `ps` (everything
 * before the first `;`), the remaining payload, the terminator kind, and the
 * index one past the terminator (or end of input when unterminated).
 */
function scanString(
  bytes: Uint8Array,
  from: number,
): {
  ps: string;
  payload: string;
  terminator: "ST" | "BEL" | "none";
  end: number;
} {
  const n = bytes.length;
  let j = from;
  const body: number[] = [];
  let terminator: "ST" | "BEL" | "none" = "none";
  while (j < n) {
    const b = bytes[j];
    if (b === BEL) {
      terminator = "BEL";
      j += 1;
      break;
    }
    if (b === ESC && j + 1 < n && bytes[j + 1] === ST_FINAL) {
      terminator = "ST";
      j += 2;
      break;
    }
    body.push(b);
    j += 1;
  }
  const raw = String.fromCharCode(...body);
  const semi = raw.indexOf(";");
  const ps = semi === -1 ? raw : raw.slice(0, semi);
  const payload = semi === -1 ? "" : raw.slice(semi + 1);
  return { ps, payload, terminator, end: j };
}

// ---------------------------------------------------------------------------
// analyze — convenience for the view: text → bytes + events together
// ---------------------------------------------------------------------------

export interface Analysis {
  /** The interpreted string (escape notation resolved). */
  readonly interpreted: string;
  /** UTF-8 bytes — exactly what `sendKeys` transmits via `send-keys -H`. */
  readonly bytes: Uint8Array;
  readonly events: readonly EscapeEvent[];
}

/**
 * One call for the view: interpret escape notation, encode to the bytes the
 * library will send, and classify them. [LAW:one-source-of-truth] the bytes
 * here are the bytes sent — `interpreted` is passed straight to `sendKeys`.
 */
export function analyze(text: string): Analysis {
  const interpreted = interpretEscapes(text);
  const bytes = new TextEncoder().encode(interpreted);
  return { interpreted, bytes, events: parseEscapes(bytes) };
}
