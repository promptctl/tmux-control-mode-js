// examples/web-multiplexer/web/regex-match-engine.ts
//
// RegexMatchEngine — the pure core of the cross-terminal regex matcher: a live
// "tail -f | grep" applied per completed line across the firehose of every
// pane. Given a compiled RegExp and a stream of raw pane byte chunks (as
// Latin-1 text), it emits a bounded, chronological ring of matched lines.
//
// [LAW:effects-at-boundaries] Zero IO, zero MobX, no DOM. The one operation
//   that can fail — compiling a user pattern into a RegExp — lives in the store
//   (RegexMatcherStore); this engine only ever receives an already-compiled
//   RegExp, so it is a pure function of (pattern, bytes) and is exhaustively
//   unit-tested in isolation.
// [LAW:one-source-of-truth] The ring IS the match feed. Per-pane LineAssemblers
//   are derived carry-over state; nothing else holds matched text.
// [LAW:dataflow-not-control-flow] Every chunk runs the same assemble → match →
//   append pipeline. "No pattern set" and "no matches in this chunk" are the
//   empty-output cases, not branches that skip the pipeline.

import { LineAssembler } from "./ansi-text.ts";

/** One matched line, with the span to highlight. `id` orders the feed. */
export interface RegexMatch {
  readonly id: number;
  readonly paneId: number;
  readonly text: string;
  readonly matchStart: number;
  readonly matchLen: number;
}

/**
 * Cap on the length of a single line fed to the regex. Per-line application
 * already bounds catastrophic-backtracking blast radius to one line; truncating
 * pathologically long lines (a pane spewing megabytes with no newline) bounds
 * it further and keeps the feed's memory predictable.
 */
const MAX_LINE_LEN = 8192;

export class RegexMatchEngine {
  private re: RegExp | null = null;
  private readonly assemblers = new Map<number, LineAssembler>();
  private readonly ring: RegexMatch[] = [];
  private nextId = 1;

  /** @param capacity max matches retained in the feed (FIFO eviction). */
  constructor(private readonly capacity: number) {}

  /**
   * Set the active pattern (or clear it with `null`). Changing the pattern
   * resets the feed: like `grep` on a live tail, matching begins from the next
   * line, not retroactively over lines already gone by. Per-pane line carry-
   * over is preserved so a pattern change mid-line doesn't corrupt assembly.
   */
  setPattern(re: RegExp | null): void {
    this.re = re;
    this.ring.length = 0;
  }

  /**
   * Feed one raw pane byte chunk (Latin-1 decoded). Returns the matches this
   * chunk newly produced (possibly empty). Lines are completed by `\n`; a
   * trailing partial line is carried until more bytes arrive.
   */
  pushBytes(paneId: number, latin1Chunk: string): RegexMatch[] {
    let asm = this.assemblers.get(paneId);
    if (asm === undefined) {
      asm = new LineAssembler();
      this.assemblers.set(paneId, asm);
    }
    const lines = asm.push(latin1Chunk);
    const re = this.re;
    if (re === null) return [];

    const added: RegexMatch[] = [];
    for (const raw of lines) {
      const line = raw.length > MAX_LINE_LEN ? raw.slice(0, MAX_LINE_LEN) : raw;
      const span = matchSpan(re, line);
      if (span === null) continue;
      const rec: RegexMatch = {
        id: this.nextId++,
        paneId,
        text: line,
        matchStart: span.start,
        matchLen: span.len,
      };
      this.ring.push(rec);
      added.push(rec);
    }
    if (this.ring.length > this.capacity) {
      this.ring.splice(0, this.ring.length - this.capacity);
    }
    return added;
  }

  /** The current bounded, chronological match feed. */
  get matches(): readonly RegexMatch[] {
    return this.ring;
  }

  /** Number of distinct panes that have fed the engine bytes this session. */
  get tappedPaneCount(): number {
    return this.assemblers.size;
  }

  /** Drop all matches and per-pane carry-over (e.g. on disconnect). */
  clear(): void {
    this.ring.length = 0;
    this.assemblers.clear();
  }
}

/**
 * First match span of `re` in `line`, or null. The RegExp's `lastIndex` is
 * reset so a stray `g`/`y` flag can't make matching stateful across lines.
 */
function matchSpan(
  re: RegExp,
  line: string,
): { start: number; len: number } | null {
  re.lastIndex = 0;
  const m = re.exec(line);
  if (m === null) return null;
  return { start: m.index, len: m[0].length };
}
