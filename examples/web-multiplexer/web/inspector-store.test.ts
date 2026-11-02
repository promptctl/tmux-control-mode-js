// examples/web-multiplexer/web/inspector-store.test.ts
//
// Regression coverage for SD5 (tmux-complexity-lkg.15): `eventMessages` must
// be a MobX computed a consumer can read fresh on every render, because
// `entries` is mutated in place (`.push()`/`.shift()`) on the common path —
// a React `useMemo` keyed on `entries`' reference would never see it change.
// [LAW:one-source-of-truth]

import { describe, it, expect, vi } from "vitest";
import type { WireHandler, TmuxBridge } from "./bridge.ts";
import { InspectorStore } from "./inspector-store.ts";
import { UiStore } from "./ui-store.ts";

/** Minimal TmuxBridge double that captures the `onWire` handler so the test
 *  can push wire entries directly, the way the real transport would. */
function fakeBridge(): { bridge: TmuxBridge; emit: WireHandler } {
  const noop = (): void => {
    /* test stub: no behavior under test */
  };
  const noopUnsub = (): (() => void) => noop;
  let handler: WireHandler = noop;
  return {
    bridge: {
      execute: () =>
        Promise.resolve({ commandNumber: 0, timestamp: 0, output: [], success: true }),
      sendKeys: () =>
        Promise.resolve({ commandNumber: 0, timestamp: 0, output: [], success: true }),
      detach: noop,
      connect: noop,
      disconnect: noop,
      onEvent: noopUnsub,
      onError: noopUnsub,
      onState: noopUnsub,
      onWire: (h) => {
        handler = h;
        return noop;
      },
      startFirehose: noop,
      stopFirehose: noop,
      onFirehose: noopUnsub,
    },
    emit: (entry) => handler(entry),
  };
}

function makeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k) => (map.has(k) ? (map.get(k) as string) : null),
    key: (i) => [...map.keys()][i] ?? null,
    removeItem: (k) => void map.delete(k),
    setItem: (k, v) => void map.set(k, String(v)),
  };
}

describe("InspectorStore#eventMessages", () => {
  it("picks up events ingested after the first read, newest first", () => {
    vi.stubGlobal("sessionStorage", makeStorage());
    const uiStore = new UiStore();
    const { bridge, emit } = fakeBridge();
    const store = new InspectorStore(bridge, uiStore);

    emit({ dir: "in-event", ts: 0, event: { type: "sessions-changed" } });
    // First read establishes any caller's baseline — this is the read a
    // React useMemo keyed on `entries`' reference would have frozen on.
    expect(store.eventMessages).toEqual([{ type: "sessions-changed" }]);

    emit({
      dir: "in-event",
      ts: 1,
      event: { type: "window-add", windowId: 3 },
    });
    // `entries.push()` mutated the array in place — same reference, new
    // content. A correct computed sees it; a stale useMemo would not.
    expect(store.eventMessages).toEqual([
      { type: "window-add", windowId: 3 },
      { type: "sessions-changed" },
    ]);
  });

  it("ignores out/in-response/in-error wire entries", () => {
    vi.stubGlobal("sessionStorage", makeStorage());
    const uiStore = new UiStore();
    const { bridge, emit } = fakeBridge();
    const store = new InspectorStore(bridge, uiStore);

    emit({ dir: "in-error", ts: 0, id: null, message: "boom" });
    emit({ dir: "in-event", ts: 1, event: { type: "sessions-changed" } });

    expect(store.eventMessages).toEqual([{ type: "sessions-changed" }]);
  });
});
