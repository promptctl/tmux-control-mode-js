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
    store.sendCommand("list-windows -a");

    // The outbound command line is recorded, then the framed reply comes back.
    expect(store.wire.some((l) => l.dir === "out" && l.text === "list-windows -a")).toBe(true);
    const types = store.events.map((e) => e.message.type);
    expect(types).toContain("begin");
    expect(types).toContain("end");
  });

  it("a failing command surfaces an %error terminator", () => {
    const store = new TutorialStore();
    store.selectScenario("error");
    store.sendCommand("kill-pane -t %99");
    const types = store.events.map((e) => e.message.type);
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
});
