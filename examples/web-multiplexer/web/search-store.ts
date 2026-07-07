// examples/web-multiplexer/web/search-store.ts
//
// SearchStore — a live, incremental full-text index over the scrollback of
// EVERY pane in EVERY session, reachable through one tmux control-mode
// connection. This is the demo's whole point: a single connection can both
// `capture-pane` any pane's history AND receive every pane's live `%output`,
// so one browser tab holds a searchable index of all terminal history at once
// — impossible with one-PTY-per-pane.
//
// Two sources feed one index:
//   - HISTORY  — `capture-pane -p -S - -E -` per pane, run once (lazily, on
//                first entry to search mode). Plain text already.
//   - LIVE     — `%output` bytes, decoded → ANSI-stripped → reassembled into
//                lines, batched on a ticker and appended incrementally.
//
// [LAW:one-source-of-truth] `lines` (keyed by monotonic id) + the per-pane
//   `paneRing` order ARE the corpus. `index` (TrigramIndex) is DERIVED and
//   kept in lock-step on every append/evict. `results` reads only the corpus
//   and the index; nothing else holds scrollback text.
//
// [LAW:dataflow-not-control-flow] The live path is unconditional: every
//   `%output` chunk is accumulated, every tick drains the accumulator through
//   the same assemble→append→index pipeline. There is no "indexing on/off"
//   branch — backfill is a one-shot enrichment layered on top, not a mode.
//
// [LAW:effects-at-boundaries] All IO (bridge.execute, bridge.onEvent, the
//   ticker) lives in this store; the line store, ANSI stripping, and trigram
//   index it drives are pure and tested in isolation.

import { makeAutoObservable, runInAction } from "mobx";
import { bytesToLatin1 } from "@promptctl/tmux-control-mode-js/protocol";
import type { TmuxBridge } from "./bridge.ts";
import { LineAssembler } from "./ansi-text.ts";
import { TrigramIndex } from "./trigram-index.ts";

/** Drain the live `%output` accumulator into the index at this cadence. */
const TICK_INTERVAL_MS = 200;
/** Max scrollback lines retained per pane (FIFO). Bounds memory. */
const PANE_LINE_CAP = 5000;
/** Max hits returned to the UI for one query. */
const MAX_RESULTS = 500;

/** One indexed scrollback line. `id` is the corpus-wide TrigramIndex docId. */
interface IndexedLine {
  readonly id: number;
  readonly paneId: number;
  readonly text: string;
}

/** A verified search hit, with the matched span for highlighting. */
export interface SearchHit {
  readonly lineId: number;
  readonly paneId: number;
  readonly text: string;
  readonly matchStart: number;
  readonly matchLen: number;
}

export class SearchStore {
  query: string = "";
  caseSensitive: boolean = false;
  backfilled: boolean = false;
  backfilling: boolean = false;
  /**
   * [LAW:one-source-of-truth] A change-signal, not a second source of truth.
   * The trigram index is a plain (non-observable) structure; bumping `version`
   * once per tick / backfill is how its mutations re-trigger the `results`
   * computed without making every posting set observable.
   */
  version: number = 0;
  totalLines: number = 0;

  private readonly index = new TrigramIndex();
  private readonly lines = new Map<number, IndexedLine>();
  private readonly paneRing = new Map<number, number[]>();
  private readonly assemblers = new Map<number, LineAssembler>();
  private readonly accum = new Map<number, string[]>();
  private nextId = 1;

  private timerHandle: number | null = null;
  private readonly disposeOnEvent: () => void;
  private readonly disposeOnState: () => void;

  constructor(private readonly bridge: TmuxBridge) {
    makeAutoObservable<
      this,
      | "index"
      | "lines"
      | "paneRing"
      | "assemblers"
      | "accum"
      | "bridge"
      | "nextId"
      | "timerHandle"
    >(this, {
      index: false,
      lines: false,
      paneRing: false,
      assemblers: false,
      accum: false,
      bridge: false,
      nextId: false,
      timerHandle: false,
    });

    this.disposeOnEvent = bridge.onEvent((ev) => {
      if (ev.type === "output" || ev.type === "extended-output") {
        let chunks = this.accum.get(ev.paneId);
        if (chunks === undefined) {
          chunks = [];
          this.accum.set(ev.paneId, chunks);
        }
        chunks.push(bytesToLatin1(ev.data));
      }
    });

    // A reconnect can mean history changed underneath us; re-run backfill if
    // search mode has already been activated this session.
    this.disposeOnState = bridge.onState((state) => {
      if (state === "ready" && this.backfilled) {
        this.backfilled = false;
        void this.ensureBackfilled();
      }
    });

    this.timerHandle = setInterval(
      () => this.tick(),
      TICK_INTERVAL_MS,
    ) as unknown as number;
  }

  dispose(): void {
    this.disposeOnEvent();
    this.disposeOnState();
    if (this.timerHandle !== null) {
      clearInterval(
        this.timerHandle as unknown as ReturnType<typeof setInterval>,
      );
      this.timerHandle = null;
    }
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  setQuery(q: string): void {
    this.query = q;
  }

  toggleCaseSensitive(): void {
    this.caseSensitive = !this.caseSensitive;
  }

  /**
   * Seed the index with each pane's full scrollback. Runs at most once per
   * connection (a reconnect resets the latch). Idempotent re-entry while a
   * backfill is in flight is a no-op.
   */
  async ensureBackfilled(): Promise<void> {
    if (this.backfilled || this.backfilling) return;
    runInAction(() => {
      this.backfilling = true;
    });
    try {
      const listed = await this.bridge.execute("list-panes -a -F '#{pane_id}'");
      // [LAW:no-silent-failure] A failed enumeration is surfaced, not treated
      // as "zero panes". Leave the latch open so a later activation retries.
      if (!listed.success) {
        console.warn("[search] list-panes failed; scrollback not indexed");
        return;
      }
      const paneIds = listed.output.flatMap((line) => {
        const m = /^%(\d+)/.exec(line.trim());
        return m !== null ? [Number(m[1])] : [];
      });

      const captures = await Promise.all(
        paneIds.map((paneId) =>
          this.bridge
            .execute(`capture-pane -p -S - -E - -t %${paneId}`)
            .then((resp) => ({ paneId, resp })),
        ),
      );

      runInAction(() => {
        for (const { paneId, resp } of captures) {
          // A pane that closed between list and capture fails its capture —
          // expected churn, skip it. Genuine errors still surface above.
          if (!resp.success) continue;
          for (const text of resp.output) this.appendLine(paneId, text);
        }
        this.backfilled = true;
        this.version++;
      });
    } catch (err) {
      // [LAW:no-silent-failure] A transport rejection (e.g. bridge closed
      // mid-backfill) is logged, not left as an unhandled rejection on this
      // fire-and-forget caller. Leave the latch open so a later activation
      // retries, same as the list-panes-failed branch above.
      console.warn("[search] backfill failed", err);
    } finally {
      runInAction(() => {
        this.backfilling = false;
      });
    }
  }

  // -------------------------------------------------------------------------
  // Live ingestion
  // -------------------------------------------------------------------------

  private tick(): void {
    if (this.accum.size === 0) return;
    runInAction(() => {
      let appended = 0;
      for (const [paneId, chunks] of this.accum) {
        let assembler = this.assemblers.get(paneId);
        if (assembler === undefined) {
          assembler = new LineAssembler();
          this.assemblers.set(paneId, assembler);
        }
        for (const line of assembler.push(chunks.join(""))) {
          this.appendLine(paneId, line);
          appended++;
        }
      }
      this.accum.clear();
      if (appended > 0) this.version++;
    });
  }

  /**
   * Append one line to the corpus and index it, evicting the pane's oldest
   * line if the per-pane cap is exceeded. Empty lines carry no searchable
   * content and are dropped to keep the index lean.
   */
  private appendLine(paneId: number, text: string): void {
    if (text.length === 0) return;

    const id = this.nextId++;
    this.lines.set(id, { id, paneId, text });
    this.index.addDoc(id, text);

    let ring = this.paneRing.get(paneId);
    if (ring === undefined) {
      ring = [];
      this.paneRing.set(paneId, ring);
    }
    ring.push(id);
    this.totalLines++;

    if (ring.length > PANE_LINE_CAP) {
      const evicted = ring.shift();
      if (evicted !== undefined) {
        const old = this.lines.get(evicted);
        if (old !== undefined) {
          this.index.removeDoc(evicted, old.text);
          this.lines.delete(evicted);
          this.totalLines--;
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Derived
  // -------------------------------------------------------------------------

  /** Number of panes that currently contribute lines to the index. */
  get indexedPaneCount(): number {
    // Touch `version` so MobX recomputes when the (non-observable) paneRing
    // gains or loses a pane. [LAW:dataflow-not-control-flow]
    void this.version;
    return this.paneRing.size;
  }

  /**
   * Verified hits for the current query, capped for the UI. The trigram index
   * narrows to candidates; this step verifies each with an exact (case-aware)
   * `indexOf`, so false positives from the index never reach the UI.
   */
  get results(): SearchHit[] {
    // Touch `version` so MobX recomputes when the (non-observable) index
    // changes. [LAW:dataflow-not-control-flow]
    void this.version;
    const needle = this.query.trim();
    if (needle.length === 0) return [];

    const candidates = this.index.candidates(needle);
    const ids = candidates === null ? this.lines.keys() : candidates.values();

    const ndl = this.caseSensitive ? needle : needle.toLowerCase();
    const hits: SearchHit[] = [];
    for (const id of ids) {
      const line = this.lines.get(id);
      if (line === undefined) continue;
      const hay = this.caseSensitive ? line.text : line.text.toLowerCase();
      const at = hay.indexOf(ndl);
      if (at === -1) continue;
      hits.push({
        lineId: id,
        paneId: line.paneId,
        text: line.text,
        matchStart: at,
        matchLen: needle.length,
      });
      if (hits.length >= MAX_RESULTS) break;
    }
    // Chronological within the cap (ids are assigned in arrival order).
    hits.sort((a, b) => a.lineId - b.lineId);
    return hits;
  }
}
