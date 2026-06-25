// examples/web-multiplexer/web/conformance-store.ts
//
// ConformanceStore — the IO boundary for the Protocol Conformance Dashboard.
// Like the Protocol Tutorial it touches NO tmux, NO bridge, NO firehose: it runs
// the library's own conformance catalogue (`buildConformanceChecks`, pulled from
// the browser-safe `/conformance` subpath) entirely in this tab. Each check
// spins a real MockTmuxServer → real TmuxClient, drives one documented protocol
// surface, and reports green/red. The dashboard IS the conformance suite — the
// same catalogue the unit gate runs.
//
// [LAW:effects-at-boundaries] The checks are pure descriptors whose only effect
//   is inside `run()`; this store is the observable shell that schedules them
//   and captures their outcomes.
// [LAW:one-source-of-truth] `rows` mirrors the catalogue order; the catalogue
//   (the library) is the authority on WHAT is checked — the store never invents
//   a check or hard-codes the variant list.
// [LAW:no-ambient-temporal-coupling] Nothing runs on construction or a timer;
//   the view drives `runAll()` on mount and on demand. The learner owns the clock.

import { makeAutoObservable, runInAction } from "mobx";
import { buildConformanceChecks } from "@promptctl/tmux-control-mode-js/conformance";
import type {
  ConformanceCheck,
  CheckOutcome,
  ObservationChannel,
} from "@promptctl/tmux-control-mode-js/conformance";

/** A row's lifecycle: not yet run, running, or settled to the check's verdict. */
export type RowStatus = "idle" | "running" | CheckOutcome["status"];

/** One dashboard row: the check's static identity plus its latest verdict. */
export interface ConformanceRow {
  readonly id: string;
  readonly channel: ObservationChannel;
  readonly title: string;
  readonly spec: string;
  status: RowStatus;
  detail: string;
}

/** A channel group for the grouped view, in a fixed display order. */
export interface ChannelGroup {
  readonly channel: ObservationChannel;
  readonly label: string;
  readonly rows: ConformanceRow[];
}

// [LAW:one-source-of-truth] Display order + labels for the three channels live
// here once; the view reads `groups`, never re-deciding order per render.
const CHANNEL_ORDER: readonly { channel: ObservationChannel; label: string }[] = [
  { channel: "notification", label: "Notifications (%event → client event)" },
  { channel: "pane-output", label: "Pane output (%output → decoded sink bytes)" },
  { channel: "command", label: "Commands (%begin/%end/%error correlation)" },
];

export class ConformanceStore {
  rows: ConformanceRow[];
  running = false;

  private readonly checks: ConformanceCheck[];

  constructor() {
    this.checks = buildConformanceChecks();
    this.rows = this.checks.map((c) => ({
      id: c.id,
      channel: c.channel,
      title: c.title,
      spec: c.spec,
      status: "idle",
      detail: "",
    }));
    makeAutoObservable<this, "checks">(this, { checks: false });
  }

  dispose(): void {
    // No external resources: each check's mock+client is created and discarded
    // inside its own run(); there is nothing to release.
  }

  // -------------------------------------------------------------------------
  // Derived views — [LAW:dataflow-not-control-flow] pure projections of `rows`
  // -------------------------------------------------------------------------

  /** Tally of the current verdicts, for the header summary. */
  get summary(): {
    total: number;
    passed: number;
    failed: number;
    pending: number;
  } {
    let passed = 0;
    let failed = 0;
    let pending = 0;
    for (const r of this.rows) {
      if (r.status === "pass") passed++;
      else if (r.status === "fail") failed++;
      else pending++;
    }
    return { total: this.rows.length, passed, failed, pending };
  }

  /** Every check passed (and at least one ran) — the all-green signal. */
  get allGreen(): boolean {
    const { total, passed } = this.summary;
    return total > 0 && passed === total;
  }

  /** Rows grouped by observation channel in display order, empties dropped. */
  get groups(): ChannelGroup[] {
    return CHANNEL_ORDER.map(({ channel, label }) => ({
      channel,
      label,
      rows: this.rows.filter((r) => r.channel === channel),
    })).filter((g) => g.rows.length > 0);
  }

  // -------------------------------------------------------------------------
  // Run
  // -------------------------------------------------------------------------

  /**
   * Run the whole catalogue, settling each row to its verdict as it completes.
   * Re-entrancy guarded: a second call while a run is in flight is a no-op, so
   * the button cannot interleave two runs over the same rows.
   */
  async runAll(): Promise<void> {
    if (this.running) return;
    runInAction(() => {
      this.running = true;
      for (const r of this.rows) {
        r.status = "running";
        r.detail = "";
      }
    });

    for (let i = 0; i < this.checks.length; i++) {
      const outcome = await this.checks[i].run();
      runInAction(() => {
        this.rows[i].status = outcome.status;
        this.rows[i].detail = outcome.detail;
      });
    }

    runInAction(() => {
      this.running = false;
    });
  }
}
