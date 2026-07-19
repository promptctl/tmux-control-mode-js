// tests/unit/subscription-ledger.test.ts
// Isolation tests for SubscriptionLedger. The whole point of the GM4 split is
// that this ledger is a composable unit: it needs only a `{ execute }` runner,
// not a whole transport. These tests construct it standalone with a minimal
// fake and pin its ONE invariant — first-owner subscribes, last-owner
// unsubscribes — plus the inflight-promise race handling.

import { describe, it, expect } from "vitest";

import {
  SubscriptionLedger,
  type SubscriptionLedgerDeps,
} from "../../src/connectors/subscription-ledger.js";
import { BridgeError } from "../../src/connectors/errors.js";
import { TmuxCommandError } from "../../src/errors.js";
import type { CommandResponse } from "../../src/protocol/types.js";

// ---------------------------------------------------------------------------
// Minimal fake: a command runner that records every command and lets a test
// control how each `execute` settles. This is the composability proof — the
// ledger asks for nothing more than `Pick<TmuxConnection, "execute">`.
// ---------------------------------------------------------------------------

interface FakeRunner {
  readonly deps: SubscriptionLedgerDeps;
  readonly sent: string[];
  /** Resolve/reject the NEXT execute with a controlled outcome. Defaults to OK. */
  nextResult: { kind: "ok" } | { kind: "error"; err: unknown };
}

function okResponse(): CommandResponse {
  return { commandNumber: 0, timestamp: 0, output: [], success: true };
}

function createFakeRunner(): FakeRunner {
  const sent: string[] = [];
  const runner: FakeRunner = {
    sent,
    nextResult: { kind: "ok" },
    deps: {
      client: {
        execute(command: string): Promise<CommandResponse> {
          sent.push(command);
          const result = runner.nextResult;
          runner.nextResult = { kind: "ok" };
          return result.kind === "ok"
            ? Promise.resolve(okResponse())
            : Promise.reject(result.err);
        },
      },
    },
  };
  return runner;
}

// refresh-client -B is overloaded: `'name':...` is subscribe, bare `'name'` is
// unsubscribe (mirrors bridge-connection.test.ts's discrimination).
const subscribes = (sent: readonly string[]): string[] =>
  sent.filter((c) => c.startsWith("refresh-client -B") && /'[^']*':/.test(c));
const unsubscribes = (sent: readonly string[]): string[] =>
  sent.filter((c) => c.startsWith("refresh-client -B") && !/'[^']*':/.test(c));

describe("SubscriptionLedger (isolation)", () => {
  it("is constructible standalone with only a command runner", () => {
    const runner = createFakeRunner();
    const ledger = new SubscriptionLedger(runner.deps);
    expect(ledger).toBeInstanceOf(SubscriptionLedger);
  });

  it("first owner subscribes tmux; matching second owner only bumps refcount", async () => {
    const runner = createFakeRunner();
    const ledger = new SubscriptionLedger(runner.deps);
    const a = { id: 1 };
    const b = { id: 2 };
    ledger.register(a);
    ledger.register(b);

    await ledger.subscribe(a, "win", "%*", "#{window_name}");
    await ledger.subscribe(b, "win", "%*", "#{window_name}");

    // tmux saw exactly one subscribe — the second is a synthesized refcount bump.
    expect(subscribes(runner.sent)).toHaveLength(1);
  });

  it("last owner triggers unsubscribe; a non-last owner does not", async () => {
    const runner = createFakeRunner();
    const ledger = new SubscriptionLedger(runner.deps);
    const a = { id: 1 };
    const b = { id: 2 };
    ledger.register(a);
    ledger.register(b);
    await ledger.subscribe(a, "win", "%*", "#{window_name}");
    await ledger.subscribe(b, "win", "%*", "#{window_name}");

    await ledger.unsubscribe(a, "win"); // b still owns → no tmux unsubscribe
    expect(unsubscribes(runner.sent)).toHaveLength(0);

    await ledger.unsubscribe(b, "win"); // last owner → tmux unsubscribe
    expect(unsubscribes(runner.sent)).toHaveLength(1);
  });

  it("rejects a conflicting (what, format) for a held name", async () => {
    const runner = createFakeRunner();
    const ledger = new SubscriptionLedger(runner.deps);
    const a = { id: 1 };
    const b = { id: 2 };
    ledger.register(a);
    ledger.register(b);
    await ledger.subscribe(a, "win", "%*", "#{window_name}");

    await expect(
      ledger.subscribe(b, "win", "%*", "#{pane_title}"),
    ).rejects.toMatchObject({ code: "BRIDGE_SUBSCRIPTION_FORMAT_CONFLICT" });
  });

  it("rejects unsubscribe of a name the peer does not own", async () => {
    const runner = createFakeRunner();
    const ledger = new SubscriptionLedger(runner.deps);
    const a = { id: 1 };
    ledger.register(a);

    await expect(ledger.unsubscribe(a, "win")).rejects.toMatchObject({
      code: "BRIDGE_UNKNOWN_SUBSCRIPTION",
    });
  });

  it("rejects operations from an unregistered peer with BRIDGE_INTERNAL", async () => {
    const runner = createFakeRunner();
    const ledger = new SubscriptionLedger(runner.deps);
    const ghost = { id: 99 };

    await expect(
      ledger.subscribe(ghost, "win", "%*", "#{window_name}"),
    ).rejects.toBeInstanceOf(BridgeError);
    await expect(
      ledger.subscribe(ghost, "win", "%*", "#{window_name}"),
    ).rejects.toMatchObject({ code: "BRIDGE_INTERNAL" });
  });

  it("inflight-race: a tmux rejection strands no queued joiner with a phantom", async () => {
    const runner = createFakeRunner();
    const ledger = new SubscriptionLedger(runner.deps);
    const a = { id: 1 };
    const b = { id: 2 };
    ledger.register(a);
    ledger.register(b);

    // First subscribe's execute rejects; the joiner queued on the same inflight
    // promise must see the same rejection — never claim a phantom subscription.
    runner.nextResult = {
      kind: "error",
      err: new TmuxCommandError({
        commandNumber: 0,
        timestamp: 0,
        output: ["no such window"],
        success: false,
      }),
    };
    const first = ledger.subscribe(a, "win", "%*", "#{window_name}");
    const joiner = ledger.subscribe(b, "win", "%*", "#{window_name}");

    await expect(first).rejects.toBeInstanceOf(TmuxCommandError);
    await expect(joiner).rejects.toBeInstanceOf(TmuxCommandError);

    // Record was rolled back: a fresh subscribe now re-issues to tmux.
    runner.nextResult = { kind: "ok" };
    await ledger.subscribe(a, "win", "%*", "#{window_name}");
    expect(subscribes(runner.sent)).toHaveLength(2); // the failed one + the retry
  });

  it("releasePeer decrements refcounts and fires last-owner unsubscribe", async () => {
    const runner = createFakeRunner();
    const ledger = new SubscriptionLedger(runner.deps);
    const a = { id: 1 };
    ledger.register(a);
    await ledger.subscribe(a, "win", "%*", "#{window_name}");

    ledger.releasePeer(a); // sole owner drops → tmux unsubscribe
    // releasePeer's unsubscribe is fire-and-forget; let its microtask settle.
    await Promise.resolve();
    expect(unsubscribes(runner.sent)).toHaveLength(1);
  });
});
