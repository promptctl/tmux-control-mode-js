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
import type { CommandResponse } from "@promptctl/tmux-control-mode-js/protocol";
import { UiStore } from "./ui-store.ts";
import { ConsoleStore } from "./console-store.ts";
import {
  CONSOLE_HISTORY_CAP,
  DEFAULT_FORMAT,
  DEFAULT_MODE,
  REPL_RING_CAP,
} from "./console-types.ts";
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

/** Minimal TmuxBridge double — most methods are unexercised test stubs. */
function fakeBridge(): TmuxBridge {
  const noop = (): void => {
    /* test stub: no behavior under test */
  };
  const noopUnsub = (): (() => void) => noop;
  return {
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
    onWire: noopUnsub,
    startFirehose: noop,
    stopFirehose: noop,
    onFirehose: noopUnsub,
  };
}

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

interface Call {
  readonly command: string;
  readonly d: Deferred<CommandResponse>;
}

/** A bridge whose `execute` is controllable: each call records its command and
 *  returns a deferred the test settles by hand (resolve ok/error, or reject). */
function replBridge(): { bridge: TmuxBridge; calls: Call[] } {
  const calls: Call[] = [];
  return {
    bridge: {
      ...fakeBridge(),
      execute: (command: string) => {
        const d = deferred<CommandResponse>();
        calls.push({ command, d });
        return d.promise;
      },
    },
    calls,
  };
}

function ok(output: readonly string[]): CommandResponse {
  return { commandNumber: 0, timestamp: 0, output, success: true };
}

function errResp(output: readonly string[]): CommandResponse {
  return { commandNumber: 0, timestamp: 0, output, success: false };
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

describe("ConsoleStore — REPL submit", () => {
  it("transitions pending → ok and captures latency from the injected clock", async () => {
    const { bridge, calls } = replBridge();
    const clock = { t: 0 };
    const store = new ConsoleStore(bridge, new UiStore(), () => clock.t);

    const p = store.submit("display-message test");
    expect(store.replEntries).toHaveLength(1);
    expect(store.replEntries[0].status).toBe("pending");

    clock.t = 12;
    calls[0].d.resolve(ok(["test"]));
    await p;

    const entry = store.replEntries[0];
    expect(entry.status).toBe("ok");
    if (entry.status === "ok") {
      expect(entry.output).toEqual(["test"]);
      expect(entry.latencyMs).toBe(12);
    }
  });

  it("renders a tmux %error (success:false) as an error row carrying the diagnostic", async () => {
    const { bridge, calls } = replBridge();
    const clock = { t: 0 };
    const store = new ConsoleStore(bridge, new UiStore(), () => clock.t);

    const p = store.submit("bogus-command");
    clock.t = 6;
    calls[0].d.resolve(errResp(["unknown command: bogus-command"]));
    await p;

    const entry = store.replEntries[0];
    expect(entry.status).toBe("error");
    if (entry.status === "error") {
      expect(entry.message).toBe("unknown command: bogus-command");
      expect(entry.latencyMs).toBe(6);
    }
  });

  it("surfaces a transport rejection (bridge disconnect) in the row, not a swallowed log", async () => {
    const { bridge, calls } = replBridge();
    const store = new ConsoleStore(bridge, new UiStore());

    const p = store.submit("list-sessions");
    calls[0].d.reject(new Error("bridge disconnected"));
    await p;

    const entry = store.replEntries[0];
    expect(entry.status).toBe("error");
    if (entry.status === "error") expect(entry.message).toBe("bridge disconnected");
  });

  it("decodes latin1-container output to UTF-8 at the store boundary", async () => {
    const { bridge, calls } = replBridge();
    const store = new ConsoleStore(bridge, new UiStore());

    const p = store.submit("display-message");
    // "café" UTF-8 bytes (0xC3 0xA9 for é) arrive as a latin1-container string.
    calls[0].d.resolve(ok(["cafÃ©"]));
    await p;

    const entry = store.replEntries[0];
    if (entry.status === "ok") expect(entry.output).toEqual(["café"]);
    else throw new Error("expected ok");
  });

  it("short-circuits empty/whitespace submits — no row, no command, no history write", async () => {
    const { bridge, calls } = replBridge();
    const store = new ConsoleStore(bridge, new UiStore());

    await store.submit("   ");
    expect(store.replEntries).toEqual([]);
    expect(calls).toHaveLength(0);
    expect(store.commandHistory).toEqual([]);
  });

  it("writes the submitted command back to persisted recall history", async () => {
    const ui = new UiStore();
    const store = new ConsoleStore(fakeBridge(), ui);

    await store.submit("list-sessions");
    expect(ui.console.commandHistory).toEqual(["list-sessions"]);
    expect(store.commandHistory).toEqual(["list-sessions"]);
  });

  it("resolves a row that was pending across a (simulated) tab switch", async () => {
    // The store has no view coupling, so a pending row resolving with no view
    // attached IS the 'store outlives the view' guarantee.
    const { bridge, calls } = replBridge();
    const store = new ConsoleStore(bridge, new UiStore());

    const p = store.submit("attach");
    expect(store.replEntries[0].status).toBe("pending");
    calls[0].d.resolve(ok(["done"]));
    await p;
    expect(store.replEntries[0].status).toBe("ok");
  });
});

describe("ConsoleStore — REPL ring", () => {
  it("bounds the ring at REPL_RING_CAP, evicting oldest resolved rows", async () => {
    const store = new ConsoleStore(fakeBridge(), new UiStore());
    for (let i = 0; i < REPL_RING_CAP + 5; i++) await store.submit(`cmd${i}`);

    expect(store.replEntries).toHaveLength(REPL_RING_CAP);
    expect(store.replEntries[0].command).toBe("cmd5");
    expect(store.replEntries[REPL_RING_CAP - 1].command).toBe(`cmd${REPL_RING_CAP + 4}`);
  });

  it("never evicts a pending row, even when it is the oldest entry", async () => {
    const { bridge, calls } = replBridge();
    const store = new ConsoleStore(bridge, new UiStore());

    // First command stays pending for the whole flood.
    const pendingP = store.submit("slow");
    for (let i = 1; i <= REPL_RING_CAP + 5; i++) {
      const p = store.submit(`cmd${i}`);
      calls[i].d.resolve(ok([]));
      await p;
    }

    const slow = store.replEntries.find((e) => e.command === "slow");
    expect(slow?.status).toBe("pending");

    calls[0].d.resolve(ok(["late but landed"]));
    await pendingP;
    expect(store.replEntries.find((e) => e.command === "slow")?.status).toBe("ok");
  });

  it("clear() empties the live ring but leaves persisted recall history intact", async () => {
    const ui = new UiStore();
    const store = new ConsoleStore(fakeBridge(), ui);

    await store.submit("keep");
    store.clear();

    expect(store.replEntries).toEqual([]);
    expect(ui.console.commandHistory).toContain("keep");
  });

  it("drops a resolution whose row was cleared mid-flight without throwing", async () => {
    const { bridge, calls } = replBridge();
    const store = new ConsoleStore(bridge, new UiStore());

    const p = store.submit("x");
    expect(store.replEntries).toHaveLength(1);
    store.clear();
    expect(store.replEntries).toHaveLength(0);

    calls[0].d.resolve(ok(["late"]));
    await p;
    expect(store.replEntries).toHaveLength(0);
  });
});

describe("ConsoleStore — recall", () => {
  function seeded(history: readonly string[]): ConsoleStore {
    const ui = new UiStore();
    for (const cmd of history) ui.pushConsoleCommand(cmd);
    return new ConsoleStore(fakeBridge(), ui);
  }

  it("walks older with Up and newer with Down, no wraparound", () => {
    const store = seeded(["a", "b", "c"]); // most-recent-last: c is newest

    expect(store.recallPrevious()).toEqual({ kind: "command", text: "c" });
    expect(store.recallPrevious()).toEqual({ kind: "command", text: "b" });
    expect(store.recallPrevious()).toEqual({ kind: "command", text: "a" });
    expect(store.recallPrevious()).toEqual({ kind: "none" }); // oldest boundary

    expect(store.recallNext()).toEqual({ kind: "command", text: "b" });
    expect(store.recallNext()).toEqual({ kind: "command", text: "c" });
    expect(store.recallNext()).toEqual({ kind: "live" }); // past newest → live line
    expect(store.recallNext()).toEqual({ kind: "none" }); // already live
  });

  it("returns none on both directions when history is empty", () => {
    const store = seeded([]);
    expect(store.recallPrevious()).toEqual({ kind: "none" });
    expect(store.recallNext()).toEqual({ kind: "none" });
  });

  it("submit resets the recall cursor", async () => {
    const store = seeded(["a", "b"]);
    expect(store.recallPrevious()).toEqual({ kind: "command", text: "b" });

    await store.submit("c");
    // Cursor is back at the live line; Down has nowhere to go.
    expect(store.recallNext()).toEqual({ kind: "none" });
  });
});

describe("UiStore — pushConsoleCommand", () => {
  it("caps the persisted recall list at CONSOLE_HISTORY_CAP, dropping oldest", () => {
    const ui = new UiStore();
    for (let i = 0; i < CONSOLE_HISTORY_CAP + 5; i++) ui.pushConsoleCommand(`c${i}`);

    expect(ui.console.commandHistory).toHaveLength(CONSOLE_HISTORY_CAP);
    expect(ui.console.commandHistory[0]).toBe("c5");
    expect(ui.console.commandHistory[CONSOLE_HISTORY_CAP - 1]).toBe(
      `c${CONSOLE_HISTORY_CAP + 4}`,
    );
  });
});
