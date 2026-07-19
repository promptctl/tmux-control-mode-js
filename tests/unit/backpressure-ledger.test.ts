// tests/unit/backpressure-ledger.test.ts
// Isolation tests for BackpressureLedger. Like SubscriptionLedger, the GM4
// split makes this a composable unit: it needs only a `{ execute }` runner plus
// a resume-failure reporter, not a whole transport. These tests pin its ONE
// invariant — a pane is paused iff the SUM of outstanding bytes across peers
// crossed the high watermark and has not fallen back below the low — plus the
// no-silent-failure resume classification.

import { describe, it, expect } from "vitest";

import {
  BackpressureLedger,
  type BackpressureLedgerDeps,
  type ResumeFailure,
} from "../../src/connectors/backpressure-ledger.js";
import { BridgeError } from "../../src/connectors/errors.js";
import { TmuxCommandError, TransportClosedError } from "../../src/errors.js";
import type { CommandResponse } from "../../src/protocol/types.js";

// ---------------------------------------------------------------------------
// Minimal fake runner. Pane-action commands are `refresh-client -A '%N:pause'`
// / `'%N:continue'` (see encoder). The test controls how the NEXT execute
// settles so resume-failure classification is exercisable.
// ---------------------------------------------------------------------------

function okResponse(): CommandResponse {
  return { commandNumber: 0, timestamp: 0, output: [], success: true };
}

interface Harness {
  readonly deps: BackpressureLedgerDeps;
  readonly sent: string[];
  readonly failures: ResumeFailure[];
  nextResult: { kind: "ok" } | { kind: "error"; err: unknown };
}

function createHarness(
  overrides: Partial<
    Pick<BackpressureLedgerDeps, "outputHighWatermark" | "outputLowWatermark">
  > = {},
): Harness {
  const sent: string[] = [];
  const failures: ResumeFailure[] = [];
  const harness: Harness = {
    sent,
    failures,
    nextResult: { kind: "ok" },
    deps: {
      client: {
        execute(command: string): Promise<CommandResponse> {
          sent.push(command);
          const result = harness.nextResult;
          harness.nextResult = { kind: "ok" };
          return result.kind === "ok"
            ? Promise.resolve(okResponse())
            : Promise.reject(result.err);
        },
      },
      reportResumeFailure: (f) => failures.push(f),
      outputHighWatermark: overrides.outputHighWatermark ?? 1000,
      outputLowWatermark: overrides.outputLowWatermark ?? 400,
    },
  };
  return harness;
}

const pauses = (sent: readonly string[]): string[] =>
  sent.filter((c) => c.includes(":pause"));
const continues = (sent: readonly string[]): string[] =>
  sent.filter((c) => c.includes(":continue"));

describe("BackpressureLedger (isolation)", () => {
  it("is constructible standalone with a runner + reporter", () => {
    const h = createHarness();
    const ledger = new BackpressureLedger(h.deps);
    expect(ledger).toBeInstanceOf(BackpressureLedger);
  });

  it("rejects invalid watermark config at construction (single enforcer)", () => {
    const h = createHarness({
      outputHighWatermark: 100,
      outputLowWatermark: 100,
    });
    expect(() => new BackpressureLedger(h.deps)).toThrow(BridgeError);
    expect(() => new BackpressureLedger(h.deps)).toThrow(/BRIDGE_INVALID_ARG/);
  });

  it("pauses a pane once when the summed outstanding crosses the high watermark", () => {
    const h = createHarness({
      outputHighWatermark: 1000,
      outputLowWatermark: 400,
    });
    const ledger = new BackpressureLedger(h.deps);
    const a = { id: 1 };
    ledger.register(a);

    ledger.account(a, 7, 600); // below high → no pause
    expect(pauses(h.sent)).toHaveLength(0);
    ledger.account(a, 7, 600); // 1200 ≥ high → pause once
    ledger.account(a, 7, 100); // already paused → no second pause
    expect(pauses(h.sent)).toHaveLength(1);
  });

  it("sums outstanding across peers before deciding to pause", () => {
    const h = createHarness({
      outputHighWatermark: 1000,
      outputLowWatermark: 400,
    });
    const ledger = new BackpressureLedger(h.deps);
    const a = { id: 1 };
    const b = { id: 2 };
    ledger.register(a);
    ledger.register(b);

    ledger.account(a, 7, 600);
    ledger.account(b, 7, 600); // neither alone crosses; the SUM (1200) does
    expect(pauses(h.sent)).toHaveLength(1);
  });

  it("resumes a paused pane when the summed outstanding drops below the low watermark", async () => {
    const h = createHarness({
      outputHighWatermark: 1000,
      outputLowWatermark: 400,
    });
    const ledger = new BackpressureLedger(h.deps);
    const a = { id: 1 };
    ledger.register(a);
    ledger.account(a, 7, 1200); // pause
    expect(pauses(h.sent)).toHaveLength(1);

    ledger.ack(a, 7, 900); // 300 < low → resume
    await Promise.resolve();
    expect(continues(h.sent)).toHaveLength(1);
  });

  it("ignores accounting for an unregistered peer (no resurrection)", () => {
    const h = createHarness();
    const ledger = new BackpressureLedger(h.deps);
    const ghost = { id: 99 };

    ledger.account(ghost, 7, 5000);
    ledger.ack(ghost, 7, 5000);
    ledger.clearPeer(ghost);
    expect(h.sent).toHaveLength(0);
  });

  it("clearPeer zeroes one peer's bytes and resumes only when the shared sum drops below low", async () => {
    // clearPeer (used by the WS bridge on ws.bufferedAmount → 0) zeroes just the
    // caller's slice and keeps others' accounting — distinct from releasePeer,
    // which drops the peer entirely. The pane resumes only once the SHARED sum
    // (across surviving peers) falls to or below the low watermark.
    const h = createHarness({
      outputHighWatermark: 1000,
      outputLowWatermark: 400,
    });
    const ledger = new BackpressureLedger(h.deps);
    const a = { id: 1 };
    const b = { id: 2 };
    ledger.register(a);
    ledger.register(b);
    ledger.account(a, 7, 600);
    ledger.account(b, 7, 600); // sum 1200 → pause
    expect(pauses(h.sent)).toHaveLength(1);

    ledger.clearPeer(a); // a → 0, but b's 600 keeps the sum above low → stays paused
    await Promise.resolve();
    expect(continues(h.sent)).toHaveLength(0);

    ledger.clearPeer(b); // sum now 0 ≤ low → resume
    await Promise.resolve();
    expect(continues(h.sent)).toHaveLength(1);
  });

  it("releasePeer drops a peer's bytes from the sum and resumes drained panes", async () => {
    const h = createHarness({
      outputHighWatermark: 1000,
      outputLowWatermark: 400,
    });
    const ledger = new BackpressureLedger(h.deps);
    const a = { id: 1 };
    const b = { id: 2 };
    ledger.register(a);
    ledger.register(b);
    ledger.account(a, 7, 600);
    ledger.account(b, 7, 600); // sum 1200 → pause
    expect(pauses(h.sent)).toHaveLength(1);

    ledger.releasePeer(b); // sum now 600 > low → stays paused
    await Promise.resolve();
    expect(continues(h.sent)).toHaveLength(0);

    ledger.releasePeer(a); // sum now 0 < low → resume
    await Promise.resolve();
    expect(continues(h.sent)).toHaveLength(1);
  });

  it("surfaces a live-pane resume failure (tmux %error) instead of swallowing it", async () => {
    const h = createHarness({
      outputHighWatermark: 1000,
      outputLowWatermark: 400,
    });
    const ledger = new BackpressureLedger(h.deps);
    const a = { id: 1 };
    ledger.register(a);
    ledger.account(a, 7, 1200); // pause (execute #1, OK)

    // The Continue's execute is rejected by tmux — pane still paused, tmux alive.
    h.nextResult = {
      kind: "error",
      err: new TmuxCommandError({
        commandNumber: 0,
        timestamp: 0,
        output: ["pane not paused"],
        success: false,
      }),
    };
    ledger.ack(a, 7, 900); // drop below low → resume attempt rejects
    await Promise.resolve();
    await Promise.resolve();

    expect(h.failures).toHaveLength(1);
    expect(h.failures[0]).toMatchObject({ paneId: 7 });
    expect(h.failures[0].error.code).toBe("TMUX_ERROR");
  });

  it("stays quiet on a connection-gone resume failure (moot pane on a dead link)", async () => {
    const h = createHarness({
      outputHighWatermark: 1000,
      outputLowWatermark: 400,
    });
    const ledger = new BackpressureLedger(h.deps);
    const a = { id: 1 };
    ledger.register(a);
    ledger.account(a, 7, 1200); // pause

    h.nextResult = {
      kind: "error",
      err: new TransportClosedError("socket closed"),
    };
    ledger.ack(a, 7, 900); // resume attempt rejects with connection-gone
    await Promise.resolve();
    await Promise.resolve();

    // A paused pane on a dead connection is moot — no report, entry dropped.
    expect(h.failures).toHaveLength(0);
  });

  it("flushPausedPanes resumes panes not already being resumed", async () => {
    const h = createHarness({
      outputHighWatermark: 1000,
      outputLowWatermark: 400,
    });
    const ledger = new BackpressureLedger(h.deps);
    const a = { id: 1 };
    ledger.register(a);
    ledger.account(a, 7, 1200); // pause — entry has resuming:false
    expect(pauses(h.sent)).toHaveLength(1);

    ledger.flushPausedPanes();
    await Promise.resolve();
    expect(continues(h.sent)).toHaveLength(1);
  });

  it("flushPausedPanes skips a pane whose Continue is already in flight", async () => {
    // Deferred execute so the Continue from maybeResume stays in flight across
    // the flush: the pane keeps `resuming: true` and stays in the ledger, so
    // flush hits the `if (flow.resuming) continue` skip branch. The resolvers
    // are settled before the test ends, so no promise dangles.
    const sent: string[] = [];
    const settlers: (() => void)[] = [];
    const deps: BackpressureLedgerDeps = {
      client: {
        execute(command: string): Promise<CommandResponse> {
          sent.push(command);
          return new Promise<CommandResponse>((resolve) => {
            settlers.push(() => resolve(okResponse()));
          });
        },
      },
      reportResumeFailure: () => {
        /* no strand expected in this test */
      },
      outputHighWatermark: 1000,
      outputLowWatermark: 400,
    };
    const ledger = new BackpressureLedger(deps);
    const a = { id: 1 };
    ledger.register(a);
    ledger.account(a, 7, 1200); // pause (Pause in flight)
    ledger.ack(a, 7, 900); // resume → resuming:true, Continue in flight
    expect(continues(sent)).toHaveLength(1);

    ledger.flushPausedPanes(); // pane 7 is resuming → skipped
    expect(continues(sent)).toHaveLength(1); // no second Continue

    // Settle the in-flight commands so nothing dangles past the test; flush
    // already cleared the ledger, so these resolutions are no-ops.
    for (const settle of settlers) settle();
    await Promise.resolve();
    expect(continues(sent)).toHaveLength(1);
  });

  it("register throws loudly on double-registration instead of silently overwriting", () => {
    const h = createHarness();
    const ledger = new BackpressureLedger(h.deps);
    const a = { id: 1 };
    ledger.register(a);
    expect(() => ledger.register(a)).toThrow(BridgeError);
    expect(() => ledger.register(a)).toThrow(/already registered/);
  });

  it("dispose releases every peer, resuming panes whose sum drains to zero", async () => {
    const h = createHarness({
      outputHighWatermark: 1000,
      outputLowWatermark: 400,
    });
    const ledger = new BackpressureLedger(h.deps);
    const a = { id: 1 };
    const b = { id: 2 };
    ledger.register(a);
    ledger.register(b);
    ledger.account(a, 7, 600);
    ledger.account(b, 8, 1200); // pane 8 paused; pane 7 stays below high
    expect(pauses(h.sent)).toHaveLength(1);

    ledger.dispose(); // releases both peers → pane 8's sum hits 0 → resume
    await Promise.resolve();
    expect(continues(h.sent).filter((c) => c.includes("%8:"))).toHaveLength(1);
  });
});
