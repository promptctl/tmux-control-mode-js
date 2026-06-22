// tests/unit/pane-interest-tracker.test.ts
// Unit tests for PaneInterestTracker — the pure derivation of per-pane interest
// from scope attachments + topology. This is the load-bearing correctness of
// idle-pane suppression: the scope-correct admitting-attachment count and its
// transitions under both attach/dispose and topology moves.
//
// [LAW:behavior-not-structure] Tests assert WHICH transitions fire for a given
//   attachment + topology state, never how the tracker stores its interest map.

import { describe, expect, it } from "vitest";

import {
  SinkRegistry,
  PaneTopologyManager,
  PaneInterestTracker,
  serverScope,
  sessionScope,
  windowScope,
  paneScope,
  type BytesSink,
  type PaneScope,
} from "../../src/pane-output.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const sink: BytesSink = { write: () => undefined, end: () => undefined };

interface Recorder {
  readonly events: Array<{ kind: "interesting" | "idle"; paneId: number }>;
  onPaneBecameInteresting(paneId: number): void;
  onPaneBecameIdle(paneId: number): void;
}

function recorder(): Recorder {
  const events: Recorder["events"] = [];
  return {
    events,
    onPaneBecameInteresting: (paneId) => events.push({ kind: "interesting", paneId }),
    onPaneBecameIdle: (paneId) => events.push({ kind: "idle", paneId }),
  };
}

function setup() {
  const registry = new SinkRegistry();
  const topology = new PaneTopologyManager();
  const rec = recorder();
  const tracker = new PaneInterestTracker(registry, topology, rec);
  // attach returns the disposer; tests recompute manually like the router does.
  const attach = (scope: PaneScope) => registry.attach(sink, scope);
  return { registry, topology, tracker, rec, attach };
}

// A pane → {windowId, sessionId} entry for seeding.
function pane(paneId: number, windowId: number, sessionId: number) {
  return { paneId, windowId, sessionId };
}

// ---------------------------------------------------------------------------
// Join pulse — a pane entering the universe fires once, by its current interest
// ---------------------------------------------------------------------------

describe("PaneInterestTracker — join pulse", () => {
  it("fires idle when a pane enters topology with no admitting attachment", () => {
    const { topology, tracker, rec } = setup();
    topology.seed([pane(1, 10, 100)]);
    tracker.recompute();
    expect(rec.events).toEqual([{ kind: "idle", paneId: 1 }]);
  });

  it("fires interesting when a pane enters topology already admitted (server scope)", () => {
    const { topology, tracker, rec, attach } = setup();
    attach(serverScope);
    topology.seed([pane(1, 10, 100), pane(2, 20, 200)]);
    tracker.recompute();
    expect(rec.events).toEqual([
      { kind: "interesting", paneId: 1 },
      { kind: "interesting", paneId: 2 },
    ]);
  });

  it("tracks a pane-scoped pane the topology has never seen", () => {
    const { tracker, rec, attach } = setup();
    attach(paneScope(5));
    tracker.recompute();
    expect(rec.events).toEqual([{ kind: "interesting", paneId: 5 }]);
  });
});

// ---------------------------------------------------------------------------
// Scope-correct admit counting
// ---------------------------------------------------------------------------

describe("PaneInterestTracker — scope-correct counting", () => {
  it("session scope admits only panes in that session", () => {
    const { topology, tracker, rec, attach } = setup();
    topology.seed([pane(1, 10, 100), pane(2, 20, 200)]);
    attach(sessionScope(100));
    tracker.recompute();
    expect(rec.events).toEqual([
      { kind: "interesting", paneId: 1 },
      { kind: "idle", paneId: 2 },
    ]);
  });

  it("window scope admits only panes in that window", () => {
    const { topology, tracker, rec, attach } = setup();
    topology.seed([pane(1, 10, 100), pane(2, 20, 100)]);
    attach(windowScope(10));
    tracker.recompute();
    expect(rec.events).toEqual([
      { kind: "interesting", paneId: 1 },
      { kind: "idle", paneId: 2 },
    ]);
  });

  it("server scope makes every pane interesting, including future ones", () => {
    const { topology, tracker, rec, attach } = setup();
    attach(serverScope);
    topology.seed([pane(1, 10, 100)]);
    tracker.recompute();
    // A second pane appears later — server scope admits it on its join.
    topology.seed([pane(1, 10, 100), pane(2, 20, 200)]);
    tracker.recompute();
    expect(rec.events).toEqual([
      { kind: "interesting", paneId: 1 },
      { kind: "interesting", paneId: 2 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Transitions — attach/dispose and topology moves flip interest
// ---------------------------------------------------------------------------

describe("PaneInterestTracker — transitions", () => {
  it("attach then dispose flips a pane idle → interesting → idle", () => {
    const { topology, tracker, rec, attach } = setup();
    topology.seed([pane(1, 10, 100)]);
    tracker.recompute(); // idle join
    const dispose = attach(paneScope(1));
    tracker.recompute(); // interesting
    dispose();
    tracker.recompute(); // idle again
    expect(rec.events).toEqual([
      { kind: "idle", paneId: 1 },
      { kind: "interesting", paneId: 1 },
      { kind: "idle", paneId: 1 },
    ]);
  });

  it("a pane moving out of an admitting session flips interesting → idle", () => {
    const { topology, tracker, rec, attach } = setup();
    topology.seed([pane(1, 10, 100)]);
    attach(sessionScope(100));
    tracker.recompute(); // interesting (in session 100)
    // The pane moves to session 200 (a new window/session), no longer admitted.
    topology.seed([pane(1, 20, 200)]);
    tracker.recompute();
    expect(rec.events).toEqual([
      { kind: "interesting", paneId: 1 },
      { kind: "idle", paneId: 1 },
    ]);
  });

  it("a pane moving into an admitting session flips idle → interesting", () => {
    const { topology, tracker, rec, attach } = setup();
    topology.seed([pane(1, 20, 200)]);
    attach(sessionScope(100));
    tracker.recompute(); // idle (in session 200)
    topology.seed([pane(1, 10, 100)]);
    tracker.recompute(); // moved into session 100
    expect(rec.events).toEqual([
      { kind: "idle", paneId: 1 },
      { kind: "interesting", paneId: 1 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Silence — no spurious or duplicate fires
// ---------------------------------------------------------------------------

describe("PaneInterestTracker — silence", () => {
  it("a pane leaving the universe (window closed) fires nothing", () => {
    const { topology, tracker, rec } = setup();
    topology.seed([pane(1, 10, 100)]);
    tracker.recompute(); // idle join
    topology.removeWindow(10);
    tracker.recompute();
    // Only the original idle join — leaving the universe is silent.
    expect(rec.events).toEqual([{ kind: "idle", paneId: 1 }]);
  });

  it("recomputing with no state change fires nothing the second time", () => {
    const { topology, tracker, rec, attach } = setup();
    attach(serverScope);
    topology.seed([pane(1, 10, 100)]);
    tracker.recompute();
    const afterFirst = rec.events.length;
    tracker.recompute();
    tracker.recompute();
    expect(rec.events.length).toBe(afterFirst);
  });
});
