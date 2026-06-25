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

import { makeAutoObservable } from "mobx";
import type { TmuxBridge } from "./bridge.ts";
import type { UiStore } from "./ui-store.ts";
import type {
  PlaygroundMode,
  PlaygroundResult,
  PlaygroundTarget,
  ReplEntry,
} from "./console-types.ts";

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

  constructor(bridge: TmuxBridge, uiStore: UiStore) {
    this.bridge = bridge;
    this.uiStore = uiStore;
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
}
