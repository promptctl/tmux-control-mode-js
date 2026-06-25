// examples/web-multiplexer/web/regex-matcher-store.ts
//
// RegexMatcherStore — the IO boundary for the cross-terminal regex matcher: a
// live "tail -f | grep" over the firehose of EVERY pane in EVERY session. It
// owns three effects and nothing else: (1) compiling the user's pattern into a
// RegExp and surfacing a bad one inline, (2) the firehose start/stop lifecycle,
// (3) draining accumulated bytes into the pure RegexMatchEngine on a ticker.
//
// [LAW:effects-at-boundaries] All IO (bridge.startFirehose / onFirehose /
//   onState, the ticker, RegExp compilation) lives here. The match logic it
//   drives — RegexMatchEngine — is pure and unit-tested in isolation.
// [LAW:one-source-of-truth] The engine's ring IS the match feed. `version` is a
//   change-signal (the engine isn't observable), not a second copy of it.
// [LAW:dataflow-not-control-flow] Every firehose chunk is accumulated; every
//   tick drains the accumulator through the same engine.pushBytes pipeline.
//   "No pattern" / "no matches" are empty-output cases, not skipped branches.

import { makeAutoObservable, runInAction } from "mobx";
import { bytesToLatin1 } from "@promptctl/tmux-control-mode-js/protocol";
import type { TmuxBridge } from "./bridge.ts";
import { RegexMatchEngine, type RegexMatch } from "./regex-match-engine.ts";

/** Drain the firehose byte accumulator into the engine at this cadence. */
const TICK_INTERVAL_MS = 150;
/** Max matches retained in the live feed (FIFO). Bounds memory. */
const MATCH_CAP = 2000;
/**
 * Reject absurdly long patterns up front — a cheap guard against a pasted
 * pathological pattern before it ever reaches the per-line matcher. Per-line
 * application over length-bounded lines (in the engine) caps the rest.
 */
const MAX_PATTERN_LEN = 1000;

export type { RegexMatch } from "./regex-match-engine.ts";

export class RegexMatcherStore {
  pattern: string = "";
  caseInsensitive: boolean = true;
  /**
   * [LAW:no-silent-failure] An invalid regex is surfaced here, inline, never
   * swallowed into "no matches". While set, the engine has no pattern, so the
   * feed is honestly empty rather than matching against a stale pattern.
   */
  compileError: string | null = null;
  /** True while the firehose taps are open (regex mode is active). */
  active: boolean = false;
  /**
   * [LAW:one-source-of-truth] Change-signal for the non-observable engine.
   * Bumped once per drain tick / compile so the `matches` computed recomputes
   * without making the engine's internals observable.
   */
  version: number = 0;

  private readonly engine = new RegexMatchEngine(MATCH_CAP);
  private readonly accum = new Map<number, string[]>();
  private timerHandle: number | null = null;
  private readonly disposeOnFirehose: () => void;
  private readonly disposeOnState: () => void;

  constructor(private readonly bridge: TmuxBridge) {
    makeAutoObservable<this, "engine" | "accum" | "bridge" | "timerHandle">(
      this,
      {
        engine: false,
        accum: false,
        bridge: false,
        timerHandle: false,
      },
    );

    this.disposeOnFirehose = bridge.onFirehose((paneId, data) => {
      let chunks = this.accum.get(paneId);
      if (chunks === undefined) {
        chunks = [];
        this.accum.set(paneId, chunks);
      }
      chunks.push(bytesToLatin1(data));
    });

    // A reconnect drops the previous server's taps; re-open the firehose if
    // regex mode is still active so the feed survives a socket swap / reconnect.
    this.disposeOnState = bridge.onState((state) => {
      if (state === "ready" && this.active) this.bridge.startFirehose();
    });

    this.compile();
    this.timerHandle = setInterval(
      () => this.tick(),
      TICK_INTERVAL_MS,
    ) as unknown as number;
  }

  dispose(): void {
    this.disposeOnFirehose();
    this.disposeOnState();
    if (this.timerHandle !== null) {
      clearInterval(
        this.timerHandle as unknown as ReturnType<typeof setInterval>,
      );
      this.timerHandle = null;
    }
    if (this.active) this.bridge.stopFirehose();
  }

  // -------------------------------------------------------------------------
  // Lifecycle (firehose taps)
  // -------------------------------------------------------------------------

  /** Open the firehose taps. Idempotent. Called on entering regex mode. */
  start(): void {
    if (this.active) return;
    this.active = true;
    this.bridge.startFirehose();
  }

  /**
   * Close the firehose taps and free the feed. Called on leaving regex mode —
   * idle panes shouldn't keep paying the pipe-pane cost. The pattern + UI state
   * persist; matches repopulate live on the next `start`.
   */
  stop(): void {
    if (!this.active) return;
    this.active = false;
    this.bridge.stopFirehose();
    this.accum.clear();
    this.engine.clear();
    this.version++;
  }

  // -------------------------------------------------------------------------
  // Pattern
  // -------------------------------------------------------------------------

  setPattern(p: string): void {
    this.pattern = p;
    this.compile();
  }

  toggleCaseInsensitive(): void {
    this.caseInsensitive = !this.caseInsensitive;
    this.compile();
  }

  /**
   * Compile the current pattern into a RegExp and hand it to the engine,
   * surfacing a SyntaxError inline. An empty pattern matches nothing (the feed
   * is idle until you type), which is the honest "no query" state.
   */
  private compile(): void {
    const src = this.pattern;
    if (src.length === 0) {
      this.compileError = null;
      this.engine.setPattern(null);
      this.version++;
      return;
    }
    if (src.length > MAX_PATTERN_LEN) {
      this.compileError = `pattern too long (max ${MAX_PATTERN_LEN} chars)`;
      this.engine.setPattern(null);
      this.version++;
      return;
    }
    try {
      const re = new RegExp(src, this.caseInsensitive ? "i" : "");
      this.compileError = null;
      this.engine.setPattern(re);
    } catch (err) {
      this.compileError =
        err instanceof Error ? err.message : "invalid regular expression";
      this.engine.setPattern(null);
    }
    this.version++;
  }

  // -------------------------------------------------------------------------
  // Live ingestion
  // -------------------------------------------------------------------------

  private tick(): void {
    if (this.accum.size === 0) return;
    runInAction(() => {
      for (const [paneId, chunks] of this.accum) {
        this.engine.pushBytes(paneId, chunks.join(""));
      }
      this.accum.clear();
      // Bump unconditionally: even a no-match drain can change tappedPaneCount.
      this.version++;
    });
  }

  // -------------------------------------------------------------------------
  // Derived
  // -------------------------------------------------------------------------

  /** The live, bounded match feed (chronological). */
  get matches(): readonly RegexMatch[] {
    void this.version;
    return this.engine.matches;
  }

  /** Number of panes that have produced bytes since the firehose opened. */
  get tappedPaneCount(): number {
    void this.version;
    return this.engine.tappedPaneCount;
  }

  /** Number of matches currently in the feed. */
  get matchCount(): number {
    void this.version;
    return this.engine.matches.length;
  }
}
