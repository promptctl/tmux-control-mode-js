// tests/unit/idle-pane-suppressor.test.ts
// Unit tests for IdlePaneSuppressor (transition → action) and its wiring inside
// TopologyRouter (recompute triggers → pause/continue on the wire).
//
// [LAW:behavior-not-structure] Tests assert the tmux actions emitted for a given
//   sequence of interest transitions / attachments — never internal bookkeeping.

import { describe, expect, it } from "vitest";

import { IdlePaneSuppressor } from "../../src/idle-pane-suppressor.js";
import { TopologyRouter } from "../../src/topology-router.js";
import { PaneAction } from "../../src/protocol/types.js";
import type { CommandResponse } from "../../src/protocol/types.js";
import { paneScope, type BytesSink } from "../../src/pane-output.js";

const sink: BytesSink = { write: () => undefined, end: () => undefined };

// ---------------------------------------------------------------------------
// IdlePaneSuppressor — pure transition → action
// ---------------------------------------------------------------------------

describe("IdlePaneSuppressor", () => {
  function setup() {
    const actions: Array<{ paneId: number; action: PaneAction }> = [];
    const suppressor = new IdlePaneSuppressor((paneId, action) =>
      actions.push({ paneId, action }),
    );
    return { actions, suppressor };
  }

  it("pauses on idle and continues on interesting", () => {
    const { actions, suppressor } = setup();
    suppressor.onPaneBecameIdle(1);
    suppressor.onPaneBecameInteresting(1);
    expect(actions).toEqual([
      { paneId: 1, action: PaneAction.Pause },
      { paneId: 1, action: PaneAction.Continue },
    ]);
  });

  it("dispose continues every pane it had paused, then is idempotent", () => {
    const { actions, suppressor } = setup();
    suppressor.onPaneBecameIdle(1);
    suppressor.onPaneBecameIdle(2);
    actions.length = 0; // ignore the pauses; focus on dispose
    suppressor.dispose();
    expect(actions).toEqual([
      { paneId: 1, action: PaneAction.Continue },
      { paneId: 2, action: PaneAction.Continue },
    ]);
    actions.length = 0;
    suppressor.dispose();
    expect(actions).toEqual([]);
  });

  it("dispose does not continue a pane that was paused then re-continued", () => {
    const { actions, suppressor } = setup();
    suppressor.onPaneBecameIdle(1);
    suppressor.onPaneBecameInteresting(1); // no longer paused
    actions.length = 0;
    suppressor.dispose();
    expect(actions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// TopologyRouter wiring — recompute triggers produce pause/continue commands
// ---------------------------------------------------------------------------

describe("TopologyRouter — idle suppression wiring", () => {
  // A runCommand that records every command and answers list-panes with `panes`.
  function runner(panes: string[]) {
    const commands: string[] = [];
    const run = (cmd: string): Promise<CommandResponse> => {
      commands.push(cmd);
      const output = cmd.includes("list-panes") ? panes : [];
      return Promise.resolve({
        commandNumber: 1,
        timestamp: 0,
        output,
        success: true,
      });
    };
    return { commands, run };
  }

  const paused = (commands: string[], paneId: number) =>
    commands.some((c) => c.includes(`%${paneId}:${PaneAction.Pause}`));
  const continued = (commands: string[], paneId: number) =>
    commands.some((c) => c.includes(`%${paneId}:${PaneAction.Continue}`));

  it("bootstraps topology and pauses idle panes when no sink is attached", async () => {
    const router = new TopologyRouter({ idlePaneSuppression: true });
    const { commands, run } = runner(["%1 @10 $100"]);
    router.onTransportReady(run);
    await Promise.resolve();
    await Promise.resolve();
    expect(commands.some((c) => c.includes("list-panes"))).toBe(true);
    expect(paused(commands, 1)).toBe(true);
  });

  it("does NOT bootstrap or pause when suppression is off (default)", async () => {
    const router = new TopologyRouter();
    const { commands, run } = runner(["%1 @10 $100"]);
    router.onTransportReady(run);
    await Promise.resolve();
    await Promise.resolve();
    expect(commands).toHaveLength(0);
  });

  it("continues a pane when a sink attaches to it, pauses again on detach", async () => {
    const router = new TopologyRouter({ idlePaneSuppression: true });
    const { commands, run } = runner(["%1 @10 $100"]);
    router.onTransportReady(run);
    await Promise.resolve();
    await Promise.resolve();
    expect(paused(commands, 1)).toBe(true);

    commands.length = 0;
    const dispose = router.attachBytesSink(sink, { scope: paneScope(1) });
    expect(continued(commands, 1)).toBe(true);

    commands.length = 0;
    dispose();
    expect(paused(commands, 1)).toBe(true);
  });
});
