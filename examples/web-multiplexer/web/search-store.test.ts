// examples/web-multiplexer/web/search-store.test.ts
//
// SearchStore's live feed reads pane bytes from the sink registry: chunks
// written into its server-scope sink are indexed on the next tick and found
// by a query.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { serverScope } from "@promptctl/tmux-control-mode-js/browser";
import type { TmuxBridge } from "./bridge.ts";
import { SearchStore } from "./search-store.ts";
import { fakeSinkRegistry } from "./fake-sink-registry.ts";

/** The live feed never touches the bridge; every method is inert. */
function inertBridge(): TmuxBridge {
  const noopUnsub = (): void => {};
  const unused = (): Promise<never> =>
    Promise.reject(new Error("not used by these cases"));
  return {
    execute: unused,
    sendKeys: unused,
    detach: () => {},
    connect: () => {},
    disconnect: () => {},
    onEvent: () => noopUnsub,
    onPaneOutput: () => noopUnsub,
    onError: () => noopUnsub,
    onState: () => noopUnsub,
    onWire: () => noopUnsub,
    startFirehose: () => {},
    stopFirehose: () => {},
    onFirehose: () => noopUnsub,
    setSize: unused,
    setWindowSize: unused,
    clearWindowSize: unused,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("SearchStore live feed", () => {
  it("indexes the lines a pane's server-scope sink receives, and detaches on dispose", () => {
    const { registry, attached } = fakeSinkRegistry();
    const store = new SearchStore(inertBridge(), registry);
    expect(attached).toHaveLength(1);
    expect(attached[0].options).toEqual({ scope: serverScope });

    attached[0].sink.write({
      paneId: 7,
      data: new TextEncoder().encode("needle in a haystack\r\n"),
    });
    vi.advanceTimersByTime(200);
    store.setQuery("needle");

    expect(store.results.map((h) => [h.paneId, h.text])).toEqual([
      [7, "needle in a haystack"],
    ]);

    store.dispose();
    expect(attached[0].detached).toBe(true);
  });
});
