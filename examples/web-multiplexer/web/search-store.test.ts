// examples/web-multiplexer/web/search-store.test.ts
//
// SearchStore's live feed reads pane bytes from the sink registry: chunks
// written into its server-scope sink are indexed on the next tick and found
// by a query. Its history backfill re-runs when the connection announces
// `reconnected`.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { serverScope } from "@promptctl/tmux-control-mode-js/browser";
import { SearchStore, type SearchConnection } from "./search-store.ts";
import { fakeSinkRegistry } from "./fake-sink-registry.ts";
import { OK } from "./fake-bridge.ts";

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

/** A connection whose one pane, %7, holds `history`; records every command
 *  and the `reconnected` handlers currently subscribed. */
function historyConnection(history: string[]): {
  conn: SearchConnection;
  commands: string[];
  reconnect(): void;
  subscribed(): number;
} {
  const commands: string[] = [];
  const reconnected = new Set<(ev: never) => void>();
  const conn: SearchConnection = {
    ...fakeSinkRegistry().registry,
    execute: (command) => {
      commands.push(command);
      const output = command.startsWith("list-panes") ? ["%7"] : history;
      return Promise.resolve({ ...OK, output });
    },
    on: (event: string, h: (ev: never) => void) => {
      expect(event).toBe("reconnected");
      reconnected.add(h);
    },
    off: (event: string, h: (ev: never) => void) => {
      expect(event).toBe("reconnected");
      reconnected.delete(h);
    },
  };
  return {
    conn,
    commands,
    reconnect: () =>
      reconnected.forEach((h) => h({ type: "reconnected" } as never)),
    subscribed: () => reconnected.size,
  };
}

describe("SearchStore backfill", () => {
  it("re-runs the backfill after a reconnect, and unsubscribes on dispose", async () => {
    const { conn, commands, reconnect, subscribed } = historyConnection([
      "old history",
    ]);
    const store = new SearchStore(conn);

    await store.ensureBackfilled();
    expect(commands).toEqual([
      "list-panes -a -F '#{pane_id}'",
      "capture-pane -p -S - -E - -t %7",
    ]);

    reconnect();
    await vi.advanceTimersByTimeAsync(0);
    expect(commands).toHaveLength(4);
    expect(store.backfilled).toBe(true);

    store.dispose();
    expect(subscribed()).toBe(0);
  });

  it("does not backfill on a reconnect before search mode was entered", async () => {
    const { conn, commands, reconnect } = historyConnection([]);
    const store = new SearchStore(conn);

    reconnect();
    await vi.advanceTimersByTimeAsync(0);
    expect(commands).toEqual([]);
    store.dispose();
  });
});
