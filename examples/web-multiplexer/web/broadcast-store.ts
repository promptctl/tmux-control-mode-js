// examples/web-multiplexer/web/broadcast-store.ts
//
// BroadcastStore — the IO boundary for "smart broadcast input with per-pane
// transforms". It holds the broadcast template, the set of selected target panes,
// the per-pane variable overrides, and the append-Enter toggle; it derives each
// pane's built-in bindings from the LIVE pane model (`DemoStore.sessions`), and on
// send it fans the resolved bytes out over the existing `sendKeys` boundary.
//
// THE WRITE PATH IS NOT RE-INVENTED. The bytes go out via `bridge.sendKeys`
// (`send-keys -H`) — the one input boundary the escape playground and the
// multiplexer already use. [LAW:single-enforcer] this store adds a fan-out over
// targets, not a second way to put input on the wire.
//
// THE PREVIEW AND THE WIRE ARE ONE VALUE. `resolutions` (a getter over the pure
// engine) drives BOTH the per-pane preview the view renders and the bytes `send`
// transmits. There is no separate "compute what to show" vs "compute what to
// send" path to drift. [LAW:one-source-of-truth]
//
// PANE FACTS ARE DERIVED, NEVER COPIED. Built-in bindings (`${pane}`, `${title}`…)
// are projected from `DemoStore`'s live model on every read, so a renamed window
// or resized pane is reflected without a sync step. The store stores only what the
// user authored — template, selection, overrides — never a snapshot of pane state.
// [LAW:one-source-of-truth]
//
// [LAW:effects-at-boundaries] The only effect here is the `sendKeys` fan-out (and
//   reading the live model); all template parsing, per-pane resolution, and the
//   resolved/unresolved split are the pure `broadcast-engine`. Unlike the recording
//   stores this owns NO tmux resource — it writes to panes that already exist — so
//   it has no spawn/teardown lifecycle.

import { makeAutoObservable, runInAction } from "mobx";
import type { TmuxBridge } from "./bridge.ts";
import type { DemoStore } from "./store.ts";
import {
  BUILTIN_VARS,
  type PaneFacts,
  type PaneResolution,
  builtinBindings,
  resolveBroadcast,
  sendablePanes,
  templateVars,
} from "./broadcast-engine.ts";

/** A pane the user may broadcast to: its facts, a label, and selection state. */
export interface TargetPane {
  readonly facts: PaneFacts;
  /** `session:window.pane`, the same label the debug panel uses. */
  readonly label: string;
  readonly selected: boolean;
}

/** A row of the live preview: a resolution paired with its pane label. */
export interface PreviewRow {
  readonly label: string;
  readonly resolution: PaneResolution;
}

/** Outcome of the most recent `send`, for the confirmation line. */
export interface SendSummary {
  readonly sentPanes: number;
  readonly sentBytes: number;
  readonly blockedPanes: number;
}

const BUILTIN_SET: ReadonlySet<string> = new Set(BUILTIN_VARS);

export class BroadcastStore {
  /** The broadcast template, e.g. `ssh ${host}` or `echo pane ${pane}`. */
  template = "echo pane ${pane} in ${session}";
  /** Selected target pane ids. A MobX-observable Set — membership is the value. */
  selected = new Set<number>();
  /** Per-pane variable overrides: paneId → (varName → value). */
  overrides: Record<number, Record<string, string>> = {};
  /** Append a CR so each command RUNS rather than sitting at the prompt. */
  appendEnter = true;
  lastSend: SendSummary | null = null;

  // Monotonic id identifying which send() call currently owns `lastSend` — an
  // identity guard, not a value guard, for the same ABA reason as
  // EscapePlaygroundStore.sendToken: a slower, older send() settling after a
  // newer one must not clobber the newer call's summary.
  // [LAW:no-ambient-temporal-coupling]
  private sendToken = 0;

  constructor(
    private readonly bridge: TmuxBridge,
    private readonly demo: DemoStore,
  ) {
    makeAutoObservable<this, "bridge" | "demo" | "sendToken">(this, {
      bridge: false,
      demo: false,
      sendToken: false,
    });
  }

  // -------------------------------------------------------------------------
  // Derived views of the live pane model
  // -------------------------------------------------------------------------

  /**
   * Every pane currently in any session, as a broadcast target. Derived from the
   * live model on each read, so closing a pane or renaming a window updates the
   * list with no sync step. [LAW:one-source-of-truth]
   */
  get targets(): readonly TargetPane[] {
    const out: TargetPane[] = [];
    for (const s of this.demo.sessions) {
      for (const w of s.windows) {
        for (const p of w.panes) {
          out.push({
            facts: {
              paneId: p.id,
              paneIndex: p.index,
              title: p.title,
              width: p.width,
              height: p.height,
              windowName: w.name,
              windowIndex: w.index,
              sessionName: s.name,
            },
            label: `${s.name}:${w.index}.${p.index}`,
            selected: this.selected.has(p.id),
          });
        }
      }
    }
    return out;
  }

  /** The selected targets that still exist in the live model. */
  get selectedTargets(): readonly TargetPane[] {
    return this.targets.filter((t) => t.selected);
  }

  /**
   * The variables the template references that are NOT built-in pane facts — the
   * columns the override grid must surface for the user to fill. Built-ins resolve
   * from the pane itself and need no input. [LAW:dataflow-not-control-flow] this is
   * a projection of the template value, not a mode the view toggles.
   */
  get overrideVars(): readonly string[] {
    return templateVars(this.template).filter((v) => !BUILTIN_SET.has(v));
  }

  /**
   * Per-pane resolutions for the selected targets — the SINGLE value behind both
   * the preview and the send. Each pane's bindings are its built-in facts with the
   * user overrides merged on top (overrides win).
   */
  get resolutions(): readonly PreviewRow[] {
    const selected = this.selectedTargets;
    const merged = selected.map((t) => ({
      paneId: t.facts.paneId,
      bindings: {
        ...builtinBindings(t.facts),
        ...(this.overrides[t.facts.paneId] ?? {}),
      },
    }));
    const resolved = resolveBroadcast(this.template, merged, {
      appendEnter: this.appendEnter,
    });
    return selected.map((t, i) => ({
      label: t.label,
      resolution: resolved[i],
    }));
  }

  /** How many selected panes are ready to send (the rest are blocked on a var). */
  get sendableCount(): number {
    return this.resolutions.filter((r) => r.resolution.kind === "resolved")
      .length;
  }

  /** How many selected panes are blocked on an unbound variable. */
  get blockedCount(): number {
    return this.resolutions.filter((r) => r.resolution.kind === "unresolved")
      .length;
  }

  // -------------------------------------------------------------------------
  // User intent
  // -------------------------------------------------------------------------

  setTemplate(template: string): void {
    this.template = template;
  }

  setAppendEnter(on: boolean): void {
    this.appendEnter = on;
  }

  toggleSelected(paneId: number): void {
    if (this.selected.has(paneId)) {
      this.selected.delete(paneId);
    } else {
      this.selected.add(paneId);
    }
  }

  selectAll(): void {
    for (const t of this.targets) this.selected.add(t.facts.paneId);
  }

  selectNone(): void {
    this.selected.clear();
  }

  /**
   * Set (or clear) one pane's override for one variable. An empty value is a
   * deliberate empty binding the engine honors — distinct from no binding — so we
   * keep the key rather than deleting it. The view clears via its own control.
   */
  setOverride(paneId: number, varName: string, value: string): void {
    const row = this.overrides[paneId] ?? {};
    this.overrides[paneId] = { ...row, [varName]: value };
  }

  /** Read one pane's current override value (empty string when unset). */
  overrideOf(paneId: number, varName: string): string {
    return this.overrides[paneId]?.[varName] ?? "";
  }

  // -------------------------------------------------------------------------
  // Send (the only effect)
  // -------------------------------------------------------------------------

  /**
   * Fan the resolved payloads out over `sendKeys`. ONLY resolved panes are sent;
   * panes blocked on an unbound variable are counted and surfaced, never sent with
   * an empty substitution. [LAW:no-silent-failure]
   *
   * `lastSend` is derived from what actually reached tmux, not from what was
   * attempted: a rejected `sendKeys` (bridge closed mid-broadcast, one pane
   * failing) must not be counted as sent bytes/panes, so the summary is built
   * from `Promise.allSettled`'s outcomes rather than computed optimistically
   * before any call resolves. [LAW:one-source-of-truth]
   */
  send(): void {
    const ready = sendablePanes(this.resolutions.map((r) => r.resolution));
    const blockedPanes = this.blockedCount;
    const token = ++this.sendToken;
    void (async () => {
      const settled = await Promise.allSettled(
        ready.map((p) => this.bridge.sendKeys(`%${p.paneId}`, p.text)),
      );
      let sentPanes = 0;
      let sentBytes = 0;
      for (const [i, outcome] of settled.entries()) {
        const p = ready[i];
        if (outcome.status === "fulfilled") {
          sentPanes++;
          sentBytes += new TextEncoder().encode(p.text).length;
        } else {
          // [LAW:no-silent-failure] A bridge-closed rejection is already
          // reported via onState/onError, but log it so a future
          // non-BRIDGE_CLOSED rejection doesn't vanish with zero diagnostic.
          console.warn(
            `[broadcast] sendKeys to %${p.paneId} failed`,
            outcome.reason,
          );
        }
      }
      // [LAW:no-ambient-temporal-coupling] Discard a stale settlement: only
      // the most recent send() call may write `lastSend`.
      if (token !== this.sendToken) return;
      runInAction(() => {
        this.lastSend = { sentPanes, sentBytes, blockedPanes };
      });
    })();
  }
}
