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
  PLAYGROUND_SUB,
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

/**
 * Quote one argument for tmux's control-mode command lexer: wrap in single
 * quotes and escape any embedded single quote as the `'\''` sequence (close
 * quote, backslash-escaped literal quote, reopen). Verified against tmux 3.6a
 * control mode — `it's` round-trips through both `display-message -p` and
 * `refresh-client -B`. [LAW:single-enforcer] every tmux command the Playground
 * builds runs its dynamic parts through this one helper, so format strings reach
 * tmux intact regardless of embedded quotes. [FRAMING:representation] quoting is
 * a property of the wire encoding, applied only at the command callsite — the
 * persisted format string never carries it.
 */
export function quoteTmuxArg(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * The tmux `<what>` selector for a subscription / one-shot target. `active` maps
 * to the empty selector (session scope), which tmux evaluates against the
 * client's active pane — so `active` naturally tracks whatever pane is current.
 * An explicit target carries its concrete pane token (e.g. `%3`). A pane context
 * can resolve session/window/pane formats alike, so one target shape serves
 * every format. [LAW:one-type-per-behavior]
 */
function targetWhat(target: PlaygroundTarget): string {
  return target.kind === "active" ? "" : target.target;
}

/**
 * Signature identifying a live subscription by the only inputs that change its
 * tmux command: the target selector and the format. Re-subscribing with an
 * identical signature is a no-op, which keeps a subscription alive untouched
 * across view re-mounts (tab switches) instead of thrashing it. The target
 * selector is empty or a single tmux token (`%3`, `@2`) and never contains a
 * space, so it is the whole prefix up to the first space — distinct
 * (what, format) pairs can't collide. [LAW:dataflow-not-control-flow] desired
 * state is data; refresh reconciles current → desired, not a branch on history.
 */
function subscriptionSig(target: PlaygroundTarget, format: string): string {
  return `${targetWhat(target)} ${format}`;
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
  // Signature (`what` + format) of the live subscription, or `null` when none.
  // Re-`refresh()` with a matching signature is a no-op, so a subscription
  // survives view re-mounts (tab switches) untouched rather than being torn down
  // and rebuilt. [LAW:dataflow-not-control-flow]
  private liveSig: string | null = null;
  // Connection-state listener teardown. The store owns the "subscribe once the
  // bridge is ready" coupling: on `ready` it reconciles to the desired
  // Playground state, so booting straight into subscribed mode installs the
  // subscription when the transport can carry it. [LAW:no-ambient-temporal-coupling]
  private disposeState: (() => void) | null = null;
  // Monotonic token guarding one-shot evaluations against out-of-order
  // resolution: only the latest issued one-shot may write the result, so a slow
  // earlier request can never clobber a newer one. [LAW:no-ambient-temporal-coupling]
  private evalToken = 0;
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
    // Reconcile the Playground to its desired state whenever the transport
    // reaches `ready`. The common case (user opens the tab long after boot)
    // is driven by the view calling refresh() on mount; this handler covers
    // the boot-into-subscribed case where the persisted mode wants a live
    // subscription before the bridge can carry one. refresh() is idempotent,
    // so the two paths never double-subscribe. [LAW:no-ambient-temporal-coupling]
    this.disposeState = bridge.onState((state) => {
      if (state === "ready") this.refresh();
    });
  }

  dispose(): void {
    this.teardownSubscription();
    if (this.disposeState !== null) {
      this.disposeState();
      this.disposeState = null;
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

  // ---------------------------------------------------------------------------
  // Format Playground — evaluate a tmux format against a target, one-shot or
  // subscribed. The store owns the subscription lifecycle end to end: there is
  // ever at most one live subscription, and every setter reconciles toward the
  // desired (mode, target, format) by tearing down the old flow and starting
  // the new one. Components only call these setters and refresh(); they never
  // touch the subscription directly. [LAW:no-ambient-temporal-coupling]
  // ---------------------------------------------------------------------------

  /** Persist a new format and re-evaluate. The view debounces keystrokes before
   *  calling this, so subscriptions don't thrash mid-typing. */
  setPlaygroundFormat(format: string): void {
    this.uiStore.setConsoleFormat(format);
    this.refresh();
  }

  /** Persist a new target and re-evaluate (re-subscribes in subscribed mode). */
  setPlaygroundTarget(target: PlaygroundTarget): void {
    this.uiStore.setConsoleTarget(target);
    this.refresh();
  }

  /** Persist a new mode and re-evaluate. Switching modes tears down any active
   *  subscription before the new flow starts (subscribe ⇄ one-shot). */
  setPlaygroundMode(mode: PlaygroundMode): void {
    this.uiStore.setConsoleMode(mode);
    this.refresh();
  }

  /**
   * Reconcile the live evaluation to the persisted (mode, target, format). In
   * subscribed mode an unchanged signature is a no-op so the subscription
   * survives view re-mounts; otherwise the old flow is torn down and the new one
   * started. In one-shot mode every call issues a fresh `display-message`.
   * [LAW:dataflow-not-control-flow] the same reconcile runs regardless of which
   * setter (or the ready handler, or the view on mount) called it — the inputs
   * are data, not a per-caller branch.
   */
  refresh(): void {
    const token = ++this.evalToken;
    const target = this.playgroundTarget;
    const format = this.playgroundFormat;
    if (this.playgroundMode === "subscribed") {
      const sig = subscriptionSig(target, format);
      if (this.disposeSubscription !== null && this.liveSig === sig) return;
      this.teardownSubscription();
      this.startSubscription(target, format, sig);
      return;
    }
    this.teardownSubscription();
    void this.runOneShot(target, format, token);
  }

  /**
   * Evaluate the format once via `display-message -p`. tmux resolves `-t` against
   * the target pane (omitted for `active`, which uses the client's active pane).
   * A `%error` resolves with `success: false` carrying the diagnostic (the bridge
   * normalizes tmux errors); a transport failure rejects — both land in the error
   * variant. [LAW:no-silent-failure] the real message rides the result.
   *
   * The token guard drops a stale resolution: if a newer evaluation was issued
   * (mode/target/format changed) while this one was in flight, its result is
   * discarded rather than overwriting the newer state.
   */
  private async runOneShot(
    target: PlaygroundTarget,
    format: string,
    token: number,
  ): Promise<void> {
    const targetArg = target.kind === "active" ? "" : ` -t ${target.target}`;
    const command = `display-message -p${targetArg} ${quoteTmuxArg(format)}`;
    const result = await this.evalOneShot(command);
    runInAction(() => {
      if (token === this.evalToken) this.playgroundResult = result;
    });
  }

  private async evalOneShot(command: string): Promise<PlaygroundResult> {
    try {
      const resp = await this.bridge.execute(command);
      if (resp.success) {
        return { status: "value", value: resp.output.map(decodeLine).join("\n"), updateCount: 1 };
      }
      return {
        status: "error",
        message: resp.output.map(decodeLine).join("\n") || "evaluation failed (%error)",
      };
    } catch (err) {
      return { status: "error", message: errorMessage(err) };
    }
  }

  /**
   * Install the single Playground subscription via `refresh-client -B
   * <name>:<what>:<format>`. tmux reports each change as `%subscription-changed`
   * (at most once per second, only when the value changes), with the first value
   * arriving on the ~1s timer — so the result stays `idle` until the first fire,
   * which is what distinguishes "hasn't fired yet" from an evaluated-empty value.
   * The teardown closes over both the event listener removal and the tmux-side
   * `refresh-client -B <name>` removal, so dispose()/re-subscribe drop the
   * subscription completely.
   */
  private startSubscription(
    target: PlaygroundTarget,
    format: string,
    sig: string,
  ): void {
    const off = this.bridge.onEvent((ev) => {
      if (ev.type !== "subscription-changed" || ev.name !== PLAYGROUND_SUB) return;
      runInAction(() => {
        const prev = this.playgroundResult;
        const updateCount = (prev.status === "value" ? prev.updateCount : 0) + 1;
        this.playgroundResult = { status: "value", value: decodeLine(ev.value), updateCount };
      });
    });
    // [LAW:no-silent-failure] Fire-and-forget by design — the result is never
    // consumed and a bridge-closed rejection is already reported via
    // onState/onError — but log it so a future non-BRIDGE_CLOSED rejection
    // (validation, timeout, ...) doesn't vanish with zero diagnostic.
    this.disposeSubscription = () => {
      off();
      void this.bridge
        .execute(`refresh-client -B ${PLAYGROUND_SUB}`)
        .catch((err: unknown) =>
          console.warn("[console] unsubscribe failed", err),
        );
    };
    this.liveSig = sig;
    this.playgroundResult = { status: "idle" };
    const what = targetWhat(target);
    void this.bridge
      .execute(
        `refresh-client -B ${quoteTmuxArg(`${PLAYGROUND_SUB}:${what}:${format}`)}`,
      )
      .catch((err: unknown) => {
        console.warn("[console] subscribe failed", err);
        // [LAW:no-ambient-temporal-coupling] Only unwind if this attempt is
        // still the live one — a rejection for a subscribe that a later
        // refresh() already tore down must not stomp the newer
        // subscription's state. Otherwise the store would believe a
        // subscription is live forever (refresh() no-ops on an unchanged
        // signature) when tmux never actually installed one.
        if (this.liveSig !== sig) return;
        off();
        runInAction(() => {
          this.liveSig = null;
          this.disposeSubscription = null;
          // [LAW:no-silent-failure] Otherwise the user sees "idle" forever
          // with no indication the subscribe command was ever rejected —
          // runOneShot's catch surfaces the same {status:"error"} variant.
          this.playgroundResult = {
            status: "error",
            message: errorMessage(err),
          };
        });
      });
  }

  /** Drop the live subscription if any: remove the listener and tell tmux to
   *  stop. Idempotent — the single tear-down point shared by refresh()/dispose(). */
  private teardownSubscription(): void {
    if (this.disposeSubscription !== null) {
      this.disposeSubscription();
      this.disposeSubscription = null;
    }
    this.liveSig = null;
  }
}
