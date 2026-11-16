// examples/web-multiplexer/web/search-store.test.ts
//
// SearchStore's live feed reads pane bytes from the sink registry: chunks
// written into its server-scope sink are indexed on the next tick and found
// by a query.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { serverScope } from "@promptctl/tmux-control-mode-js/browser";
import { SearchStore } from "./search-store.ts";
import { fakeSinkRegistry } from "./fake-sink-registry.ts";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("SearchStore live feed", () => {
  it("indexes the lines a pane's server-scope sink receives, and detaches on dispose", () => {
    const { registry, attached } = fakeSinkRegistry();
    const store = new SearchStore({
      ...registry,
      execute: () => Promise.reject(new Error("not used by this case")),
      on: () => {},
      off: () => {},
    });
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
