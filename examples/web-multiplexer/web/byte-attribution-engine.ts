// examples/web-multiplexer/web/byte-attribution-engine.ts
//
// The pure core of the "Who wrote this byte?" demo: a VT emulator that, as it
// folds a pane's byte stream into a character grid, records for EVERY rendered
// cell the exact source byte that produced it — which firehose chunk, at what
// time, at what offset. xterm.js cannot answer this: it is a lossy projection
// (bytes in, grid out, the byte→cell function discarded inside). So this module
// IS the emulator — the grid and its provenance come from ONE pass over ONE
// stream and therefore cannot disagree. [LAW:one-source-of-truth]
//
// [LAW:effects-at-boundaries] Zero IO, zero MobX, zero DOM. The firehose that
//   supplies bytes, the wall clock that stamps `tMs`, and the grid renderer all
//   live in the store/view. This module is a deterministic projection of its
//   inputs, exhaustively unit-tested against synthetic chunk runs.
// [LAW:no-ambient-temporal-coupling] A CSI sequence — or a multi-byte UTF-8
//   grapheme — can split across arbitrary chunk boundaries (the live firehose
//   does not respect sequence framing). The emulator carries parser state across
//   `pushBytes` calls and attributes a glyph to the chunk/offset of its FIRST
//   byte, regardless of where the rest arrived. Correctness never depends on a
//   chunk containing a whole sequence.
// [LAW:single-enforcer] SGR color resolution reuses `escape-parse-engine`'s
//   palette — the one index→CSS authority — rather than minting a second.

import { PALETTE_16, css256 } from "./escape-parse-engine.ts";

/** Character-grid geometry the emulator lays cells out on. */
export interface GridSize {
  readonly cols: number;
  readonly rows: number;
}

/**
 * One captured run of bytes from one pane: the store stamps each firehose
 * delivery with a monotonic `chunkId` (the "%output chunk" the ticket names), an
 * arrival `tMs` relative to capture start, and `baseOffset` — the absolute count
 * of bytes the pane emitted before this chunk, so a cell's stream offset stays
 * stable even after the oldest chunks are evicted from the store's window.
 */
export interface SourceChunk {
  readonly chunkId: number;
  readonly tMs: number;
  readonly baseOffset: number;
  readonly bytes: Uint8Array;
}

/**
 * Provenance of a single rendered cell: the grapheme shown, plus the source
 * byte that wrote it. A written space (the program printed `' '`) is an
 * `AttributedCell`; a never-written / erased cell is `null` — the distinction
 * the hover UI needs to tell "blank because cleared" from "blank because typed".
 */
export interface AttributedCell {
  /** The grapheme rendered here (a single codepoint; `' '` is a written space). */
  readonly char: string;
  /** Which firehose chunk produced this cell. */
  readonly chunkId: number;
  /** Arrival time of that chunk, ms since capture began. */
  readonly tMs: number;
  /** Offset of the grapheme's FIRST byte within its chunk. */
  readonly byteOffset: number;
  /** Absolute offset of that byte in the pane's lifetime stream. */
  readonly streamOffset: number;
  /** Resolved CSS foreground, or null for the terminal default. */
  readonly fg: string | null;
  /** Resolved CSS background, or null for the terminal default. */
  readonly bg: string | null;
  readonly bold: boolean;
}

/** The emulator's current screen: cells row-major, plus the cursor. */
export interface AttributionGrid {
  readonly cols: number;
  readonly rows: number;
  readonly cursorRow: number;
  readonly cursorCol: number;
  /** Row-major, length `rows*cols`; `null` = blank (never written or erased). */
  readonly cells: readonly (AttributedCell | null)[];
}

const ESC = 0x1b;
const BEL = 0x07;

/** The pen folded from SGR — the style stamped onto cells as they're written. */
interface Pen {
  fg: string | null;
  bg: string | null;
  bold: boolean;
}

const DEFAULT_PEN: Pen = { fg: null, bg: null, bold: false };

type Mode = "ground" | "esc" | "escInter" | "csi" | "string" | "stringEsc";

/**
 * A stateful VT emulator with byte attribution. Construct at a fixed geometry,
 * `pushBytes` chunks in capture order (splits across calls are fine), and
 * `snapshot` the grid at any point. Stateful by nature — a terminal IS its
 * accumulated screen — but the mutation is wholly contained: no IO, and `emulate`
 * exposes it as a pure chunks→grid function for tests and full rebuilds.
 */
export class AttributionEngine {
  private readonly cols: number;
  private readonly rows: number;
  private cells: (AttributedCell | null)[];

  private row = 0;
  private col = 0;
  /** Deferred-wrap (DEC pending-wrap): set when a glyph lands in the last
   *  column; the NEXT glyph wraps. Matches xterm so columns line up. */
  private wrapPending = false;

  // Scroll region (DECSTBM), inclusive row bounds; default the whole screen.
  private top = 0;
  private bottom: number;

  private pen: Pen = { ...DEFAULT_PEN };

  // Saved cursor (DECSC/DECRC).
  private saved: { row: number; col: number; pen: Pen } | null = null;

  // --- parser state, carried across pushBytes ---
  private mode: Mode = "ground";
  private csiParams = "";
  private csiInter = "";
  // Pending multi-byte UTF-8 grapheme: continuation bytes still expected, and
  // the codepoint accumulated so far.
  private utf8Need = 0;
  private utf8Cp = 0;
  /** Chunk/offset of the first byte of the grapheme currently being assembled. */
  private glyphOrigin: {
    chunkId: number;
    tMs: number;
    byteOffset: number;
    streamOffset: number;
  } | null = null;

  constructor(size: GridSize) {
    this.cols = Math.max(1, size.cols);
    this.rows = Math.max(1, size.rows);
    this.bottom = this.rows - 1;
    this.cells = new Array<AttributedCell | null>(this.cols * this.rows).fill(
      null,
    );
  }

  /** Feed one chunk. Each byte's provenance is its position within this chunk. */
  pushBytes(chunk: SourceChunk): void {
    const { bytes } = chunk;
    let i = 0;
    while (i < bytes.length) {
      const b = bytes[i];
      const origin = {
        chunkId: chunk.chunkId,
        tMs: chunk.tMs,
        byteOffset: i,
        streamOffset: chunk.baseOffset + i,
      };
      // step returns false to reprocess the same byte under a new mode.
      if (this.step(b, origin)) i += 1;
    }
  }

  /** An immutable view of the current screen. */
  snapshot(): AttributionGrid {
    return {
      cols: this.cols,
      rows: this.rows,
      cursorRow: this.row,
      cursorCol: this.col,
      cells: this.cells.slice(),
    };
  }

  // -------------------------------------------------------------------------
  // Byte dispatch
  // -------------------------------------------------------------------------

  private step(
    b: number,
    origin: {
      chunkId: number;
      tMs: number;
      byteOffset: number;
      streamOffset: number;
    },
  ): boolean {
    switch (this.mode) {
      case "ground":
        return this.stepGround(b, origin);
      case "esc":
        return this.stepEsc(b);
      case "escInter":
        // Consume intermediates; the first non-intermediate is the (ignored) final.
        if (b >= 0x20 && b <= 0x2f) return true;
        this.mode = "ground";
        return true;
      case "csi":
        return this.stepCsi(b);
      case "string":
        if (b === BEL) this.mode = "ground";
        else if (b === ESC) this.mode = "stringEsc";
        return true;
      case "stringEsc":
        if (b === 0x5c) {
          this.mode = "ground"; // ST (ESC \) terminates the string.
          return true;
        }
        // A bare ESC mid-string starts a new sequence — reprocess under esc.
        this.mode = "esc";
        return false;
    }
  }

  private stepGround(
    b: number,
    origin: {
      chunkId: number;
      tMs: number;
      byteOffset: number;
      streamOffset: number;
    },
  ): boolean {
    // Mid-grapheme UTF-8 continuation takes priority over everything.
    if (this.utf8Need > 0) {
      if (b >= 0x80 && b <= 0xbf) {
        this.utf8Cp = (this.utf8Cp << 6) | (b & 0x3f);
        this.utf8Need -= 1;
        if (this.utf8Need === 0) this.flushUtf8();
        return true;
      }
      // Malformed: drop the partial grapheme and reprocess this byte fresh.
      this.utf8Need = 0;
      this.glyphOrigin = null;
    }

    if (b === ESC) {
      this.mode = "esc";
      return true;
    }
    if (b === 0x7f) return true; // DEL — no rendered effect.
    if (b < 0x20) {
      this.handleC0(b);
      return true;
    }
    if (b < 0x80) {
      this.writeGlyph(String.fromCharCode(b), origin);
      return true;
    }
    // UTF-8 lead byte.
    this.glyphOrigin = origin;
    if (b >= 0xf0) {
      this.utf8Need = 3;
      this.utf8Cp = b & 0x07;
    } else if (b >= 0xe0) {
      this.utf8Need = 2;
      this.utf8Cp = b & 0x0f;
    } else if (b >= 0xc0) {
      this.utf8Need = 1;
      this.utf8Cp = b & 0x1f;
    } else {
      // Stray continuation byte with no lead — render the replacement char so
      // nothing is silently dropped. [LAW:no-silent-failure]
      this.writeGlyph("�", origin);
    }
    return true;
  }

  private flushUtf8(): void {
    const origin = this.glyphOrigin;
    this.glyphOrigin = null;
    const cp = this.utf8Cp;
    const char = cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : "�";
    if (origin !== null) this.writeGlyph(char, origin);
  }

  private stepEsc(b: number): boolean {
    if (b === 0x5b) {
      this.mode = "csi";
      this.csiParams = "";
      this.csiInter = "";
      return true;
    }
    // OSC (]) / DCS (P) / APC (_) / PM (^) / SOS (X) → consume to ST/BEL.
    if (b === 0x5d || b === 0x50 || b === 0x5f || b === 0x5e || b === 0x58) {
      this.mode = "string";
      return true;
    }
    if (b >= 0x20 && b <= 0x2f) {
      this.mode = "escInter"; // a designator (e.g. ESC ( B) — consume + ignore.
      return true;
    }
    // A direct Fe/Fp final.
    this.applyEscFinal(b);
    this.mode = "ground";
    return true;
  }

  private applyEscFinal(b: number): void {
    switch (b) {
      case 0x44: // ESC D — IND (index / line feed)
        this.lineFeed();
        break;
      case 0x45: // ESC E — NEL (next line)
        this.col = 0;
        this.wrapPending = false;
        this.lineFeed();
        break;
      case 0x4d: // ESC M — RI (reverse index)
        this.reverseIndex();
        break;
      case 0x63: // ESC c — RIS (full reset)
        this.resetScreen();
        break;
      default:
        break; // charset designators, keypad modes, etc. — no grid effect.
    }
  }

  private stepCsi(b: number): boolean {
    if (b >= 0x30 && b <= 0x3f && this.csiInter === "") {
      this.csiParams += String.fromCharCode(b);
      return true;
    }
    if (b >= 0x20 && b <= 0x2f) {
      this.csiInter += String.fromCharCode(b);
      return true;
    }
    if (b >= 0x40 && b <= 0x7e) {
      this.applyCsi(this.csiParams, String.fromCharCode(b));
      this.mode = "ground";
      return true;
    }
    // Anything else aborts the (malformed) sequence.
    this.mode = "ground";
    return true;
  }

  // -------------------------------------------------------------------------
  // Grid operations
  // -------------------------------------------------------------------------

  private idx(row: number, col: number): number {
    return row * this.cols + col;
  }

  private writeGlyph(
    char: string,
    origin: {
      chunkId: number;
      tMs: number;
      byteOffset: number;
      streamOffset: number;
    },
  ): void {
    if (this.wrapPending) {
      this.col = 0;
      this.lineFeed();
      this.wrapPending = false;
    }
    this.cells[this.idx(this.row, this.col)] = {
      char,
      chunkId: origin.chunkId,
      tMs: origin.tMs,
      byteOffset: origin.byteOffset,
      streamOffset: origin.streamOffset,
      fg: this.pen.fg,
      bg: this.pen.bg,
      bold: this.pen.bold,
    };
    if (this.col + 1 >= this.cols) this.wrapPending = true;
    else this.col += 1;
  }

  private handleC0(b: number): void {
    switch (b) {
      case 0x08: // BS
        if (this.col > 0) this.col -= 1;
        this.wrapPending = false;
        break;
      case 0x09: // HT — next 8-column tab stop
        this.col = Math.min(this.cols - 1, (Math.floor(this.col / 8) + 1) * 8);
        this.wrapPending = false;
        break;
      case 0x0a: // LF
      case 0x0b: // VT
      case 0x0c: // FF
        this.lineFeed();
        break;
      case 0x0d: // CR
        this.col = 0;
        this.wrapPending = false;
        break;
      default:
        break; // BEL etc. — no grid effect.
    }
  }

  private lineFeed(): void {
    this.wrapPending = false;
    if (this.row === this.bottom) this.scrollUp();
    else if (this.row < this.rows - 1) this.row += 1;
  }

  private reverseIndex(): void {
    this.wrapPending = false;
    if (this.row === this.top) this.scrollDown();
    else if (this.row > 0) this.row -= 1;
  }

  /** Scroll the region up one line; the freed bottom row goes blank. */
  private scrollUp(): void {
    for (let r = this.top; r < this.bottom; r++) {
      for (let c = 0; c < this.cols; c++) {
        this.cells[this.idx(r, c)] = this.cells[this.idx(r + 1, c)];
      }
    }
    this.blankRow(this.bottom);
  }

  private scrollDown(): void {
    for (let r = this.bottom; r > this.top; r--) {
      for (let c = 0; c < this.cols; c++) {
        this.cells[this.idx(r, c)] = this.cells[this.idx(r - 1, c)];
      }
    }
    this.blankRow(this.top);
  }

  private blankRow(row: number): void {
    for (let c = 0; c < this.cols; c++) this.cells[this.idx(row, c)] = null;
  }

  private resetScreen(): void {
    this.cells.fill(null);
    this.row = 0;
    this.col = 0;
    this.wrapPending = false;
    this.top = 0;
    this.bottom = this.rows - 1;
    this.pen = { ...DEFAULT_PEN };
    this.saved = null;
  }

  // -------------------------------------------------------------------------
  // CSI handlers
  // -------------------------------------------------------------------------

  private applyCsi(params: string, final: string): void {
    const isPrivate = params.startsWith("?");
    if (isPrivate) {
      this.applyPrivateMode(params, final);
      return;
    }
    const nums =
      params === "" ? [] : params.split(";").map((p) => parseInt(p, 10));
    // `n1`: a count param defaulting to 1 (0 also means 1, per spec).
    const n1 = (idx: number): number => {
      const v = nums[idx];
      return v === undefined || Number.isNaN(v) || v === 0 ? 1 : v;
    };
    // `n0`: a param defaulting to 0 (ED/EL/SGR selectors).
    const n0 = (idx: number): number => {
      const v = nums[idx];
      return v === undefined || Number.isNaN(v) ? 0 : v;
    };
    const clampRow = (r: number): number =>
      Math.max(0, Math.min(this.rows - 1, r));
    const clampCol = (c: number): number =>
      Math.max(0, Math.min(this.cols - 1, c));

    switch (final) {
      case "A": // CUU
        this.row = Math.max(this.top, this.row - n1(0));
        this.wrapPending = false;
        break;
      case "B": // CUD
        this.row = Math.min(this.bottom, this.row + n1(0));
        this.wrapPending = false;
        break;
      case "C": // CUF
        this.col = clampCol(this.col + n1(0));
        this.wrapPending = false;
        break;
      case "D": // CUB
        this.col = clampCol(this.col - n1(0));
        this.wrapPending = false;
        break;
      case "E": // CNL
        this.row = Math.min(this.bottom, this.row + n1(0));
        this.col = 0;
        this.wrapPending = false;
        break;
      case "F": // CPL
        this.row = Math.max(this.top, this.row - n1(0));
        this.col = 0;
        this.wrapPending = false;
        break;
      case "G": // CHA
        this.col = clampCol(n1(0) - 1);
        this.wrapPending = false;
        break;
      case "d": // VPA
        this.row = clampRow(n1(0) - 1);
        this.wrapPending = false;
        break;
      case "H": // CUP
      case "f": // HVP
        this.row = clampRow(n1(0) - 1);
        this.col = clampCol(n1(1) - 1);
        this.wrapPending = false;
        break;
      case "J": // ED
        this.eraseDisplay(n0(0));
        break;
      case "K": // EL
        this.eraseLine(n0(0));
        break;
      case "X": // ECH
        this.eraseChars(n1(0));
        break;
      case "@": // ICH
        this.insertChars(n1(0));
        break;
      case "P": // DCH
        this.deleteChars(n1(0));
        break;
      case "L": // IL
        this.insertLines(n1(0));
        break;
      case "M": // DL
        this.deleteLines(n1(0));
        break;
      case "r": // DECSTBM
        this.setScrollRegion(n1(0), nums[1] === undefined ? this.rows : n1(1));
        break;
      case "m": // SGR
        this.applySgr(nums);
        break;
      case "s": // save cursor
        this.saved = { row: this.row, col: this.col, pen: { ...this.pen } };
        break;
      case "u": // restore cursor
        if (this.saved !== null) {
          this.row = this.saved.row;
          this.col = this.saved.col;
          this.pen = { ...this.saved.pen };
          this.wrapPending = false;
        }
        break;
      default:
        break; // device reports, modes without grid effect, etc.
    }
  }

  /** Alt-screen enter/leave (1049/1047/47) clears like a real terminal; other
   *  private modes (cursor visibility, bracketed paste, …) have no grid effect. */
  private applyPrivateMode(params: string, final: string): void {
    if (final !== "h" && final !== "l") return;
    const code = params.slice(1);
    if (code === "1049" || code === "1047" || code === "47") {
      this.cells.fill(null);
      this.row = 0;
      this.col = 0;
      this.wrapPending = false;
    }
  }

  private eraseDisplay(mode: number): void {
    const cur = this.idx(this.row, this.col);
    const last = this.cells.length;
    if (mode === 0) for (let k = cur; k < last; k++) this.cells[k] = null;
    else if (mode === 1) for (let k = 0; k <= cur; k++) this.cells[k] = null;
    else this.cells.fill(null); // 2 / 3
  }

  private eraseLine(mode: number): void {
    const base = this.idx(this.row, 0);
    if (mode === 0)
      for (let c = this.col; c < this.cols; c++) this.cells[base + c] = null;
    else if (mode === 1)
      for (let c = 0; c <= this.col; c++) this.cells[base + c] = null;
    else for (let c = 0; c < this.cols; c++) this.cells[base + c] = null;
  }

  private eraseChars(n: number): void {
    const base = this.idx(this.row, 0);
    for (let c = this.col; c < Math.min(this.cols, this.col + n); c++) {
      this.cells[base + c] = null;
    }
  }

  private insertChars(n: number): void {
    const base = this.idx(this.row, 0);
    for (let c = this.cols - 1; c >= this.col; c--) {
      this.cells[base + c] =
        c - n >= this.col ? this.cells[base + c - n] : null;
    }
  }

  private deleteChars(n: number): void {
    const base = this.idx(this.row, 0);
    for (let c = this.col; c < this.cols; c++) {
      this.cells[base + c] =
        c + n < this.cols ? this.cells[base + c + n] : null;
    }
  }

  private insertLines(n: number): void {
    if (this.row < this.top || this.row > this.bottom) return;
    for (let r = this.bottom; r >= this.row; r--) {
      const src = r - n;
      for (let c = 0; c < this.cols; c++) {
        this.cells[this.idx(r, c)] =
          src >= this.row ? this.cells[this.idx(src, c)] : null;
      }
    }
  }

  private deleteLines(n: number): void {
    if (this.row < this.top || this.row > this.bottom) return;
    for (let r = this.row; r <= this.bottom; r++) {
      const src = r + n;
      for (let c = 0; c < this.cols; c++) {
        this.cells[this.idx(r, c)] =
          src <= this.bottom ? this.cells[this.idx(src, c)] : null;
      }
    }
  }

  private setScrollRegion(topParam: number, bottomParam: number): void {
    const t = Math.max(0, Math.min(this.rows - 1, topParam - 1));
    const b = Math.max(0, Math.min(this.rows - 1, bottomParam - 1));
    if (t < b) {
      this.top = t;
      this.bottom = b;
    } else {
      this.top = 0;
      this.bottom = this.rows - 1;
    }
    this.row = this.top;
    this.col = 0;
    this.wrapPending = false;
  }

  private applySgr(nums: number[]): void {
    const params = nums.length === 0 ? [0] : nums;
    for (let i = 0; i < params.length; i++) {
      const n = params[i];
      if (Number.isNaN(n) || n === 0) {
        this.pen = { ...DEFAULT_PEN };
      } else if (n === 1) {
        this.pen.bold = true;
      } else if (n === 22) {
        this.pen.bold = false;
      } else if (n >= 30 && n <= 37) {
        this.pen.fg = PALETTE_16[n - 30];
      } else if (n >= 90 && n <= 97) {
        this.pen.fg = PALETTE_16[n - 90 + 8];
      } else if (n === 39) {
        this.pen.fg = null;
      } else if (n >= 40 && n <= 47) {
        this.pen.bg = PALETTE_16[n - 40];
      } else if (n >= 100 && n <= 107) {
        this.pen.bg = PALETTE_16[n - 100 + 8];
      } else if (n === 49) {
        this.pen.bg = null;
      } else if (n === 38 || n === 48) {
        const plane: "fg" | "bg" = n === 38 ? "fg" : "bg";
        const mode = params[i + 1];
        if (mode === 5 && i + 2 < params.length) {
          this.pen[plane] = css256(params[i + 2]);
          i += 2;
        } else if (mode === 2 && i + 4 < params.length) {
          this.pen[plane] =
            `rgb(${params[i + 2]},${params[i + 3]},${params[i + 4]})`;
          i += 4;
        }
      }
      // Other SGR (italic/underline/…) don't affect this demo's cell render.
    }
  }
}

/**
 * Pure chunks→grid projection: emulate `chunks` (in capture order) at `size` and
 * return the final screen with full per-cell attribution. This is the testable
 * face of the engine and the store's full-rebuild primitive. Same inputs → same
 * grid, every time. [LAW:dataflow-not-control-flow] one fold, no branches on
 * "live vs replay".
 */
export function emulate(
  chunks: readonly SourceChunk[],
  size: GridSize,
): AttributionGrid {
  const engine = new AttributionEngine(size);
  for (const c of chunks) engine.pushBytes(c);
  return engine.snapshot();
}
