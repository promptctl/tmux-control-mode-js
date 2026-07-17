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

describe("DemoStore.jumpToPane — command sequencing (tmux-optimistic-ui-7ue)", () => {
  it("does not issue select-window/select-pane when switch-client rejects", async () => {
    const { bridge, calls } = fakeBridge();
    const store = new DemoStore(bridge);
    store.sessions = [
      { id: 9, name: "nine", attached: false, windows: [] },
      { id: 11, name: "eleven", attached: true, windows: [] },
    ];

    store.jumpToPane(9, 1, 1);
    findCall(calls, "switch-client").d.reject(new Error("bridge closed"));
    await tick();

    expect(calls.some((c) => c.command.includes("select-window"))).toBe(false);
    expect(calls.some((c) => c.command.includes("select-pane"))).toBe(false);
  });

  it("issues select-window/select-pane only after switch-client resolves", async () => {
    const { bridge, calls } = fakeBridge();
    const store = new DemoStore(bridge);
    store.sessions = [{ id: 9, name: "nine", attached: false, windows: [] }];

    store.jumpToPane(9, 42, 7);

    // Before switch-client resolves, the follow-ons must not have fired yet.
    expect(calls.some((c) => c.command.includes("select-window"))).toBe(false);
    expect(calls.some((c) => c.command.includes("select-pane"))).toBe(false);

    findCall(calls, "switch-client").d.resolve({
      commandNumber: 0,
      timestamp: 0,
      output: [],
      success: true,
    });
    await tick();

    expect(findCall(calls, "select-window").command).toBe(
      "select-window -t @42",
    );
    expect(findCall(calls, "select-pane").command).toBe("select-pane -t %7");
  });

  it("does not fire a superseded jump's select-window/select-pane once a newer jump has bumped the token", async () => {
    const { bridge, calls } = fakeBridge();
    const store = new DemoStore(bridge);
    store.sessions = [
      { id: 9, name: "nine", attached: false, windows: [] },
      { id: 11, name: "eleven", attached: false, windows: [] },
    ];

    // First jump goes in-flight (switch-client pending), then a newer jump
    // supersedes it before the first switch-client resolves.
    store.jumpToPane(9, 42, 7);
    const firstSwitch = calls.find((c) =>
      c.command.includes("switch-client -t \\$9"),
    )!;
    store.jumpToPane(11, 99, 8);

    // The stale (first) switch-client resolves last. Its success path must see
    // the token has moved on and skip its select commands entirely.
    firstSwitch.d.resolve({
      commandNumber: 0,
      timestamp: 0,
      output: [],
      success: true,
    });
    await tick();

    expect(calls.some((c) => c.command.includes("select-window -t @42"))).toBe(
      false,
    );
    expect(calls.some((c) => c.command.includes("select-pane -t %7"))).toBe(
      false,
    );
  });
});
