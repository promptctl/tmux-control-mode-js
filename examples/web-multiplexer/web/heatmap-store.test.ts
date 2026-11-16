// examples/web-multiplexer/web/heatmap-store.test.ts
//
// HeatmapStore reads pane bytes from the sink registry: one server-scope
// sink, whose chunks become a per-pane byte rate on the next tick.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { serverScope } from "@promptctl/tmux-control-mode-js/browser";
import { HeatmapStore } from "./heatmap-store.ts";
import { fakeSinkRegistry } from "./fake-sink-registry.ts";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("HeatmapStore", () => {
  it("rates each pane by the bytes its server-scope sink receives, and detaches on dispose", () => {
    const { registry, attached } = fakeSinkRegistry();
    const store = new HeatmapStore(registry);
    expect(attached).toHaveLength(1);
    expect(attached[0].options).toEqual({ scope: serverScope });

    attached[0].sink.write({ paneId: 4, data: new Uint8Array(100) });
    vi.advanceTimersByTime(200);

    expect(store.rateFor(4)).toBeGreaterThan(0);
    expect(store.rateFor(5)).toBe(0);

    store.dispose();
    expect(attached[0].detached).toBe(true);
  });
});
