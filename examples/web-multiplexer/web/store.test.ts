// examples/web-multiplexer/web/store.test.ts
//
// Regression coverage for two related findings surfaced on PR #154's review
// (tmux-lifecycle-zng.6): DemoStore.selectSession/jumpToPane write
// `clientSessionId` optimistically before switch-client resolves. Now that
// the WS bridge actually rejects (this PR's core fix), a rejected
// switch-client left `clientSessionId` stale forever — `activeSessionId`
// prioritizes it over the attached-session fallback, so the UI would show a
// session tmux never actually switched to. These tests assert the fix:
// revert to null on rejection, guarded by a token so a newer selection
// always wins over a stale one.

import { describe, it, expect } from "vitest";
import type { CommandResponse } from "@promptctl/tmux-control-mode-js/protocol";
import { DemoStore } from "./store.ts";
import type { TmuxBridge } from "./bridge.ts";

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

interface Call {
  readonly command: string;
  readonly d: Deferred<CommandResponse>;
}

/** A TmuxBridge double whose execute() is controllable; every other method
 *  is an unexercised stub. */
function fakeBridge(): { bridge: TmuxBridge; calls: Call[] } {
  const calls: Call[] = [];
  const noop = (): void => {};
  const noopUnsub = (): (() => void) => noop;
  return {
    bridge: {
      execute: (command: string) => {
        const d = deferred<CommandResponse>();
        calls.push({ command, d });
        return d.promise;
      },
      sendKeys: () =>
        Promise.resolve({
          commandNumber: 0,
          timestamp: 0,
          output: [],
          success: true,
        }),
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

function findCall(calls: readonly Call[], substr: string): Call {
  const c = calls.find((call) => call.command.includes(substr));
  if (c === undefined) throw new Error(`no call matching "${substr}"`);
  return c;
}

describe("DemoStore — optimistic clientSessionId settlement", () => {
  it("reverts clientSessionId to null when switch-client rejects, falling back to the attached session", async () => {
    const { bridge, calls } = fakeBridge();
    const store = new DemoStore(bridge);
    store.sessions = [
      { id: 5, name: "five", attached: false, windows: [] },
      { id: 7, name: "seven", attached: true, windows: [] },
    ];

    store.selectSession(5);
    expect(store.activeSessionId).toBe(5);

    findCall(calls, "switch-client").d.reject(new Error("bridge closed"));
    await tick();

    expect(store.activeSessionId).toBe(7);
  });

  it("a stale switch-client rejection does not clobber a newer selectSession", async () => {
    const { bridge, calls } = fakeBridge();
    const store = new DemoStore(bridge);
    store.sessions = [
      { id: 5, name: "five", attached: false, windows: [] },
      { id: 7, name: "seven", attached: false, windows: [] },
    ];

    store.selectSession(5);
    const firstSwitch = findCall(calls, "switch-client");
    store.selectSession(7);
    expect(store.activeSessionId).toBe(7);

    // The FIRST call's rejection arrives late, after the second call already
    // wrote the fresher value. It must not clobber it.
    firstSwitch.d.reject(new Error("late failure"));
    await tick();

    expect(store.activeSessionId).toBe(7);
  });

  it("jumpToPane reverts clientSessionId to null when switch-client rejects, falling back to the attached session", async () => {
    const { bridge, calls } = fakeBridge();
    const store = new DemoStore(bridge);
    store.sessions = [
      { id: 9, name: "nine", attached: false, windows: [] },
      { id: 11, name: "eleven", attached: true, windows: [] },
    ];

    store.jumpToPane(9, 1, 1);
    expect(store.activeSessionId).toBe(9);

    findCall(calls, "switch-client").d.reject(new Error("bridge closed"));
    await tick();

    expect(store.activeSessionId).toBe(11);
  });
});
