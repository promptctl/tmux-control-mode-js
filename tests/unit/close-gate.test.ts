// tests/unit/close-gate.test.ts
//
// Direct contract tests for the shared lifecycle primitive that spawn.ts,
// connectors/websocket/transport.ts, and mock/server.ts all derive their
// end-of-life state from.

import { describe, it, expect } from "vitest";

import { createCloseGate } from "../../src/transport/close-gate.js";

describe("createCloseGate", () => {
  it("starts open, admitting sends", () => {
    const gate = createCloseGate();
    expect(gate.state()).toEqual({ phase: "open" });
    expect(gate.admit()).toEqual({ ok: true });
  });

  it("dispatch closes the gate with the given reason", () => {
    const gate = createCloseGate();
    gate.dispatch("boom");
    expect(gate.state()).toEqual({ phase: "closed", reason: "boom" });
  });

  it("dispatch is exactly-once — a later dispatch cannot change the reason", () => {
    const gate = createCloseGate();
    gate.dispatch("first");
    gate.dispatch("second");
    expect(gate.state()).toEqual({ phase: "closed", reason: "first" });
  });

  it("onClose registered before dispatch fires with the dispatched reason", () => {
    const gate = createCloseGate();
    const reasons: (string | undefined)[] = [];
    gate.onClose((r) => reasons.push(r));
    gate.dispatch("gone");
    expect(reasons).toEqual(["gone"]);
  });

  it("onClose registered after the gate already closed fires immediately instead of being silently dropped", () => {
    const gate = createCloseGate();
    gate.dispatch("already gone");
    const reasons: (string | undefined)[] = [];
    gate.onClose((r) => reasons.push(r));
    expect(reasons).toEqual(["already gone"]);
  });

  it("a listener that registers another onClose synchronously during dispatch does not orphan it", () => {
    const gate = createCloseGate();
    const reasons: (string | undefined)[] = [];
    gate.onClose((r) => {
      reasons.push(r);
      // Registering mid-dispatch: the state is already closed by the time
      // dispatch's forEach runs, so this fires immediately rather than
      // being pushed into an array that will never be iterated again.
      gate.onClose((r2) => reasons.push(r2));
    });
    gate.dispatch("late");
    expect(reasons).toEqual(["late", "late"]);
  });

  it("admit refuses with the bare string after a clean dispatch", () => {
    const gate = createCloseGate();
    gate.dispatch(undefined);
    expect(gate.admit()).toEqual({ ok: false, reason: "transport closed" });
  });

  it("admit suffixes the dispatched reason when one is given", () => {
    const gate = createCloseGate();
    gate.dispatch("exit 1");
    expect(gate.admit()).toEqual({
      ok: false,
      reason: "transport closed: exit 1",
    });
  });

  it("lose refuses every later send, fires onLost once with the first reason, and close still follows", () => {
    const gate = createCloseGate();
    const lost: string[] = [];
    const closed: (string | undefined)[] = [];
    gate.onLost((r) => lost.push(r));
    gate.onClose((r) => closed.push(r));
    gate.lose("stdin failed: EPIPE");
    gate.lose("stdin failed: ECONNRESET");
    expect(gate.state()).toEqual({
      phase: "lost",
      reason: "stdin failed: EPIPE",
    });
    expect(gate.admit()).toEqual({
      ok: false,
      reason: "transport lost: stdin failed: EPIPE",
    });
    gate.dispatch("exit 1");
    expect(lost).toEqual(["stdin failed: EPIPE"]);
    expect(closed).toEqual(["exit 1"]);
    expect(gate.admit()).toEqual({
      ok: false,
      reason: "transport closed: exit 1",
    });
  });

  it("onLost registered while lost fires immediately; registered once closed it never fires", () => {
    const gate = createCloseGate();
    gate.lose("gone");
    const whileLost: string[] = [];
    gate.onLost((r) => whileLost.push(r));
    expect(whileLost).toEqual(["gone"]);

    gate.dispatch(undefined);
    const afterClose: string[] = [];
    gate.onLost((r) => afterClose.push(r));
    expect(afterClose).toEqual([]);
  });

  it("lose after close changes nothing: a closed gate is past loss", () => {
    const gate = createCloseGate();
    const lost: string[] = [];
    gate.onLost((r) => lost.push(r));
    gate.dispatch(undefined);
    gate.lose("late pipe error");
    expect(gate.state()).toEqual({ phase: "closed", reason: undefined });
    expect(lost).toEqual([]);
  });
});
