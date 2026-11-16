// examples/web-multiplexer/web/inspector-store.test.ts
//
// Regression coverage for SD5 (tmux-complexity-lkg.15): `notifications` must
// be a MobX computed a consumer can read fresh on every render, because
// `entries` is mutated in place (`.push()`/`.shift()`) on the common path —
// a React `useMemo` keyed on `entries`' reference would never see it change.
// [LAW:one-source-of-truth]
//
// And for lkg.20: pane output rides its own `in-output` direction, yet is
// still a notification named `output` — listed in the Debug tab and hidden by
// a hidden `output` type, as it was when it arrived as an `in-event`.

import { describe, it, expect, vi } from "vitest";
import type { WireHandler, TmuxBridge } from "./bridge.ts";
import { InspectorStore } from "./inspector-store.ts";
import { UiStore } from "./ui-store.ts";
import { notificationType } from "./event-summary.ts";
import { fakeBridge } from "./fake-bridge.ts";

/** A TmuxBridge double that captures the `onWire` handler so the test can
 *  push wire entries directly, the way the real transport would. */
function wireBridge(): { bridge: TmuxBridge; emit: WireHandler } {
  let handler: WireHandler = () => {};
  const bridge = fakeBridge({
    onWire: (h) => {
      handler = h;
      return () => {};
    },
  });
  return { bridge, emit: (entry) => handler(entry) };
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

function inspector(): {
  store: InspectorStore;
  uiStore: UiStore;
  emit: WireHandler;
} {
  vi.stubGlobal("sessionStorage", makeStorage());
  const uiStore = new UiStore();
  const { bridge, emit } = wireBridge();
  return { store: new InspectorStore(bridge, uiStore), uiStore, emit };
}

const outputChunk = { paneId: 5, data: new TextEncoder().encode("hi") };

describe("InspectorStore#notifications", () => {
  it("picks up notifications ingested after the first read, newest first", () => {
    const { store, emit } = inspector();

    emit({ dir: "in-event", ts: 0, event: { type: "sessions-changed" } });
    // First read establishes any caller's baseline — this is the read a
    // React useMemo keyed on `entries`' reference would have frozen on.
    expect(store.notifications.map(notificationType)).toEqual([
      "sessions-changed",
    ]);

    emit({ dir: "in-output", ts: 1, chunk: outputChunk });
    // `entries.push()` mutated the array in place — same reference, new
    // content. A correct computed sees it; a stale useMemo would not.
    expect(store.notifications.map(notificationType)).toEqual([
      "output",
      "sessions-changed",
    ]);
  });

  it("ignores out/in-response/in-error wire entries", () => {
    const { store, emit } = inspector();

    emit({ dir: "in-error", ts: 0, id: null, message: "boom" });
    emit({ dir: "in-event", ts: 1, event: { type: "sessions-changed" } });

    expect(store.notifications.map(notificationType)).toEqual([
      "sessions-changed",
    ]);
  });
});

describe("InspectorStore event-type filter", () => {
  it("offers `output` as a type and hides pane output when it is hidden", () => {
    const { store, uiStore, emit } = inspector();
    emit({ dir: "in-event", ts: 0, event: { type: "sessions-changed" } });
    emit({ dir: "in-output", ts: 1, chunk: outputChunk });

    expect(store.knownEventTypes).toEqual(["output", "sessions-changed"]);

    uiStore.toggleEventType("output");
    expect(store.visibleEntries.map((e) => e.wire.dir)).toEqual(["in-event"]);
  });
});
