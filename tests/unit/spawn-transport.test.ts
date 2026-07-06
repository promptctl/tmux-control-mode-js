// tests/unit/spawn-transport.test.ts
// Behavior-level tests for the spawn transport's lifecycle seam — the
// regression gate for tmux-lifecycle-zng.1. No tmux required: spawnTmux takes
// `tmuxPath`, so these tests spawn `sh` (the `-C` control flag it prepends is
// sh's harmless noclobber option) to script child death deterministically.
//
// The three contract clauses under test:
//   (a) send on a dead transport is loud — a typed refusal, not a silent void
//   (b) a write in the EPIPE window (child dead, `close` not yet dispatched)
//       cannot crash the host process
//   (c) closeCallbacks fire exactly once, with the true reason — a transport
//       error is never re-reported as a clean exit

import { spawnTmux } from "../../src/transport/spawn.js";
import type { TmuxTransport } from "../../src/transport/types.js";

function shTransport(script: string): TmuxTransport {
  return spawnTmux(["-c", script], { tmuxPath: "sh" });
}

function collectCloses(transport: TmuxTransport): (string | undefined)[] {
  const reasons: (string | undefined)[] = [];
  transport.onClose((reason) => reasons.push(reason));
  return reasons;
}

async function until(
  condition: () => boolean,
  what: string,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 25));

describe("spawnTmux lifecycle seam", () => {
  it("(c) dispatches close exactly once with the exit reason on child exit", async () => {
    const transport = shTransport("exit 3");
    const reasons = collectCloses(transport);

    await until(() => reasons.length > 0, "close dispatch");
    await tick(); // window for any duplicate dispatch to (wrongly) land
    expect(reasons).toEqual(["exit 3"]);
  });

  it("(c) reports a clean exit as an undefined reason, once", async () => {
    const transport = shTransport("exit 0");
    const reasons = collectCloses(transport);

    await until(() => reasons.length > 0, "close dispatch");
    await tick();
    expect(reasons).toEqual([undefined]);
  });

  it("(c) spawn failure dispatches once with the error, never re-reported as exit", async () => {
    const transport = spawnTmux([], {
      tmuxPath: "/nonexistent/definitely-not-tmux",
    });
    const reasons = collectCloses(transport);

    await until(() => reasons.length > 0, "error dispatch");
    // Node emits `close` after `error` for a failed spawn — the old code
    // dispatched both, downgrading the ENOENT to a clean exit. Give that
    // second event time to land and assert it was suppressed.
    await tick();
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatch(/ENOENT/);
  });

  it("(a) send after close refuses with the death reason", async () => {
    const transport = shTransport("exit 3");
    const reasons = collectCloses(transport);
    await until(() => reasons.length > 0, "close dispatch");

    const result = transport.send("list-windows");
    expect(result).toEqual({
      ok: false,
      reason: "transport closed: exit 3",
    });
  });

  it("(b) an EPIPE-window write does not crash the process and turns sends loud", async () => {
    // The child closes its stdin (the pipe's read end) but stays alive, so the
    // transport's `close` has NOT fired — writes land squarely in the window
    // where the old code let stdin emit an unlistened `error` and kill the host.
    // `exec sleep` replaces sh, so transport.close() kills the pipe-holding
    // process itself and the child's `close` event fires promptly.
    const transport = shTransport("exec 0<&-; echo ready; exec sleep 5");
    let sawReady = false;
    transport.onData((chunk) => {
      sawReady = sawReady || chunk.includes("ready");
    });
    const reasons = collectCloses(transport);

    await until(() => sawReady, "child to close its stdin");
    expect(reasons).toHaveLength(0);

    // Accepted for transmission — the transport cannot yet know the pipe is
    // dead. The EPIPE arrives asynchronously; surviving it IS the assertion.
    expect(transport.send("list-windows")).toEqual({ ok: true });

    await until(() => !transport.send("list-windows").ok, "EPIPE to surface");
    const refused = transport.send("list-windows");
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toMatch(/EPIPE/);
    // The child never exited — the loud refusal came from the stdin failure,
    // not from a close dispatch.
    expect(reasons).toHaveLength(0);

    transport.close();
    await until(() => reasons.length > 0, "close after kill");
  });

  it("send on a live transport is accepted", async () => {
    const transport = shTransport("exec cat >/dev/null");
    expect(transport.send("list-windows")).toEqual({ ok: true });
    transport.close();
  });
});
