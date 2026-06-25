// examples/web-multiplexer/web/data-sniff-engine.ts
//
// DataSniffEngine — the pure core of the Structured Data Sniffer: a live watch
// over the firehose of EVERY pane in EVERY session that pulls JSON, CSV/TSV and
// table blocks out of the raw byte stream and renders each as a uniform grid.
// It sits *between* the user and the terminal (the firehose is a read-only
// `pipe-pane` tap) and disturbs nothing — it only observes.
//
// [LAW:effects-at-boundaries] Zero IO, zero MobX, no DOM. Given a stream of raw
//   pane byte chunks (as Latin-1 text) it assembles lines (ANSI stripped) and
//   emits a bounded, chronological ring of detected blocks. The only inputs are
//   bytes; the only outputs are values. Exhaustively unit-tested in isolation.
// [LAW:types-are-the-program] A `SniffedBlock` ALWAYS carries a valid `table`.
//   "Looks like JSON but doesn't parse" is not a representable state — a block
//   exists only once detection has produced a real grid. There is no
//   detected-but-unparsed limbo mode for the UI to enumerate, so the view never
//   branches on "is this parseable yet". Detection *is* a successful parse.
// [LAW:one-source-of-truth] The ring IS the block feed. Per-pane assembler and
//   in-progress run/JSON state are derived carry-over; nothing else holds blocks.
// [LAW:dataflow-not-control-flow] Every completed line runs the same
//   classify → accumulate → finalize pipeline. "No structured data" is the
//   empty-output case, never a skipped branch.
//
// SCOPE (precision over recall, stated honestly — [LAW:no-silent-failure] we do
// not pretend to catch everything): JSON objects/arrays (single- and
// multi-line), comma/tab-delimited rows, pipe/markdown and box-drawn tables, and
// whitespace-aligned columnar output (the `ls -l` / `kubectl get` family). The
// run-consistency requirement (≥2 consecutive rows of identical column count,
// ≥3 for the noisier whitespace family) is the precision mechanism — prose
// rarely repeats an identical column shape line after line.

import { LineAssembler } from "./ansi-text.ts";

/** Which structured shape a block was recognised as. */
export type SniffFormat = "json" | "csv" | "tsv" | "table";

/**
 * A detected block rendered to a uniform grid of string cells. `columns` is the
 * header row when one was identified, or `null` for positional data (the view
 * then numbers the columns). Every cell is already string-rendered — "render as
 * a table" means flatten to a grid of text, so a nested JSON value becomes its
 * compact JSON text, not a sub-structure the table would have to recurse into.
 */
export interface TabularData {
  readonly columns: readonly string[] | null;
  readonly rows: readonly (readonly string[])[];
}

/** One detected structured block, ready to render. `id` orders the feed. */
export interface SniffedBlock {
  readonly id: number;
  readonly paneId: number;
  readonly format: SniffFormat;
  /** The source text the block was detected in (joined lines / the JSON value). */
  readonly raw: string;
  readonly table: TabularData;
}

/** Cap on accumulated multi-line-JSON text before we give up on a stray `{`. */
const MAX_JSON_CHARS = 64 * 1024;
/** Cap on lines buffered into a single delimited run. */
const MAX_RUN_LINES = 500;
/** Whitespace-aligned runs are noisier; demand more rows before trusting them. */
const MIN_WS_ROWS = 3;
/** Other delimited families trust a 2-row run (a header + one record). */
const MIN_DELIMITED_ROWS = 2;

export class DataSniffEngine {
  private readonly panes = new Map<number, PaneState>();
  private readonly ring: SniffedBlock[] = [];
  private nextId = 1;

  /** @param capacity max blocks retained in the feed (FIFO eviction). */
  constructor(private readonly capacity: number) {}

  /**
   * Feed one raw pane byte chunk (Latin-1 decoded). Returns the blocks this
   * chunk newly completed (possibly empty). A block completes only when its
   * shape is unambiguously closed: a JSON value whose brackets balance, or a
   * delimited run broken by a non-conforming line.
   */
  pushBytes(paneId: number, latin1Chunk: string): SniffedBlock[] {
    const ps = this.paneFor(paneId);
    const lines = ps.asm.push(latin1Chunk);
    const added: SniffedBlock[] = [];
    for (const line of lines) {
      this.processLine(ps, paneId, line, added);
    }
    this.evict();
    return added;
  }

  /**
   * Finalize one pane's in-progress run, emitting its block if it has met the
   * row threshold. The store calls this when a pane falls silent for a tick:
   * quiescence is the completion signal for a run that no breaking line will
   * ever arrive to close (the last table a pane prints). JSON awaiting its
   * close is untouched — silence is not a closing bracket, so an unterminated
   * value stays pending rather than emitting a half-parsed block.
   * [LAW:no-ambient-temporal-coupling] the *store's* tick owns "is this pane
   *   quiet"; the engine just finalizes the named pane on request.
   */
  flushPane(paneId: number): SniffedBlock[] {
    const ps = this.panes.get(paneId);
    if (ps === undefined) return [];
    const added: SniffedBlock[] = [];
    this.finalizeRun(ps, paneId, added);
    this.evict();
    return added;
  }

  /**
   * Finalize every pane's in-progress run. Called when the feed is torn down so
   * a complete-but-still-growing table isn't lost on the last line.
   */
  flush(): SniffedBlock[] {
    const added: SniffedBlock[] = [];
    for (const [paneId, ps] of this.panes) {
      this.finalizeRun(ps, paneId, added);
    }
    this.evict();
    return added;
  }

  /** The current bounded, chronological block feed. */
  get blocks(): readonly SniffedBlock[] {
    return this.ring;
  }

  /** Number of distinct panes that have fed the engine bytes this session. */
  get sniffedPaneCount(): number {
    return this.panes.size;
  }

  /** Drop all blocks and per-pane carry-over (e.g. on disconnect). */
  clear(): void {
    this.ring.length = 0;
    this.panes.clear();
  }

  // -------------------------------------------------------------------------

  private paneFor(paneId: number): PaneState {
    let ps = this.panes.get(paneId);
    if (ps === undefined) {
      ps = { asm: new LineAssembler(), json: null, run: null };
      this.panes.set(paneId, ps);
    }
    return ps;
  }

  /**
   * The per-line state machine. Precedence is explicit: an open multi-line JSON
   * value consumes lines until it closes; otherwise a line that opens JSON wins
   * over delimited classification (it would never be a clean row anyway); a
   * delimited row extends or starts a run; anything else breaks the run.
   */
  private processLine(
    ps: PaneState,
    paneId: number,
    line: string,
    added: SniffedBlock[],
  ): void {
    if (ps.json !== null) {
      this.continueJson(ps, paneId, line, added);
      return;
    }
    const opener = scanJsonValue(line);
    if (opener.status !== "none") {
      // A JSON line is never also a run row — close any run first so the block
      // ordering reflects the stream. [LAW:no-ambient-temporal-coupling]
      this.finalizeRun(ps, paneId, added);
      if (opener.status === "complete") {
        this.emitJson(paneId, opener.text, added);
      } else {
        ps.json = { text: line };
      }
      return;
    }

    const row = classifyRow(line);
    if (row === null) {
      this.finalizeRun(ps, paneId, added);
      return;
    }
    this.extendRun(ps, paneId, row, line, added);
  }

  private continueJson(
    ps: PaneState,
    paneId: number,
    line: string,
    added: SniffedBlock[],
  ): void {
    const open = ps.json;
    if (open === null) return;
    open.text += `\n${line}`;
    if (open.text.length > MAX_JSON_CHARS) {
      ps.json = null; // give up — a `{` that never closes is not a value
      return;
    }
    const scan = scanJsonValue(open.text);
    if (scan.status === "complete") {
      ps.json = null;
      this.emitJson(paneId, scan.text, added);
    }
  }

  private emitJson(
    paneId: number,
    text: string,
    added: SniffedBlock[],
  ): void {
    const table = jsonToTable(text);
    if (table === null) return; // parsed, but not tabular-worthy — not a block
    this.push(
      { id: this.nextId++, paneId, format: "json", raw: text, table },
      added,
    );
  }

  private extendRun(
    ps: PaneState,
    paneId: number,
    row: ClassifiedRow,
    line: string,
    added: SniffedBlock[],
  ): void {
    const run = ps.run;
    if (run !== null && runAccepts(run, row)) {
      if (row.kind === "sep") run.sawSeparator = true;
      else run.rows.push(row.cells);
      run.lines.push(line);
      if (run.lines.length > MAX_RUN_LINES) {
        this.finalizeRun(ps, paneId, added);
      }
      return;
    }
    // Row doesn't extend the current run: close it, then this row seeds a new
    // one. A lone separator line can't seed a run (it carries no cells).
    this.finalizeRun(ps, paneId, added);
    if (row.kind !== "sep") {
      ps.run = {
        kind: row.kind,
        cols: row.cells.length,
        rows: [row.cells],
        lines: [line],
        sawSeparator: false,
      };
    }
  }

  private finalizeRun(
    ps: PaneState,
    paneId: number,
    added: SniffedBlock[],
  ): void {
    const run = ps.run;
    ps.run = null;
    if (run === null) return;
    const minRows = run.kind === "ws" ? MIN_WS_ROWS : MIN_DELIMITED_ROWS;
    if (run.rows.length < minRows) return;
    const table = runToTable(run);
    this.push(
      {
        id: this.nextId++,
        paneId,
        format: runFormat(run.kind),
        raw: run.lines.join("\n"),
        table,
      },
      added,
    );
  }

  private push(block: SniffedBlock, added: SniffedBlock[]): void {
    this.ring.push(block);
    added.push(block);
  }

  private evict(): void {
    if (this.ring.length > this.capacity) {
      this.ring.splice(0, this.ring.length - this.capacity);
    }
  }
}

// ===========================================================================
// Per-pane carry-over state
// ===========================================================================

interface PaneState {
  readonly asm: LineAssembler;
  /** Accumulated text of a multi-line JSON value still awaiting its close. */
  json: { text: string } | null;
  /** A delimited/table run still gathering consecutive conforming rows. */
  run: RunAccum | null;
}

interface RunAccum {
  readonly kind: RowKind;
  /** Column count every data row in the run must share. */
  readonly cols: number;
  /** Data rows (separator lines excluded). */
  readonly rows: string[][];
  /** Every source line including separators, for `raw`. */
  readonly lines: string[];
  /** A box/markdown separator rule was seen — marks row 0 as a header. */
  sawSeparator: boolean;
}

// ===========================================================================
// JSON detection
// ===========================================================================

type JsonScan =
  | { status: "complete"; text: string }
  | { status: "open" }
  | { status: "none" };

/**
 * Scan `text` for a JSON value anchored at its first non-space character. A
 * string-aware bracket walk (so `}` inside `"…"` doesn't count) finds the span
 * where depth returns to zero. Returns `complete` with the exact value text
 * once balanced, `open` if the value runs past the end of `text` (multi-line),
 * or `none` if `text` doesn't begin with `{`/`[`.
 *
 * Anchoring at the first non-space char is the precision guard: a CSV cell or
 * prose sentence that merely contains `{}` does not begin with a bracket, so it
 * never triggers JSON detection.
 */
export function scanJsonValue(text: string): JsonScan {
  let i = 0;
  while (i < text.length && (text[i] === " " || text[i] === "\t")) i++;
  const open = text[i];
  if (open !== "{" && open !== "[") return { status: "none" };

  const start = i;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) return { status: "complete", text: text.slice(start, i + 1) };
    }
  }
  return { status: "open" };
}

/**
 * Parse a JSON value's text and shape it into a grid, or return `null` when the
 * value isn't worth a table (invalid JSON, a bare scalar, an empty/▏single-key
 * structure). The shaping rules:
 *   - array of objects → columns = ordered union of keys, one row per object
 *   - array of arrays  → positional columns, one row per inner array
 *   - array of scalars → a single "value" column
 *   - object (≥2 keys) → a key/value two-column table
 */
export function jsonToTable(text: string): TabularData | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null; // [LAW:no-silent-failure] not a phantom empty table — no block
  }
  if (Array.isArray(value)) return arrayToTable(value);
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (keys.length < 2) return null; // a 0/1-field object isn't a table
    return {
      columns: ["key", "value"],
      rows: keys.map((k) => [k, renderCell((value as JsonObject)[k])]),
    };
  }
  return null; // scalar — nothing to tabulate
}

function arrayToTable(arr: readonly unknown[]): TabularData | null {
  if (arr.length === 0) return null;
  if (arr.every(isPlainObject)) {
    const columns = unionKeys(arr as readonly JsonObject[]);
    if (columns.length === 0) return null;
    return {
      columns,
      rows: (arr as readonly JsonObject[]).map((obj) =>
        columns.map((c) => (c in obj ? renderCell(obj[c]) : "")),
      ),
    };
  }
  if (arr.every(Array.isArray)) {
    const width = Math.max(...(arr as readonly unknown[][]).map((r) => r.length));
    return {
      columns: null,
      rows: (arr as readonly unknown[][]).map((r) =>
        Array.from({ length: width }, (_, i) =>
          i < r.length ? renderCell(r[i]) : "",
        ),
      ),
    };
  }
  // Mixed or scalar array → one "value" column.
  return { columns: ["value"], rows: arr.map((v) => [renderCell(v)]) };
}

function unionKeys(objs: readonly JsonObject[]): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  for (const o of objs) {
    for (const k of Object.keys(o)) {
      if (!seen.has(k)) {
        seen.add(k);
        order.push(k);
      }
    }
  }
  return order;
}

type JsonObject = Record<string, unknown>;

function isPlainObject(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Render any JSON value as a single table cell's text. */
function renderCell(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

// ===========================================================================
// Delimited / table row detection
// ===========================================================================

type RowKind = "csv" | "tsv" | "table" | "ws" | "sep";

interface ClassifiedRow {
  readonly kind: RowKind;
  readonly cells: string[];
}

const BOX_CHARS = "─│┼┌┐└┘├┤┬┴═╪╫╔╗╚╝║╬╠╣";

/**
 * Classify one stripped line as a delimited/table row, or `null` if it isn't
 * row-shaped. A box/markdown separator rule (`├──┼──┤`, `+----+`, `|---|`)
 * classifies as `sep`: it carries no data but confirms a table and marks the
 * preceding row as a header. Delimiter precedence — explicit pipe table, then
 * tab, then comma, then 2+-space columns — picks the strongest signal first.
 */
export function classifyRow(line: string): ClassifiedRow | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;

  if (isSeparatorRule(trimmed)) return { kind: "sep", cells: [] };

  if (looksLikePipeTable(trimmed)) {
    const cells = splitPipe(trimmed);
    if (cells.length >= 2) return { kind: "table", cells };
  }
  if (line.includes("\t")) {
    const cells = line.split("\t").map((c) => c.trim());
    if (cells.length >= 2) return { kind: "tsv", cells };
  }
  if (line.includes(",")) {
    const cells = splitCsv(line).map((c) => c.trim());
    if (cells.length >= 2) return { kind: "csv", cells };
  }
  const ws = trimmed.split(/\s{2,}/);
  if (ws.length >= 2) return { kind: "ws", cells: ws };

  return null;
}

/** A run accepts a row when it's the same delimiter family + width, or a sep. */
function runAccepts(run: RunAccum, row: ClassifiedRow): boolean {
  if (row.kind === "sep") return run.kind === "table";
  return row.kind === run.kind && row.cells.length === run.cols;
}

function runFormat(kind: RowKind): SniffFormat {
  if (kind === "csv") return "csv";
  if (kind === "tsv") return "tsv";
  return "table"; // table | ws | (sep never seeds a run)
}

/**
 * Shape a finalized run into a grid. A header is identified when a box/markdown
 * separator rule followed row 0, or — for delimiter families — when row 0 is
 * all-non-numeric and a later row carries a number (the classic "labels over
 * data" shape). Otherwise the data is positional (`columns: null`).
 */
export function runToTable(run: RunAccum): TabularData {
  const hasHeader =
    run.sawSeparator ||
    (run.rows.length >= 2 && looksLikeHeader(run.rows[0], run.rows.slice(1)));
  if (hasHeader) {
    return { columns: run.rows[0], rows: run.rows.slice(1) };
  }
  return { columns: null, rows: run.rows };
}

function looksLikeHeader(first: string[], rest: string[][]): boolean {
  const headerNumeric = first.some(isNumericCell);
  if (headerNumeric) return false;
  return rest.some((r) => r.some(isNumericCell));
}

function isNumericCell(cell: string): boolean {
  const t = cell.trim();
  return t.length > 0 && Number.isFinite(Number(t));
}

/** A line made only of box-drawing / rule characters (no payload text). */
function isSeparatorRule(trimmed: string): boolean {
  let sawRule = false;
  for (const ch of trimmed) {
    if (ch === "-" || ch === "=" || ch === "+" || ch === "|" || ch === " ") {
      if (ch !== " ") sawRule = true;
      continue;
    }
    if (BOX_CHARS.includes(ch)) {
      sawRule = true;
      continue;
    }
    return false; // a payload character — not a pure rule
  }
  return sawRule;
}

function looksLikePipeTable(trimmed: string): boolean {
  return trimmed.includes("|") && (trimmed.startsWith("|") || trimmed.includes(" | "));
}

/** Split a `| a | b |` row into cells, dropping the empty edge cells. */
function splitPipe(trimmed: string): string[] {
  const parts = trimmed.split("|").map((c) => c.trim());
  if (parts.length > 0 && parts[0] === "") parts.shift();
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

/**
 * Split a CSV line into fields, honouring double-quoted fields (which may
 * contain commas and escaped `""` quotes). Minimal RFC-4180-flavoured parser —
 * enough for the sniffer to not shred a quoted address into three cells.
 */
export function splitCsv(line: string): string[] {
  const out: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') inQuotes = true;
    else if (ch === ",") {
      out.push(field);
      field = "";
    } else field += ch;
  }
  out.push(field);
  return out;
}
