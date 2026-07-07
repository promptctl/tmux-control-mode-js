// examples/web-multiplexer/web/escape-playground-store.test.ts
//
// Regression coverage for a race surfaced on PR #154's review
// (tmux-lifecycle-zng.6): EscapePlaygroundStore.send() optimistically sets
// `lastSentBytes` before its sendKeys() call settles. Now that the WS bridge
// actually rejects (this PR's core fix), a naive unconditional reset-to-null
// in the catch would let a STALE (older) send's rejection clobber a NEWER
// send's already-displayed byte count. These tests assert the guarded fix:
// only the send that still owns the currently-displayed value may roll it
// back.

import { describe, it, expect } from "vitest";
import type { CommandResponse } from "@promptctl/tmux-control-mode-js/protocol";
import { EscapePlaygroundStore } from "./escape-playground-store.ts";
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
  readonly target: string;
  readonly keys: string;
  readonly d: Deferred<CommandResponse>;
}

/** A TmuxBridge double whose sendKeys() is controllable; every other method
 *  is an unexercised stub. */
function sendKeysBridge(): { bridge: TmuxBridge; calls: Call[] } {
  const calls: Call[] = [];
  const noop = (): void => {};
  const noopUnsub = (): (() => void) => noop;
  return {
    bridge: {
      execute: () =>
        Promise.resolve({
          commandNumber: 0,
          timestamp: 0,
          output: [],
          success: true,
        }),
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

function readyStore(): { store: EscapePlaygroundStore; calls: Call[] } {
  const { bridge, calls } = sendKeysBridge();
  const store = new EscapePlaygroundStore(bridge);
  // send() requires status "ready" and a paneId; drive them directly rather
  // than exercising the full spawn() IO flow, which is orthogonal to this
  // race.
  store.status = "ready";
  store.paneId = 5;
  return { store, calls };
}

describe("EscapePlaygroundStore.send() — lastSentBytes settlement", () => {
  it("resets lastSentBytes to null when its own send rejects and nothing newer has overwritten it", async () => {
    const { store, calls } = readyStore();

    store.send("hello"); // 5 bytes
    expect(store.lastSentBytes).toBe(5);

    calls[0].d.reject(new Error("bridge closed"));
    await tick();

    expect(store.lastSentBytes).toBeNull();
  });

  it("a stale rejection from an older send does not clobber a newer send's already-displayed byte count", async () => {
    const { store, calls } = readyStore();

    store.send("ab"); // call A: 2 bytes
    expect(store.lastSentBytes).toBe(2);

    store.send("hello"); // call B: 5 bytes, issued before A settles
    expect(store.lastSentBytes).toBe(5);

    // A is the OLDER call; it rejects after B has already written the
    // fresher value. A stale, unconditional reset would wipe B's value.
    calls[0].d.reject(new Error("late failure"));
    await tick();

    expect(store.lastSentBytes).toBe(5);
  });
});
