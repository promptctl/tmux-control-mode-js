// examples/web-multiplexer/web/broadcast-store.test.ts
//
// Regression coverage for tmux-optimistic-ui-7ue: BroadcastStore.send() used
// to compute `lastSend` optimistically, before any sendKeys() call resolved —
// a rejected send (bridge closed mid-broadcast, or one pane failing) left the
// stats reporting bytes/panes that never actually reached tmux. These tests
// assert the fix: `lastSend` is derived from Promise.allSettled's outcomes,
// per-pane, guarded by a monotonic token so a slow/older send() can't clobber
// a newer one's summary.

import { describe, it, expect } from "vitest";
import type { CommandResponse } from "@promptctl/tmux-control-mode-js/protocol";
import { BroadcastStore } from "./broadcast-store.ts";
import { DemoStore, type SessionInfo } from "./store.ts";
import type { TmuxBridge } from "./bridge.ts";
import { deferred, tick, type Deferred } from "./test-utils.ts";

const OK: CommandResponse = {
  commandNumber: 0,
  timestamp: 0,
  output: [],
  success: true,
};

interface SendCall {
  readonly target: string;
  readonly keys: string;
  readonly d: Deferred<CommandResponse>;
}

/** A TmuxBridge double whose sendKeys() is controllable per-call. */
function fakeBridge(): { bridge: TmuxBridge; calls: SendCall[] } {
  const calls: SendCall[] = [];
  const noop = (): void => {};
  const noopUnsub = (): (() => void) => noop;
  return {
    bridge: {
      execute: () => Promise.resolve(OK),
      sendKeys: (target: string, keys: string) => {
        const d = deferred<CommandResponse>();
        calls.push({ target, keys, d });
        return d.promise;
      },
      detach: noop,
      connect: noop,
      disconnect: noop,
      onEvent: noopUnsub,
      onError: noopUnsub,
      onState: noopUnsub,
      onWire: noopUnsub,
      startFirehose: noop,
      stopFirehose: noop,
      onFirehose: noopUnsub,
    },
    calls,
  };
}

function demoWithPanes(): DemoStore {
  const demo = new DemoStore(fakeBridge().bridge);
  const sessions: SessionInfo[] = [
    {
      id: 1,
      name: "dev",
      attached: true,
      windows: [
        {
          id: 1,
          index: 0,
          name: "main",
          active: true,
          zoomed: false,
          panes: [
            {
              id: 101,
              index: 0,
              active: true,
              title: "a",
              width: 80,
              height: 24,
            },
            {
              id: 102,
              index: 1,
              active: false,
              title: "b",
              width: 80,
              height: 24,
            },
          ],
        },
      ],
    },
  ];
  demo.sessions = sessions;
  return demo;
}

describe("BroadcastStore.send — truthful lastSend (tmux-optimistic-ui-7ue)", () => {
  it("does not set lastSend until sendKeys settles", async () => {
    const { bridge } = fakeBridge();
    const demo = demoWithPanes();
    const store = new BroadcastStore(bridge, demo);
    store.setTemplate("hi");
    store.selectAll();

    store.send();
    expect(store.lastSend).toBeNull();
  });

  it("counts only panes whose sendKeys resolved, with byte totals matching only those", async () => {
    const { bridge, calls } = fakeBridge();
    const demo = demoWithPanes();
    const store = new BroadcastStore(bridge, demo);
    store.setTemplate("hi");
    store.setAppendEnter(false);
    store.selectAll();

    store.send();
    expect(calls).toHaveLength(2);

    calls.find((c) => c.target === "%101")!.d.resolve(OK);
    calls
      .find((c) => c.target === "%102")!
      .d.reject(new Error("bridge closed"));
    await tick();

    expect(store.lastSend).toEqual({
      sentPanes: 1,
      sentBytes: 2, // "hi" = 2 bytes, appendEnter is off
      blockedPanes: 0,
      failedPanes: 1, // %102's sendKeys rejected
    });
  });

  it("counts a fulfilled-but-%error sendKeys as failed, not sent", async () => {
    const { bridge, calls } = fakeBridge();
    const demo = demoWithPanes();
    const store = new BroadcastStore(bridge, demo);
    store.setTemplate("hi");
    store.setAppendEnter(false);
    store.selectAll();

    store.send();
    expect(calls).toHaveLength(2);

    // A tmux %error resolves sendKeys with {success:false} — the promise
    // fulfills, but the keys never reached the pane.
    calls.find((c) => c.target === "%101")!.d.resolve(OK);
    calls
      .find((c) => c.target === "%102")!
      .d.resolve({ ...OK, success: false });
    await tick();

    expect(store.lastSend).toEqual({
      sentPanes: 1,
      sentBytes: 2,
      blockedPanes: 0,
      failedPanes: 1, // %102 fulfilled with success:false
    });
  });

  it("a stale send()'s settlement does not clobber a newer send()'s lastSend", async () => {
    const { bridge, calls } = fakeBridge();
    const demo = demoWithPanes();
    const store = new BroadcastStore(bridge, demo);
    store.setTemplate("hi");
    store.selectAll();

    store.send();
    const firstCalls = [...calls];
    store.send();
    const secondCalls = calls.slice(firstCalls.length);

    // The SECOND call settles first and writes lastSend.
    for (const c of secondCalls) c.d.resolve(OK);
    await tick();
    expect(store.lastSend?.sentPanes).toBe(2);

    // The FIRST call's settlement arrives late — it must not overwrite the
    // fresher summary the second call already wrote.
    for (const c of firstCalls) c.d.reject(new Error("late rejection"));
    await tick();
    expect(store.lastSend?.sentPanes).toBe(2);
  });
});
