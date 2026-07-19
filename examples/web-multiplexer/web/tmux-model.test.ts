// examples/web-multiplexer/web/tmux-model.test.ts
//
// Isolation tests for TmuxModel's optimistic-select token protocol — the
// identity guard that keeps a stale rejection from clobbering a newer switch,
// and the teardown boundary that invalidates in-flight selects on a socket
// swap. No client, no async: the protocol is exercised directly. [LAW:behavior-not-structure]

import { describe, it, expect } from "vitest";
import { TmuxModel } from "./tmux-model.ts";

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
