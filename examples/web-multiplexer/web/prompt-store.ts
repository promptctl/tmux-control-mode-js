// examples/web-multiplexer/web/prompt-store.ts
//
// PromptStore — the IO boundary for the OSC 133 prompt detector + command
// palette: a live watch over the firehose of EVERY pane in EVERY session that
// chunks each pane's output into discrete commands, and the ONE write path that
// re-runs a chosen command in the pane it came from. It owns exactly three
// effects: (1) the firehose start/stop lifecycle, (2) draining accumulated bytes
// into the pure PromptEngine on a ticker, (3) the `sendKeys` re-run. The framing
// and command-chunking it drives are pure and unit-tested in isolation.
//
// [LAW:effects-at-boundaries] All IO (bridge.startFirehose / onFirehose /
//   onState / sendKeys, the ticker) lives here; the PromptEngine is pure.
// [LAW:one-source-of-truth] The engine's history IS the command list. `version`
//   is a change-signal for the non-observable engine, not a second copy.
// [LAW:dataflow-not-control-flow] Every firehose chunk is accumulated; every tick
//   drains the accumulator through the same engine.pushBytes pipeline. "No
//   commands yet" is the empty-history case, not a skipped branch.
// [LAW:no-ambient-temporal-coupling] Unlike the OSC 8 sidebar / data sniffer,
//   there is NO quiescence flush: a command is completed by its `D` mark or
//   superseded by the next prompt, both explicit events. A silent pane may be
//   running a long command, so the tick only DRAINS — it never finalizes.
// [LAW:single-enforcer] `rerun` is the ONE place a command is written back to a
//   live shell. Re-run is never automatic — it fires only on an explicit user
//   action — and it targets the origin pane (the command's known context).

import { makeAutoObservable, runInAction } from "mobx";
import type { TmuxBridge } from "./bridge.ts";
import { PromptEngine, type CommandRecord } from "./prompt-engine.ts";

/** Drain the firehose byte accumulator into the engine at this cadence. */
const TICK_INTERVAL_MS = 200;
/** Max commands retained in the history ring (oldest evicted). Bounds memory. */
const COMMAND_CAP = 1000;
/** Carriage return — what the Enter key transmits; re-run executes the command. */
const ENTER = "\r";

export type { CommandRecord, CommandStatus } from "./prompt-engine.ts";

export class PromptStore {
  /** True while the firehose taps are open (command-palette mode is active). */
  active = false;
  /**
   * [LAW:one-source-of-truth] Change-signal for the non-observable engine.
   * Bumped once per drain tick so the `commands` computed recomputes without
   * making the engine's internals observable.
   */
  version = 0;
  /** Currently-expanded command id in the palette (null = none expanded). */
  selectedId: number | null = null;
  /** Case-insensitive substring filter over the command line (palette search). */
  filter = "";

  private readonly engine = new PromptEngine(COMMAND_CAP);
  private readonly accum = new Map<number, Uint8Array[]>();
  private timerHandle: number | null = null;
  private readonly disposeOnFirehose: () => void;
  private readonly disposeOnState: () => void;

  constructor(private readonly bridge: TmuxBridge) {
    makeAutoObservable<this, "engine" | "accum" | "bridge" | "timerHandle">(
      this,
      { engine: false, accum: false, bridge: false, timerHandle: false },
    );

    this.disposeOnFirehose = bridge.onFirehose((paneId, data) => {
      let chunks = this.accum.get(paneId);
      if (chunks === undefined) {
        chunks = [];
        this.accum.set(paneId, chunks);
      }
      chunks.push(data);
    });

    // A reconnect drops the previous server's taps; re-open the firehose if
    // command-palette mode is still active so history keeps growing past a swap.
    this.disposeOnState = bridge.onState((state) => {
      if (state === "ready" && this.active) this.bridge.startFirehose();
    });

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

  /** Open the firehose taps. Idempotent. Called on entering palette mode. */
  start(): void {
    if (this.active) return;
    this.active = true;
    this.bridge.startFirehose();
  }

  /**
   * Close the firehose taps and free the history. Called on leaving the mode —
   * idle panes shouldn't keep paying the pipe-pane cost. History repopulates
   * live on the next `start`.
   */
  stop(): void {
    if (!this.active) return;
    this.active = false;
    this.bridge.stopFirehose();
    this.accum.clear();
    this.engine.clear();
    this.selectedId = null;
    this.version++;
  }

  /** Drop the history without leaving the mode (the "clear" button). */
  clearHistory(): void {
    this.engine.clear();
    this.accum.clear();
    this.selectedId = null;
    this.version++;
  }

  /** Expand/collapse a command in the palette. */
  select(id: number | null): void {
    this.selectedId = this.selectedId === id ? null : id;
  }

  setFilter(text: string): void {
    this.filter = text;
  }

  // -------------------------------------------------------------------------
  // The write path (outbound) — re-run
  // -------------------------------------------------------------------------

  /**
   * Re-run a command in the pane it came from. [LAW:single-enforcer] the ONE
   * write boundary: the command line is sent verbatim followed by Enter, exactly
   * as `send-keys -H` byte-for-byte. Never automatic — only an explicit user
   * click reaches here. The origin pane is the command's known context (cwd,
   * shell), so a re-run lands where the command makes sense.
   */
  rerun(record: CommandRecord): void {
    // Fire-and-forget: a rejection (bridge closed mid-flight) carries no
    // action beyond what onState/onError already report.
    void this.bridge
      .sendKeys(`%${record.paneId}`, record.command + ENTER)
      .catch(() => {});
  }

  // -------------------------------------------------------------------------
  // Live ingestion
  // -------------------------------------------------------------------------

  private tick(): void {
    if (this.accum.size === 0) return;
    runInAction(() => {
      for (const [paneId, chunks] of this.accum) {
        for (const chunk of chunks) this.engine.pushBytes(paneId, chunk);
      }
      this.accum.clear();
      this.version++;
    });
  }

  // -------------------------------------------------------------------------
  // Derived
  // -------------------------------------------------------------------------

  /** The live command history (chronological by start). */
  get commands(): readonly CommandRecord[] {
    void this.version;
    return this.engine.commands;
  }

  /** History narrowed by the palette filter (substring over the command line). */
  get filteredCommands(): readonly CommandRecord[] {
    void this.version;
    const needle = this.filter.trim().toLowerCase();
    if (needle === "") return this.engine.commands;
    return this.engine.commands.filter((c) =>
      c.command.toLowerCase().includes(needle),
    );
  }

  /** Number of distinct panes that have produced bytes since the firehose opened. */
  get tappedPaneCount(): number {
    void this.version;
    return this.engine.tappedPaneCount;
  }

  /** Number of commands currently in the history. */
  get commandCount(): number {
    void this.version;
    return this.engine.commandCount;
  }

  get selectedCommand(): CommandRecord | null {
    void this.version;
    if (this.selectedId === null) return null;
    return this.engine.commands.find((c) => c.id === this.selectedId) ?? null;
  }
}
