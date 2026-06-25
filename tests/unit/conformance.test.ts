// tests/unit/conformance.test.ts
// The deterministic conformance suite IS the gate: every documented notification,
// both pane-output variants, and the command-correlation contract, run against an
// in-process mock that speaks the real wire. A green run is a real statement about
// the shipped TmuxClient — only the tmux process is substituted.
//
// [LAW:behavior-not-structure] These assert the meaning ("the suite passes", "it
// covers every documented variant", "a wrong observation goes red"), not the
// internal shape of any check.

import { describe, it, expect } from "vitest";
import {
  buildConformanceChecks,
  MESSAGE_SAMPLES,
  CHANNEL_OF,
} from "../../src/conformance/index.js";
import type { ObservationChannel } from "../../src/conformance/index.js";
import { TmuxClient } from "../../src/client.js";
import { MockTmuxServer } from "../../src/mock/server.js";
import { serializeMessage } from "../../src/protocol/serializer.js";
import type { TmuxMessage } from "../../src/protocol/types.js";

const checks = buildConformanceChecks();

// Run the whole catalogue once; every later assertion reads from this.
const outcomes = await Promise.all(
  checks.map(async (c) => ({ check: c, outcome: await c.run() })),
);

describe("conformance suite — the demo IS the gate", () => {
  it("every check passes against the real TmuxClient", () => {
    const failures = outcomes
      .filter(({ outcome }) => outcome.status === "fail")
      .map(({ check, outcome }) => `${check.id}: ${outcome.detail}`);
    expect(failures).toEqual([]);
  });

  // Per-check rows so a single regression names itself instead of failing the
  // whole batch anonymously. [LAW:verifiable-goals]
  for (const { check, outcome } of outcomes) {
    it(`${check.id} (${check.spec}) conforms`, () => {
      expect(outcome.status, outcome.detail).toBe("pass");
    });
  }
});

describe("coverage is driven by the channel partition (single source)", () => {
  // The variants the deterministic loop turns into per-sample checks: everything
  // except the command-guard frames (begin/end/error), which are certified by the
  // command-correlation checks instead.
  const perSampleVariants = (Object.keys(MESSAGE_SAMPLES) as TmuxMessage["type"][])
    .filter((t) => CHANNEL_OF[t] !== "command")
    .sort();

  const perSampleCheckVariants = checks
    .filter((c) => c.channel !== "command")
    .map((c) => c.id.slice(c.id.indexOf(":") + 1))
    .sort();

  it("has exactly one check per non-command variant — no variant unexercised", () => {
    expect(perSampleCheckVariants).toEqual(perSampleVariants);
  });

  it("partitions checks across all three observation channels", () => {
    const byChannel = (ch: ObservationChannel) =>
      checks.filter((c) => c.channel === ch).length;
    // 28 documented variants − 3 guard frames = 25 per-sample checks
    // (23 notification + 2 pane-output), plus 3 command-correlation checks.
    expect(byChannel("notification")).toBe(23);
    expect(byChannel("pane-output")).toBe(2);
    expect(byChannel("command")).toBe(3);
    expect(checks.length).toBe(28);
  });

  it("accounts for all 28 documented SPEC §23 message variants", () => {
    expect(Object.keys(MESSAGE_SAMPLES).length).toBe(28);
  });
});

describe("green/red is contingent — the oracle is not vacuous", () => {
  // Drive the same public pieces a notification check uses, then prove the
  // wire-form oracle SEPARATES a conforming observation from a non-conforming
  // one: a regression that surfaced a wrong field value would compare unequal and
  // turn the row red, rather than silently passing. [LAW:no-silent-failure]
  it("a wrong surfaced value would not compare equal", () => {
    const server = new MockTmuxServer();
    const client = new TmuxClient(server);
    let captured: TmuxMessage | undefined;
    client.on("window-add", (ev) => {
      captured ??= ev;
    });
    server.emit({ type: "window-add", windowId: 2 });

    expect(captured).toBeDefined();
    const observed = serializeMessage(captured as TmuxMessage);
    expect(observed).toBe(serializeMessage({ type: "window-add", windowId: 2 }));
    expect(observed).not.toBe(
      serializeMessage({ type: "window-add", windowId: 99 }),
    );
  });
});
