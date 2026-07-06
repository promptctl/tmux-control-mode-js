// tests/unit/close-gate.test.ts
//
// Direct contract tests for the shared close-lifecycle primitive that
// spawn.ts, connectors/websocket/transport.ts, and mock/server.ts all derive
// their end-of-life state from.

import { describe, it, expect } from "vitest";

import { createCloseGate } from "../../src/transport/close-gate.js";

describe("createCloseGate", () => {
  it("starts open", () => {
    const gate = createCloseGate();
    expect(gate.state()).toEqual({ closed: false });
  });

  it("dispatch closes the gate with the given reason", () => {
    const gate = createCloseGate();
    gate.dispatch("boom");
    expect(gate.state()).toEqual({ closed: true, reason: "boom" });
  });

  it("dispatch is exactly-once — a later dispatch cannot change the reason", () => {
    const gate = createCloseGate();
    gate.dispatch("first");
    gate.dispatch("second");
    expect(gate.state()).toEqual({ closed: true, reason: "first" });
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
      // Registering mid-dispatch: state.closed is already true by the time
      // dispatch's forEach runs, so this fires immediately rather than
      // being pushed into an array that will never be iterated again.
      gate.onClose((r2) => reasons.push(r2));
    });
    gate.dispatch("late");
    expect(reasons).toEqual(["late", "late"]);
  });

  it("deniedSendReason throws on an open gate instead of silently claiming closed", () => {
    const gate = createCloseGate();
    expect(() => gate.deniedSendReason()).toThrow(/not closed/);
  });

  it("deniedSendReason is the bare string after a clean dispatch", () => {
    const gate = createCloseGate();
    gate.dispatch(undefined);
    expect(gate.deniedSendReason()).toBe("transport closed");
  });

  it("deniedSendReason suffixes the dispatched reason when one is given", () => {
    const gate = createCloseGate();
    gate.dispatch("exit 1");
    expect(gate.deniedSendReason()).toBe("transport closed: exit 1");
  });
});
