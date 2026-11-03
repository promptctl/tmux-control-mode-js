// examples/web-multiplexer/web/tmux-model.test.ts
//
// Isolation tests for TmuxModel's optimistic-select token protocol — the
// identity guard that keeps a stale rejection from clobbering a newer switch,
// and the teardown boundary that invalidates in-flight selects on a socket
// swap. No client, no async: the protocol is exercised directly. [LAW:behavior-not-structure]

import { describe, it, expect } from "vitest";
import { TmuxModel } from "./tmux-model.ts";
import { encodeSnapshotLines } from "./snapshot-codec.ts";

// Stage a fully-loaded single-session model: session $1 "dev" attached, with
// window @10 (index 0) holding panes %100 (index 0) and %101 (index 1).
function loadedModel(): TmuxModel {
  const m = new TmuxModel();
  m.applySnapshot("sessions", "$1|dev|1");
  m.applySnapshot("windows", "$1|@10|0|main|1|0");
  m.applySnapshot(
    "panes",
    encodeSnapshotLines(["@10|%100|0|1|80|24|a", "@10|%101|1|0|80|24|b"]),
  );
  return m;
}

describe("TmuxModel select-token protocol", () => {
  it("a revert with the current token nulls the optimistic pointer", () => {
    const m = new TmuxModel();
    const token = m.beginSelect(5);
    expect(m.clientSessionId).toBe(5);
    m.revertSelectIfCurrent(token);
    expect(m.clientSessionId).toBeNull();
  });

  it("a revert with a superseded token is a no-op (newer select wins)", () => {
    const m = new TmuxModel();
    const stale = m.beginSelect(5);
    const fresh = m.beginSelect(7);
    m.revertSelectIfCurrent(stale);
    expect(m.clientSessionId).toBe(7);
    expect(m.isCurrentSelect(fresh)).toBe(true);
    expect(m.isCurrentSelect(stale)).toBe(false);
  });

  it("clearTopology invalidates an in-flight select so a stale revert can't clobber a later authoritative pointer", () => {
    const m = new TmuxModel();
    // Old connection begins an optimistic switch.
    const oldToken = m.beginSelect(5);
    // Socket swap tears the model down.
    m.clearTopology();
    expect(m.clientSessionId).toBeNull();
    // New connection bootstraps its authoritative attached session.
    m.setClientSession(9);
    // The old connection's in-flight switch now rejects — its revert must be a
    // no-op, leaving the new connection's pointer intact.
    m.revertSelectIfCurrent(oldToken);
    expect(m.clientSessionId).toBe(9);
  });
});

describe("TmuxModel.applySnapshot", () => {
  it("stays empty until all three subscriptions have arrived", () => {
    const m = new TmuxModel();
    m.applySnapshot("sessions", "$1|dev|1");
    expect(m.sessions).toEqual([]);
    m.applySnapshot("windows", "$1|@10|0|main|1|0");
    expect(m.sessions).toEqual([]);
    m.applySnapshot("panes", "@10|%100|0|1|80|24|a");
    expect(m.sessions).toHaveLength(1);
    expect(m.sessions[0].windows[0].panes).toHaveLength(1);
  });

  it("ignores an unknown subscription name without rebuilding", () => {
    const m = loadedModel();
    const before = m.sessions;
    m.applySnapshot("bogus", "whatever");
    expect(m.sessions).toBe(before); // same reference — no rebuild happened
  });

  it("routes each name to its own snapshot slot", () => {
    const m = loadedModel();
    // Replacing just the panes snapshot re-titles the panes, leaving the
    // session/window structure intact.
    m.applySnapshot("panes", "@10|%100|0|1|80|24|renamed");
    expect(m.sessions[0].windows[0].panes.map((p) => p.title)).toEqual([
      "renamed",
    ]);
  });
});

describe("TmuxModel.mergeSession", () => {
  it("replaces one session's window/pane rows without dropping other sessions", () => {
    const m = new TmuxModel();
    m.applySnapshot("sessions", encodeSnapshotLines(["$1|a|1", "$2|b|1"]));
    m.applySnapshot(
      "windows",
      encodeSnapshotLines(["$1|@10|0|w1|1|0", "$2|@20|0|w2|1|0"]),
    );
    m.applySnapshot(
      "panes",
      encodeSnapshotLines(["@10|%100|0|1|80|24|p1", "@20|%200|0|1|80|24|p2"]),
    );

    m.mergeSession(1, ["$1|@10|0|w1-renamed|1|0"], ["@10|%100|0|1|80|24|p1b"]);

    const byId = Object.fromEntries(m.sessions.map((s) => [s.id, s]));
    expect(byId[1].windows[0].name).toBe("w1-renamed");
    expect(byId[1].windows[0].panes[0].title).toBe("p1b");
    // Session 2 is untouched.
    expect(byId[2].windows[0].name).toBe("w2");
    expect(byId[2].windows[0].panes[0].title).toBe("p2");
  });

  it("is a no-op before any snapshot has loaded", () => {
    const m = new TmuxModel();
    m.mergeSession(1, ["$1|@10|0|w|1|0"], ["@10|%100|0|1|80|24|p"]);
    expect(m.sessions).toEqual([]);
  });

  it("empty windowRows removes the session's windows; orphaned pane rows are ignored by the rebuild", () => {
    const m = loadedModel(); // session $1 with window @10 and two panes
    // Merge with NO fresh windows for session 1: mergeSessionRows strips $1's
    // window rows, leaving the pane rows for @10 orphaned (no window to attach
    // to). buildSessionTree silently drops orphans, so the session ends up with
    // no windows and the tree stays well-formed.
    m.mergeSession(1, [], []);
    expect(m.sessions).toHaveLength(1);
    expect(m.sessions[0].windows).toEqual([]);
  });
});

describe("TmuxModel.applyPaneDimensions", () => {
  it("updates only the targeted pane and produces a new tree reference", () => {
    const m = loadedModel();
    const before = m.sessions;
    m.applyPaneDimensions(new Map([[100, { w: 200, h: 50 }]]));
    expect(m.sessions).not.toBe(before); // immutable rebuild
    const panes = m.sessions[0].windows[0].panes;
    expect(panes[0]).toMatchObject({ id: 100, width: 200, height: 50 });
    expect(panes[1]).toMatchObject({ id: 101, width: 80, height: 24 });
  });

  it("is a no-op for an empty update map (same tree reference)", () => {
    const m = loadedModel();
    const before = m.sessions;
    m.applyPaneDimensions(new Map());
    expect(m.sessions).toBe(before);
  });
});

describe("TmuxModel.activeSessionId priority chain", () => {
  it("prefers a clientSession that exists in the tree", () => {
    const m = new TmuxModel();
    m.applySnapshot("sessions", encodeSnapshotLines(["$1|a|0", "$2|b|1"]));
    m.applySnapshot("windows", "");
    m.applySnapshot("panes", "");
    m.setClientSession(1);
    expect(m.activeSessionId).toBe(1);
  });

  it("falls back to the attached session when clientSession is absent from the tree", () => {
    const m = new TmuxModel();
    m.applySnapshot("sessions", encodeSnapshotLines(["$1|a|0", "$2|b|1"]));
    m.applySnapshot("windows", "");
    m.applySnapshot("panes", "");
    m.setClientSession(99); // not in the tree
    expect(m.activeSessionId).toBe(2); // $2 is attached
  });

  it("falls back to the first session when none is attached and no client is set", () => {
    const m = new TmuxModel();
    m.applySnapshot("sessions", encodeSnapshotLines(["$5|a|0", "$6|b|0"]));
    m.applySnapshot("windows", "");
    m.applySnapshot("panes", "");
    expect(m.activeSessionId).toBe(5);
  });

  it("is null when there are no sessions", () => {
    const m = new TmuxModel();
    m.applySnapshot("sessions", "");
    m.applySnapshot("windows", "");
    m.applySnapshot("panes", "");
    expect(m.activeSessionId).toBeNull();
  });
});
