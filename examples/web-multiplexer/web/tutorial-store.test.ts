// examples/web-multiplexer/web/tutorial-store.test.ts
//
// The Protocol Tutorial runs a real MockTmuxServer + TmuxParser in-process. This
// asserts the store captures both halves — the raw wire and the parsed events —
// as a learner steps through a scenario and sends commands. It is the same code
// path the browser tab runs (node env, no DOM), so passing here is the proof the
// library mock + parser are pure and browser-safe.

import { describe, it, expect } from "vitest";
import { TutorialStore } from "./tutorial-store.ts";

describe("TutorialStore drives the in-browser mock + parser", () => {
  it("captures the greeting as wire lines and parsed events on load", () => {
    const store = new TutorialStore(); // defaults to the startup scenario
    expect(store.wire.length).toBeGreaterThan(0);
    expect(store.wire.every((l) => l.dir === "in")).toBe(true);
    const types = store.events.map((e) => e.message.type);
    expect(types).toContain("session-changed");
    expect(types).toContain("window-add");
  });

  it("step() emits the next timeline notification, growing both columns", () => {
    const store = new TutorialStore();
    const before = store.events.length;
    store.step(); // first startup step: %window-add @2
    expect(store.events.length).toBeGreaterThan(before);
    const last = store.events.at(-1)?.message;
    expect(last).toEqual({ type: "window-add", windowId: 2 });
  });

  it("stops stepping at the end of the timeline", () => {
    const store = new TutorialStore();
    const total = store.scenario.steps.length;
    for (let i = 0; i < total; i++) store.step();
    expect(store.atTimelineEnd).toBe(true);
    const frozen = store.events.length;
    store.step(); // no-op past the end
    expect(store.events.length).toBe(frozen);
  });

  it("a sent command frames a %begin/%end block on the wire and in events", () => {
    const store = new TutorialStore();
    // Scope to this command's own guard block: MockTmuxServer's unsolicited
    // startup greeting already contains a %begin/%end pair, so checking the
    // whole event history would pass on the greeting's alone.
    const before = store.events.length;
    store.sendCommand("list-windows -a");

    // The outbound command line is recorded, then the framed reply comes back.
    expect(store.wire.some((l) => l.dir === "out" && l.text === "list-windows -a")).toBe(true);
    const types = store.events.slice(before).map((e) => e.message.type);
    expect(types).toContain("begin");
    expect(types).toContain("end");
  });

  it("a failing command surfaces an %error terminator", () => {
    const store = new TutorialStore();
    store.selectScenario("error");
    // Scope to this command's own guard block: MockTmuxServer's unsolicited
    // startup greeting (replayed by selectScenario) legitimately ends in its
    // own %end, so checking the whole event history would see that %end too.
    const before = store.events.length;
    store.sendCommand("kill-pane -t %99");
    const types = store.events.slice(before).map((e) => e.message.type);
    expect(types).toContain("begin");
    expect(types).toContain("error");
    expect(types).not.toContain("end");
  });

  it("selecting a scenario resets the captured streams", () => {
    const store = new TutorialStore();
    store.sendCommand("list-windows -a");
    expect(store.wire.length).toBeGreaterThan(2);
    store.selectScenario("output");
    // Fresh greeting only — the prior scenario's traffic is gone.
    expect(store.scenarioId).toBe("output");
    expect(store.wire.every((l) => l.dir === "in")).toBe(true);
  });

  it("defaults to a transparent (chaos-off) stream", () => {
    const store = new TutorialStore();
    expect(store.chaosActive).toBe(false);
    expect(store.chaosStats.dropped).toBe(0);
    expect(store.chaosStats.corrupted).toBe(0);
    // Every delivered line is a line the mock genuinely sent.
    expect(store.wire.filter((l) => l.dir === "in").every((l) => l.fate === "clean")).toBe(true);
  });

  it("dropRate 1 drops the whole inbound stream — nothing parses", () => {
    const store = new TutorialStore();
    store.setChaos({ dropRate: 1 });
    expect(store.chaosStats.sent).toBeGreaterThan(0);
    expect(store.chaosStats.delivered).toBe(0);
    expect(store.chaosStats.dropped).toBe(store.chaosStats.sent);
    expect(store.wire.some((l) => l.dir === "in")).toBe(false);
    expect(store.events.length).toBe(0);
  });

  it("corruptRate 1 mangles every delivered line without crashing the parser", () => {
    const store = new TutorialStore();
    store.setChaos({ corruptRate: 1 });
    const inbound = store.wire.filter((l) => l.dir === "in");
    expect(inbound.length).toBeGreaterThan(0);
    expect(store.chaosStats.corrupted).toBe(store.chaosStats.delivered);
    expect(inbound.every((l) => l.fate === "corrupted")).toBe(true);
  });

  it("is reproducible: same seed + dials replay the same chaotic run", () => {
    const a = new TutorialStore();
    const b = new TutorialStore();
    a.setChaos({ dropRate: 0.5, corruptRate: 0.3, seed: 777 });
    b.setChaos({ dropRate: 0.5, corruptRate: 0.3, seed: 777 });
    expect(a.chaosStats).toEqual(b.chaosStats);
    // Guard timestamps use a real wall clock (tutorial-store.ts's deliberate
    // choice, for browser authenticity) — normalize them out before
    // comparing, or two instances constructed a second apart would fail this
    // on timestamp drift alone rather than on an actual reproducibility bug.
    const stripTimestamp = (text: string) =>
      text.replace(/^%(begin|end|error) \d+/, "%$1 T");
    expect(a.wire.map((l) => stripTimestamp(l.text))).toEqual(
      b.wire.map((l) => stripTimestamp(l.text)),
    );
  });
});
