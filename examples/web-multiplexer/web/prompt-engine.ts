// examples/web-multiplexer/web/prompt-engine.ts
//
// PromptEngine — the pure core of the OSC 133 prompt detector + command palette:
// a streaming parser that watches the raw byte stream of EVERY pane for shell-
// integration marks (`OSC 133`) and chunks the firehose into discrete *commands*
// — each with its command line, its output, and its exit code. This is the
// "parsing depth" showcase turned into structured history: a shell emits these
// marks so a terminal can fold/jump-between commands, then the marks scroll off
// screen and are forgotten; the bridge firehose hands us the raw pty bytes of
// every pane with the marks intact, so the command history of EVERY pane is
// reconstructable — and any past command is re-runnable. Trivial with the parser,
// impossible without it.
//
// [LAW:effects-at-boundaries] Zero IO, zero MobX, no DOM. Bytes in, a list of
//   CommandRecord out — a pure function of the byte stream, exhaustively unit-
//   tested. The firehose subscription, the palette rendering and the re-run write
//   (`sendKeys`) all live at the boundary (PromptStore / CommandPaletteView).
// [LAW:no-ambient-temporal-coupling] An OSC 133 sequence may be split across
//   arbitrary firehose chunk boundaries — even between the ESC and the `\` of a
//   String Terminator. The per-pane OscPromptScanner carries all framing state
//   across pushBytes calls; correctness never depends on a mark arriving whole.
//   AND, unlike the OSC 8 sidebar: a command is completed by its `D` mark or
//   superseded by the next prompt (`A`) — both explicit events, never timing. A
//   silent pane may simply be running a long command (`vim`, `sleep 60`), so
//   quiescence must NOT finalize it. There is therefore no quiescence flush here.
// [LAW:types-are-the-program] Unlike OSC 8 (where the URI is atomic at the
//   opener), an OSC 133 mark is a POINT event; a command's identity is the SPAN
//   between two marks. So the framer (OscPromptScanner) is split cleanly from the
//   interpreter (the per-pane state machine): the scanner only frames OSC strings
//   and emits text runs + marks; the command lifecycle is a machine ON TOP of it.
//   A CommandRecord is born only once B→C closes with a NON-EMPTY command line —
//   "a command with no text" (Enter at an empty prompt) is not a re-runnable
//   command and is unrepresentable. Its outcome is a discriminated `status`:
//   `running` until D, then `finished` with the exit code D carried.
// [LAW:dataflow-not-control-flow] Every chunk runs the same scan → route → record
//   pipeline. A pane that emits no marks is the empty-history case (the ground
//   state consumes and discards its bytes), not a skipped branch.
// [LAW:one-source-of-truth] The builder ring IS the command history. Per-pane
//   carry-over (the current phase + the in-flight command line) is derived
//   framing state that holds no records; nothing else holds commands.
//
// SCOPE (precision over recall, stated honestly — [LAW:no-silent-failure] we do
// not guess): we extract commands ONLY from explicit `OSC 133` shell-integration
// marks. We deliberately do NOT heuristically sniff prompts out of plain text
// (the `$ ` / `% ` / `> ` regex swamp, which misguesses on every cat of a config
// file). A command appears here only when the shell declared its boundaries via
// `OSC 133 ; B` (command start) and `OSC 133 ; C` (output start). Shells without
// integration contribute zero commands — honestly reported as panes-tapped vs
// commands-found, never faked.

/**
 * One OSC 133 shell-integration mark. The four FinalTerm/iTerm2 point events:
 * `A` prompt-start, `B` command-start, `C` output-start (command executed),
 * `D` command-finished (carries the exit code). The de-facto standard adopted by
 * iTerm2, VTE, WezTerm, Kitty and Windows Terminal.
 */
export type PromptMark = "A" | "B" | "C" | "D";

/** A command's outcome. `running`: C seen, D not yet. `finished`: D seen. */
export type CommandStatus =
  | { readonly kind: "running" }
  | { readonly kind: "finished"; readonly exitCode: number | null };

/**
 * One command in the global palette: a command line the shell executed in some
 * pane, with its (bounded) output and outcome. `command` is non-empty by
 * construction (an empty prompt-Enter births no record). The `id` is a stable
 * identity for the palette + the re-run action; `seq` is chronological by start.
 */
export interface CommandRecord {
  readonly id: number;
  readonly paneId: number;
  /** The B→C command line, ANSI-stripped + whitespace-collapsed. Non-empty. */
  readonly command: string;
  /** Outcome: running until the D mark, then finished with its exit code. */
  readonly status: CommandStatus;
  /** Bounded preview of the C→D output (UTF-8, ANSI-stripped). May be "". */
  readonly output: string;
  /** Monotonic start stamp; the palette sorts by this. */
  readonly seq: number;
}

// Control bytes.
const ESC = 0x1b;
const BEL = 0x07;
const BACKSLASH = 0x5c; // ST is ESC \
const OSC_INTRO = 0x5d; // ESC ]
const CSI_INTRO = 0x5b; // ESC [
const DCS_INTRO = 0x50; // ESC P
const APC_INTRO = 0x5f; // ESC _
const PM_INTRO = 0x5e; // ESC ^
const SOS_INTRO = 0x58; // ESC X

/**
 * Cap on an in-progress OSC string body. A terminator that never arrives must
 * not grow unbounded; on overflow we abandon the sequence and resync. An OSC 133
 * mark body is a handful of bytes anyway.
 */
const MAX_OSC_BYTES = 64 * 1024;

/** Cap on an accumulated command line. A runaway just stops growing. */
const MAX_COMMAND_BYTES = 4 * 1024;

/** Cap on captured output PREVIEW per command. This is a preview, not a log. */
const MAX_OUTPUT_BYTES = 4 * 1024;

/** Max distinct commands retained in the history ring (oldest evicted). */
const DEFAULT_CAPACITY = 1000;

type Mode = "ground" | "esc" | "osc" | "csi" | "skipString";

/** Sink for the framing scanner: printable ground text + OSC 133 marks. */
interface PromptScanSink {
  /** One printable ground-mode byte (CSI/OSC styling already stripped). */
  onText(byte: number): void;
  /** A framed OSC 133 mark; `exitCode` is set only for `D` (else null). */
  onMark(mark: PromptMark, exitCode: number | null): void;
}

/**
 * Framing parser for ONE pane, resumable across chunk boundaries. It walks the
 * VT500 escape grammar only as deep as needed to (a) frame OSC strings (to find
 * `OSC 133` marks) and (b) skip CSI styling so the captured command/output text
 * stays clean. Everything else (other ESC forms, DCS/APC/PM/SOS strings) is
 * skipped wholesale. It knows NOTHING of the command lifecycle — it only frames
 * and forwards. The prompt/command/output state machine lives in PromptEngine.
 * [LAW:decomposition] one part frames; another interprets.
 *
 * Lifted from the OSC 8 sidebar's OscLinkScanner and generalized: it no longer
 * tracks an "open link", it forwards every ground byte (the engine routes them
 * by phase) and classifies OSC 133 instead of OSC 8.
 */
class OscPromptScanner {
  private mode: Mode = "ground";
  private osc: number[] = [];
  /** In an OSC string, an ESC was seen and we're checking for the `\` of ST. */
  private sawEsc = false;

  /** Feed raw bytes; drive `sink` for ground text and OSC 133 marks. */
  push(data: Uint8Array, sink: PromptScanSink): void {
    for (const b of data) {
      switch (this.mode) {
        case "ground":
          if (b === ESC) this.mode = "esc";
          else sink.onText(b);
          break;
        case "esc":
          this.afterEsc(b);
          break;
        case "csi":
          // Consume CSI params/intermediates; a final byte (0x40–0x7e) ends it.
          if (b >= 0x40 && b <= 0x7e) this.mode = "ground";
          break;
        case "skipString":
          this.skipStringByte(b);
          break;
        case "osc":
          this.consumeOscByte(b, sink);
          break;
      }
    }
  }

  // -------------------------------------------------------------------------

  private afterEsc(b: number): void {
    if (b === OSC_INTRO) {
      this.mode = "osc";
      this.osc = [];
      this.sawEsc = false;
      return;
    }
    if (b === CSI_INTRO) {
      this.mode = "csi";
      return;
    }
    if (
      b === DCS_INTRO ||
      b === APC_INTRO ||
      b === PM_INTRO ||
      b === SOS_INTRO
    ) {
      this.mode = "skipString";
      this.sawEsc = false;
      return;
    }
    if (b === ESC) return; // ESC ESC: restart the introducer
    // Any other escape (charset designation, RIS, …): a short form. Return to
    // ground; the single final byte was `b` and is now consumed.
    this.mode = "ground";
  }

  /** Skip a DCS/APC/PM/SOS string body up to its ST/BEL terminator. */
  private skipStringByte(b: number): void {
    if (this.sawEsc) {
      this.sawEsc = false;
      this.mode = b === ESC ? "esc" : "ground"; // ESC \ ends it; stray ESC resyncs
      return;
    }
    if (b === ESC) this.sawEsc = true;
    else if (b === BEL) this.mode = "ground";
  }

  /** Accumulate one OSC string byte; on terminator, classify the sequence. */
  private consumeOscByte(b: number, sink: PromptScanSink): void {
    if (this.sawEsc) {
      this.sawEsc = false;
      if (b === BACKSLASH) {
        this.finishOsc(sink); // ESC \ = ST → string complete
      } else {
        this.abandonOsc();
        if (b === ESC) this.mode = "esc"; // stray ESC: resync into a new escape
        // else: the byte is ordinary; it was consumed (rare malformed case).
      }
      return;
    }
    if (b === ESC) {
      this.sawEsc = true; // could be the start of ST
      return;
    }
    if (b === BEL) {
      this.finishOsc(sink); // OSC also terminates on BEL
      return;
    }
    this.osc.push(b);
    if (this.osc.length > MAX_OSC_BYTES) this.abandonOsc();
  }

  private abandonOsc(): void {
    this.mode = "ground";
    this.osc = [];
  }

  /**
   * A complete OSC body is in `this.osc`. If it is `OSC 133`, emit the mark; any
   * other OSC (title, hyperlink, clipboard, image, …) is ignored.
   */
  private finishOsc(sink: PromptScanSink): void {
    const body = this.osc;
    this.mode = "ground";
    this.osc = [];

    const mark = parseOsc133(body);
    if (mark !== null) sink.onMark(mark.mark, mark.exitCode);
  }
}

/** A parsed OSC 133 mark: the letter, plus the exit code for `D`. */
export interface Osc133Mark {
  readonly mark: PromptMark;
  /** The exit code carried by `D` (or null when absent/non-numeric). */
  readonly exitCode: number | null;
}

/**
 * Parse an OSC body as an `OSC 133` shell-integration mark, or return null. The
 * body is `;`-separated: field 0 is the `Ps` (`133`), field 1 is the mark letter
 * (`A`/`B`/`C`/`D`), and for `D` field 2 (when a non-negative integer) is the
 * exit code. Aux params some shells append (`A;aid=…`, `D;1;…`) are tolerated:
 * only the leading fields are read.
 *
 * Exported for unit testing the framing in isolation. [LAW:behavior-not-structure]
 */
export function parseOsc133(body: ArrayLike<number>): Osc133Mark | null {
  const parts = bytesToLatin1(body).split(";");
  if (parts[0] !== "133") return null;
  const letter = parts[1];
  if (letter !== "A" && letter !== "B" && letter !== "C" && letter !== "D") {
    return null;
  }
  if (letter === "D") {
    const raw = parts[2];
    const code = raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : null;
    return { mark: "D", exitCode: code };
  }
  return { mark: letter, exitCode: null };
}

/** A command being assembled. Mutated in place while it streams; snapshot at read. */
interface CommandBuilder {
  readonly id: number;
  readonly paneId: number;
  /** Frozen at C, when the B→C span closes. Non-empty (empty → no builder). */
  readonly command: string;
  readonly seq: number;
  /** Output-preview bytes accumulated during the C→D span; bounded. */
  readonly output: number[];
  done: boolean;
  exitCode: number | null;
}

type Phase = "idle" | "prompt" | "command" | "output";

/** Per-pane framing + lifecycle state. The scanner frames; the rest interprets. */
class PaneTracker {
  readonly scanner = new OscPromptScanner();
  phase: Phase = "idle";
  /** Bytes of the command line accumulated during the B→C span. */
  commandBytes: number[] = [];
  /** The builder this pane is currently streaming output into (or null). */
  running: CommandBuilder | null = null;
}

export class PromptEngine {
  private readonly trackers = new Map<number, PaneTracker>();
  /** Chronological history (oldest first). Mutable builders, immutable at read. */
  private readonly builders: CommandBuilder[] = [];
  private nextId = 1;
  private nextSeq = 1;

  /** @param capacity max commands retained (oldest evicted past it). */
  constructor(private readonly capacity: number = DEFAULT_CAPACITY) {}

  /**
   * Feed one raw pane byte chunk. Frames any OSC 133 marks it completes and folds
   * the command lifecycle accordingly. A single mark may span many chunks; the
   * per-pane scanner carries framing state until the terminator arrives.
   */
  pushBytes(paneId: number, data: Uint8Array): void {
    const tracker = this.trackerFor(paneId);
    tracker.scanner.push(data, {
      onText: (b) => this.onText(tracker, b),
      onMark: (mark, exit) => this.onMark(paneId, tracker, mark, exit),
    });
    this.evict();
  }

  /** The command history, oldest-started first (the view reverses for recency). */
  get commands(): readonly CommandRecord[] {
    return this.builders.map(snapshot);
  }

  /** Number of commands currently in the history. */
  get commandCount(): number {
    return this.builders.length;
  }

  /** Number of distinct panes that have fed the engine bytes this session. */
  get tappedPaneCount(): number {
    return this.trackers.size;
  }

  /** Drop all history and per-pane carry-over (e.g. on disconnect). */
  clear(): void {
    this.builders.length = 0;
    this.trackers.clear();
  }

  // -------------------------------------------------------------------------

  private trackerFor(paneId: number): PaneTracker {
    let tracker = this.trackers.get(paneId);
    if (tracker === undefined) {
      tracker = new PaneTracker();
      this.trackers.set(paneId, tracker);
    }
    return tracker;
  }

  /** Route one ground-text byte by the pane's phase. [LAW:dataflow-not-control-flow] */
  private onText(tracker: PaneTracker, b: number): void {
    if (tracker.phase === "command") {
      appendClean(tracker.commandBytes, b, MAX_COMMAND_BYTES);
    } else if (tracker.phase === "output" && tracker.running !== null) {
      appendOutput(tracker.running.output, b);
    }
    // prompt/idle text (the prompt string itself, or pre-prompt noise) is dropped.
  }

  /**
   * Advance the per-pane command lifecycle on a mark. The marks own every phase
   * transition; [LAW:no-ambient-temporal-coupling] completion is `D` or the next
   * prompt (`A`), never a timer.
   */
  private onMark(
    paneId: number,
    tracker: PaneTracker,
    mark: PromptMark,
    exitCode: number | null,
  ): void {
    switch (mark) {
      case "A":
        // A new prompt: the previous command (if any) is done even if its D was
        // dropped. Finalize it with an unknown exit code, then start the prompt.
        this.finalize(tracker, null);
        tracker.phase = "prompt";
        tracker.commandBytes = [];
        break;
      case "B":
        tracker.phase = "command";
        tracker.commandBytes = [];
        break;
      case "C": {
        // The command line is complete. Born here, non-empty by construction.
        const command = decodeText(tracker.commandBytes);
        tracker.commandBytes = [];
        tracker.phase = "output";
        tracker.running = command === "" ? null : this.birth(paneId, command);
        break;
      }
      case "D":
        this.finalize(tracker, exitCode);
        tracker.phase = "idle";
        break;
    }
  }

  /** Create a running command, append it to the history ring. */
  private birth(paneId: number, command: string): CommandBuilder {
    const builder: CommandBuilder = {
      id: this.nextId++,
      paneId,
      command,
      seq: this.nextSeq++,
      output: [],
      done: false,
      exitCode: null,
    };
    this.builders.push(builder);
    return builder;
  }

  /** Mark the pane's running command finished (idempotent). */
  private finalize(tracker: PaneTracker, exitCode: number | null): void {
    const running = tracker.running;
    if (running === null) return;
    running.done = true;
    running.exitCode = exitCode;
    tracker.running = null;
  }

  /** Evict the oldest commands when over capacity. */
  private evict(): void {
    const over = this.builders.length - this.capacity;
    if (over > 0) this.builders.splice(0, over);
  }
}

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

/** Immutable snapshot of a builder for the public API. */
function snapshot(b: CommandBuilder): CommandRecord {
  return {
    id: b.id,
    paneId: b.paneId,
    command: b.command,
    seq: b.seq,
    status: b.done
      ? { kind: "finished", exitCode: b.exitCode }
      : { kind: "running" },
    output: decodeText(b.output),
  };
}

/**
 * Append one printable byte to `buf`, collapsing C0 whitespace (LF/CR/TAB) to a
 * single space and dropping other control bytes, bounded by `max`. Keeps a
 * command line clean and single-line. (The same shaping the OSC 8 label used.)
 */
function appendClean(buf: number[], b: number, max: number): void {
  if (buf.length >= max) return;
  if (b === 0x0a || b === 0x0d || b === 0x09) {
    if (buf[buf.length - 1] !== 0x20) buf.push(0x20);
    return;
  }
  if (b < 0x20 || b === 0x7f) return;
  buf.push(b);
}

/**
 * Append one output byte, preserving newlines/tabs (so the multi-line preview
 * reads as the program printed it) but dropping other control bytes, bounded.
 */
function appendOutput(buf: number[], b: number): void {
  if (buf.length >= MAX_OUTPUT_BYTES) return;
  if (b === 0x0a || b === 0x09) {
    buf.push(b);
    return;
  }
  if (b < 0x20 || b === 0x7f) return;
  buf.push(b);
}

/** UTF-8 decode the accumulated bytes, trimmed. */
function decodeText(bytes: readonly number[]): string {
  return new TextDecoder("utf-8").decode(Uint8Array.from(bytes)).trim();
}

/** Latin-1 decode: bytes 0–255 map 1:1 to char codes; lossless for ASCII bodies. */
function bytesToLatin1(bytes: ArrayLike<number>): string {
  let out = "";
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const end = Math.min(i + CHUNK, bytes.length);
    out += String.fromCharCode(...Array.prototype.slice.call(bytes, i, end));
  }
  return out;
}
