// examples/web-multiplexer/web/console-store.test.ts
//
// Foundation-slice coverage for the Console tab (tmux-showcase-bhx.25.1):
//   - the `"console"` AppMode and the persisted console slice survive a
//     UiStore reconstruction (the "round-trips across reloads" criterion);
//   - a malformed persisted blob falls back to defaults at the trust
//     boundary rather than propagating inward;
//   - ConsoleStore reads its persisted slice back through UiStore (single
//     source of truth) and dispose() is a safe no-op with no subscription.
//
// Node-safe: UiStore degrades to defaults when `sessionStorage` is absent,
// so we stub a Map-backed Storage to exercise the real persistence path.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { UiStore } from "./ui-store.ts";
import { ConsoleStore } from "./console-store.ts";
import { DEFAULT_FORMAT, DEFAULT_MODE } from "./console-types.ts";
import type { TmuxBridge } from "./bridge.ts";

const STORAGE_KEY = "tmux-demo-ui-v1";
// The auto-persist reaction is debounced; give it room to flush before we
// reconstruct and read back. [LAW:no-ambient-temporal-coupling] the delay
// is the store's own scheduler, not an arbitrary sleep we invented.
const PERSIST_FLUSH_MS = 160;

function makeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Minimal TmuxBridge double — ConsoleStore only stores it in this slice. */
function fakeBridge(): TmuxBridge {
  const noopUnsub = (): void => {};
  return {
    execute: () =>
      Promise.resolve({ commandNumber: 0, timestamp: 0, output: [], success: true }),
    sendKeys: () =>
      Promise.resolve({ commandNumber: 0, timestamp: 0, output: [], success: true }),
    detach: () => {},
    connect: () => {},
    disconnect: () => {},
    onEvent: () => noopUnsub,
    onError: () => noopUnsub,
    onState: () => noopUnsub,
    onWire: () => noopUnsub,
    startFirehose: () => {},
    stopFirehose: () => {},
    onFirehose: () => noopUnsub,
  };
}

beforeEach(() => {
  vi.stubGlobal("sessionStorage", makeStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("UiStore — console persistence", () => {
  it("round-trips appMode = 'console' across a reload", async () => {
    const a = new UiStore();
    a.setAppMode("console");
    await sleep(PERSIST_FLUSH_MS);

    const b = new UiStore();
    expect(b.appMode).toBe("console");
  });

  it("round-trips the persisted console slice across a reload", async () => {
    const a = new UiStore();
    a.console = {
      commandHistory: ["list-sessions", "display-message test"],
      lastFormat: "#{pane_pid}",
      lastTarget: { kind: "explicit", target: "%3" },
      lastMode: "subscribed",
    };
    await sleep(PERSIST_FLUSH_MS);

    const b = new UiStore();
    expect(b.console.commandHistory).toEqual(["list-sessions", "display-message test"]);
    expect(b.console.lastFormat).toBe("#{pane_pid}");
    expect(b.console.lastTarget).toEqual({ kind: "explicit", target: "%3" });
    expect(b.console.lastMode).toBe("subscribed");
  });

  it("falls back to console defaults when the persisted blob is malformed", () => {
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ appMode: "console", console: { lastMode: "bogus", lastTarget: 42 } }),
    );

    const store = new UiStore();
    expect(store.console.lastMode).toBe(DEFAULT_MODE);
    expect(store.console.lastTarget).toEqual({ kind: "active" });
    expect(store.console.lastFormat).toBe(DEFAULT_FORMAT);
    expect(store.console.commandHistory).toEqual([]);
  });
});

describe("ConsoleStore — foundation", () => {
  it("reads its persisted slice back through UiStore", () => {
    const ui = new UiStore();
    ui.console = {
      commandHistory: ["kill-pane"],
      lastFormat: "#{window_name}",
      lastTarget: { kind: "explicit", target: "@2" },
      lastMode: "subscribed",
    };
    const store = new ConsoleStore(fakeBridge(), ui);

    expect(store.commandHistory).toEqual(["kill-pane"]);
    expect(store.playgroundFormat).toBe("#{window_name}");
    expect(store.playgroundTarget).toEqual({ kind: "explicit", target: "@2" });
    expect(store.playgroundMode).toBe("subscribed");
  });

  it("starts with an empty ring and an idle playground result", () => {
    const store = new ConsoleStore(fakeBridge(), new UiStore());
    expect(store.replEntries).toEqual([]);
    expect(store.playgroundResult).toEqual({ status: "idle" });
  });

  it("dispose() is a safe no-op when no subscription is live", () => {
    const store = new ConsoleStore(fakeBridge(), new UiStore());
    expect(() => {
      store.dispose();
      store.dispose();
    }).not.toThrow();
  });
});
