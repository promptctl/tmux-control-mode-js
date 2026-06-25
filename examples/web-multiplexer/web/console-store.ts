// examples/web-multiplexer/web/console-store.ts
//
// ConsoleStore — the MobX store backing the Console tab. It mirrors the
// InspectorStore / HeatmapStore pattern: bridge-coupled, constructed at
// mount, explicitly disposed at unmount. The store outlives the view
// (owned by App.tsx), so an in-flight command resolves even if the user
// switches tabs and back.
//
// This is the foundation slice (tmux-showcase-bhx.25.1): it lands the
// state model, the persistence-backed accessors, and the teardown seam.
// The REPL submit pipeline (25.2) and the Playground evaluate/subscribe
// flow (25.3) fill in the mutating methods on top of this.
//
// [LAW:one-source-of-truth] The persisted slice (command history, last
// format/target/mode) lives in UiStore, the single persistence authority.
// ConsoleStore is the API surface the components talk to, but it reads
// that slice back through getters rather than keeping a second copy that
// could drift. The live REPL ring and the playground result are runtime
// state ConsoleStore owns outright — they are deliberately not persisted
// (response bodies can be huge; recall only needs the command strings).
//
// [LAW:dataflow-not-control-flow] REPL entries are discriminated by
// `status`; an entry's outcome is data carried on the entry, never a
// branch deciding whether a field exists. Transitions replace the entry
// in the ring rather than mutating fields in place.

import { makeAutoObservable, runInAction } from "mobx";
import { latin1ToBytes } from "@promptctl/tmux-control-mode-js/protocol";
import type { TmuxBridge } from "./bridge.ts";
import type { UiStore } from "./ui-store.ts";
import {
  REPL_RING_CAP,
  type PlaygroundMode,
  type PlaygroundResult,
  type PlaygroundTarget,
  type RecallStep,
  type ReplEntry,
} from "./console-types.ts";

// tmux command output crosses the wire as latin1-container byte-faithful
// strings (see CommandResponse.output). Decode once here, at the boundary where
// wire bytes enter the store, so every `ReplEntry` carries display-ready UTF-8
// and the view never touches byte codecs. [FRAMING:representation]
const utf8 = new TextDecoder();
function decodeLine(line: string): string {
  return utf8.decode(latin1ToBytes(line));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class ConsoleStore {
  /** Live REPL timeline. Holds full response bodies; never persisted. */
  replEntries: ReplEntry[] = [];
  /** Latest Playground evaluation. Runtime-only; resets to idle on reload. */
  playgroundResult: PlaygroundResult = { status: "idle" };

  // The command seam. The REPL and Playground panes drive tmux through
  // this bridge (submit / evaluate / subscribe land in 25.2 and 25.3).
  private readonly bridge: TmuxBridge;
  // Persistence authority. ConsoleStore reads the persisted slice from
  // here and (in later slices) writes it back through UiStore mutators.
  private readonly uiStore: UiStore;
  // Single playground subscription teardown. Exactly one subscription is
  // ever live; `null` means none. dispose() is the one tear-down point —
  // mount/unmount of a component never starts or stops a subscription.
  // [LAW:no-ambient-temporal-coupling]
  private disposeSubscription: (() => void) | null = null;
  // Monotonic id for REPL rows. Never reused, so resolution finds its entry by
  // id even after the ring has shifted, and React keys stay stable.
  private nextId = 0;
  // Recall cursor: an index into `commandHistory` (most-recent-last), or `null`
  // for the live (not-recalling) input line. Reset to `null` on submit.
  private recallCursor: number | null = null;
  // Injected clock — the sole time source for latency. [LAW:effects-at-boundaries]
  // reading the clock is the store's one impurity; injecting it keeps latency
  // deterministic under test without an ambient `Date.now()` reach.
  private readonly now: () => number;

  constructor(bridge: TmuxBridge, uiStore: UiStore, now: () => number = Date.now) {
    this.bridge = bridge;
    this.uiStore = uiStore;
    this.now = now;
    makeAutoObservable(this);
  }

  dispose(): void {
    if (this.disposeSubscription !== null) {
      this.disposeSubscription();
      this.disposeSubscription = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Persisted slice — read-through to the single authority (UiStore).
  // ---------------------------------------------------------------------------

  /** Recall buffer: prior commands, most-recent-last. */
  get commandHistory(): readonly string[] {
    return this.uiStore.console.commandHistory;
  }

  get playgroundFormat(): string {
    return this.uiStore.console.lastFormat;
  }

  get playgroundTarget(): PlaygroundTarget {
    return this.uiStore.console.lastTarget;
  }

  get playgroundMode(): PlaygroundMode {
    return this.uiStore.console.lastMode;
  }

  // ---------------------------------------------------------------------------
  // REPL — submit / recall / clear.
  // ---------------------------------------------------------------------------

  /**
   * Run a tmux command and render its result as a REPL row. The pipeline is the
   * same on every call — push a `pending` row, await the bridge, replace it with
   * the resolved variant — so the outcome lives in the entry's `status`, never
   * in whether a row appears. [LAW:dataflow-not-control-flow]
   *
   * Empty/whitespace submits are a precondition miss (no command to run), so
   * they short-circuit before any row or history write.
   */
  async submit(command: string): Promise<void> {
    const trimmed = command.trim();
    if (trimmed.length === 0) return;

    // Persisted recall is UiStore's authority; route the write there, never
    // mutate the slice from here or the view. [LAW:one-source-of-truth]
    this.uiStore.pushConsoleCommand(trimmed);
    this.recallCursor = null;

    const id = this.nextId++;
    const submittedAt = this.now();
    this.pushEntry({ id, command: trimmed, submittedAt, status: "pending" });

    const resolved = await this.runCommand(id, trimmed, submittedAt);
    // Post-await mutation re-enters an action so MobX tracks it. The store
    // outlives the view, so this lands even after a tab switch.
    runInAction(() => this.replaceEntry(resolved));
  }

  /**
   * Resolve one command into its terminal `ReplEntry` variant. The bridge's
   * `execute` honors `Promise<CommandResponse>`: a tmux `%end` resolves with
   * `success: true`, a `%error` resolves with `success: false` carrying the
   * diagnostic, and a transport failure rejects. All three map to a single ok |
   * error value — the source of the error is not represented separately, matching
   * the `ReplEntry` error variant. [LAW:no-silent-failure] the rejection's real
   * message rides the row; it is never swallowed to a console log.
   */
  private async runCommand(
    id: number,
    command: string,
    submittedAt: number,
  ): Promise<ReplEntry> {
    const common = { id, command, submittedAt };
    try {
      const resp = await this.bridge.execute(command);
      const latencyMs = this.now() - submittedAt;
      return resp.success
        ? { ...common, status: "ok", output: resp.output.map(decodeLine), latencyMs }
        : {
            ...common,
            status: "error",
            message: resp.output.map(decodeLine).join("\n") || "command failed (%error)",
            latencyMs,
          };
    } catch (err) {
      const latencyMs = this.now() - submittedAt;
      return { ...common, status: "error", message: errorMessage(err), latencyMs };
    }
  }

  /**
   * Append a row, evicting the oldest *resolved* row once over the ring cap. A
   * pending row is never evicted, so its resolution always finds a slot — the
   * cap is soft against in-flight commands by design. [LAW:no-ambient-temporal-coupling]
   */
  private pushEntry(entry: ReplEntry): void {
    this.replEntries.push(entry);
    if (this.replEntries.length <= REPL_RING_CAP) return;
    const evictIdx = this.replEntries.findIndex((e) => e.status !== "pending");
    if (evictIdx >= 0) this.replEntries.splice(evictIdx, 1);
  }

  /**
   * Replace a row by id with its resolved variant. A missing id is genuine
   * absence — the user cleared the log while the command was in flight — so the
   * now-meaningless resolution is dropped rather than re-inserted. This is not a
   * swallowed failure: the command ran, and there is no row left to update.
   */
  private replaceEntry(entry: ReplEntry): void {
    const i = this.replEntries.findIndex((e) => e.id === entry.id);
    if (i < 0) return;
    this.replEntries[i] = entry;
  }

  /** Empty the live ring. Persisted recall history is untouched. */
  clear(): void {
    this.replEntries = [];
  }

  /**
   * Walk one step toward older history (the Up arrow). Returns the line to show,
   * or `none` at the oldest boundary / when history is empty — no wraparound.
   */
  recallPrevious(): RecallStep {
    const history = this.commandHistory;
    if (history.length === 0) return { kind: "none" };
    if (this.recallCursor === null) {
      this.recallCursor = history.length - 1;
    } else if (this.recallCursor > 0) {
      this.recallCursor -= 1;
    } else {
      return { kind: "none" };
    }
    return { kind: "command", text: history[this.recallCursor] };
  }

  /**
   * Walk one step toward newer history (the Down arrow). Past the newest entry
   * the cursor returns to the live line (`live`, an empty input); already-live
   * stays `none`. No wraparound.
   */
  recallNext(): RecallStep {
    const history = this.commandHistory;
    if (this.recallCursor === null) return { kind: "none" };
    if (this.recallCursor < history.length - 1) {
      this.recallCursor += 1;
      return { kind: "command", text: history[this.recallCursor] };
    }
    this.recallCursor = null;
    return { kind: "live" };
  }
}
