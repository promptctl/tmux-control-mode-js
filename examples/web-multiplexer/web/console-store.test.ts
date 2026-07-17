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
import type {
  CommandResponse,
  TmuxMessage,
} from "@promptctl/tmux-control-mode-js/protocol";
import { UiStore } from "./ui-store.ts";
import { ConsoleStore, quoteTmuxArg } from "./console-store.ts";
import {
  CONSOLE_HISTORY_CAP,
  DEFAULT_FORMAT,
  DEFAULT_MODE,
  REPL_RING_CAP,
} from "./console-types.ts";
import type {
  ConnState,
  EventHandler,
  StateHandler,
  TmuxBridge,
} from "./bridge.ts";
import { deferred, tick, type Deferred } from "./test-utils.ts";

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
      Promise.resolve({
        commandNumber: 0,
        timestamp: 0,
        output: [],
        success: true,
      }),
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
  };
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

/**
 * A bridge that records every executed command, lets the test settle one-shot
 * calls by hand, and lets it push `%subscription-changed` / connection-state
 * events to the store's live listeners. `eventListeners` is the leak probe:
 * exactly one is registered while a subscription is live, zero otherwise.
 */
function playgroundBridge(): {
  bridge: TmuxBridge;
  execCalls: Call[];
  eventListeners: Set<EventHandler>;
  emit: (ev: TmuxMessage) => void;
  fireState: (s: ConnState) => void;
} {
  const execCalls: Call[] = [];
  const eventListeners = new Set<EventHandler>();
  const stateListeners = new Set<StateHandler>();
  return {
    bridge: {
      ...fakeBridge(),
      execute: (command: string) => {
        const d = deferred<CommandResponse>();
        execCalls.push({ command, d });
        return d.promise;
      },
      onEvent: (h: EventHandler) => {
        eventListeners.add(h);
        return () => void eventListeners.delete(h);
      },
      onState: (h: StateHandler) => {
        stateListeners.add(h);
        return () => void stateListeners.delete(h);
      },
    },
    execCalls,
    eventListeners,
    emit: (ev) => eventListeners.forEach((h) => h(ev)),
    fireState: (s) => stateListeners.forEach((h) => h(s)),
  };
}

function subEvent(name: string, value: string): TmuxMessage {
  return {
    type: "subscription-changed",
    name,
    sessionId: 0,
    windowId: -1,
    windowIndex: -1,
    paneId: -1,
    value,
  };
}

function commandsOf(calls: readonly Call[]): string[] {
  return calls.map((c) => c.command);
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
    expect(b.console.commandHistory).toEqual([
      "list-sessions",
      "display-message test",
    ]);
    expect(b.console.lastFormat).toBe("#{pane_pid}");
    expect(b.console.lastTarget).toEqual({ kind: "explicit", target: "%3" });
    expect(b.console.lastMode).toBe("subscribed");
  });

  it("falls back to console defaults when the persisted blob is malformed", () => {
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        appMode: "console",
        console: { lastMode: "bogus", lastTarget: 42 },
      }),
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
    if (entry.status === "error")
      expect(entry.message).toBe("bridge disconnected");
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
    expect(store.replEntries[REPL_RING_CAP - 1].command).toBe(
      `cmd${REPL_RING_CAP + 4}`,
    );
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
    expect(store.replEntries.find((e) => e.command === "slow")?.status).toBe(
      "ok",
    );
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

describe("quoteTmuxArg", () => {
  it("wraps a plain string in single quotes", () => {
    expect(quoteTmuxArg("#{pane_pid}")).toBe("'#{pane_pid}'");
  });

  it("round-trips an embedded single quote via the '\\'' sequence", () => {
    // The fixture from the design doc. Verified against tmux 3.6a control mode:
    // this exact encoding makes `it's` survive display-message / refresh-client.
    expect(quoteTmuxArg("it's")).toBe("'it'\\''s'");
  });

  it("escapes every embedded quote, not just the first", () => {
    expect(quoteTmuxArg("a'b'c")).toBe("'a'\\''b'\\''c'");
  });
});

describe("ConsoleStore — Playground one-shot", () => {
  function oneShotStore(): {
    store: ConsoleStore;
    rig: ReturnType<typeof playgroundBridge>;
  } {
    const rig = playgroundBridge();
    const store = new ConsoleStore(rig.bridge, new UiStore());
    return { store, rig };
  }

  it("issues display-message -p with the quoted format and routes ok → value", async () => {
    const { store, rig } = oneShotStore();
    store.setPlaygroundFormat("#{session_name}");

    expect(rig.execCalls).toHaveLength(1);
    expect(rig.execCalls[0].command).toBe(
      "display-message -p '#{session_name}'",
    );

    rig.execCalls[0].d.resolve(ok(["demo"]));
    await tick();
    expect(store.playgroundResult).toEqual({
      status: "value",
      value: "demo",
      updateCount: 1,
    });
  });

  it("targets an explicit pane with -t and omits it for the active pane", () => {
    const { store, rig } = oneShotStore();

    store.setPlaygroundTarget({ kind: "explicit", target: "%3" });
    expect(rig.execCalls.at(-1)?.command).toBe(
      "display-message -p -t %3 '#{session_name}: #{window_name}'",
    );

    store.setPlaygroundTarget({ kind: "active" });
    expect(rig.execCalls.at(-1)?.command).toBe(
      "display-message -p '#{session_name}: #{window_name}'",
    );
  });

  it("routes a tmux %error (success:false) → error variant carrying the diagnostic", async () => {
    const { store, rig } = oneShotStore();
    store.setPlaygroundFormat("#{bogus");

    rig.execCalls[0].d.resolve(errResp(["invalid format"]));
    await tick();
    expect(store.playgroundResult).toEqual({
      status: "error",
      message: "invalid format",
    });
  });

  it("surfaces a transport rejection in the error variant, not a swallowed log", async () => {
    const { store, rig } = oneShotStore();
    store.setPlaygroundFormat("#{pane_pid}");

    rig.execCalls[0].d.reject(new Error("bridge disconnected"));
    await tick();
    expect(store.playgroundResult).toEqual({
      status: "error",
      message: "bridge disconnected",
    });
  });

  it("decodes a latin1-container value to UTF-8 at the store boundary", async () => {
    const { store, rig } = oneShotStore();
    store.setPlaygroundFormat("#{pane_title}");

    rig.execCalls[0].d.resolve(ok(["cafÃ©"]));
    await tick();
    expect(store.playgroundResult).toEqual({
      status: "value",
      value: "café",
      updateCount: 1,
    });
  });

  it("drops a stale one-shot resolution superseded by a newer evaluation", async () => {
    const { store, rig } = oneShotStore();
    store.setPlaygroundFormat("first");
    store.setPlaygroundFormat("second");

    // Resolve the SECOND (newest) first, then the stale first.
    rig.execCalls[1].d.resolve(ok(["second-value"]));
    await tick();
    rig.execCalls[0].d.resolve(ok(["first-value"]));
    await tick();

    expect(store.playgroundResult).toEqual({
      status: "value",
      value: "second-value",
      updateCount: 1,
    });
  });
});

describe("ConsoleStore — Playground subscription lifecycle", () => {
  function subscribedStore(): {
    store: ConsoleStore;
    rig: ReturnType<typeof playgroundBridge>;
  } {
    const rig = playgroundBridge();
    const store = new ConsoleStore(rig.bridge, new UiStore());
    store.setPlaygroundMode("subscribed"); // installs the first subscription
    return { store, rig };
  }

  it("installs exactly one subscription on entering subscribed mode", () => {
    const { rig } = subscribedStore();
    expect(rig.eventListeners.size).toBe(1);
    expect(rig.execCalls.at(-1)?.command).toBe(
      "refresh-client -B 'playground::#{session_name}: #{window_name}'",
    );
  });

  it("subscribes the active pane with an empty <what> and an explicit pane by token", () => {
    const { store, rig } = subscribedStore();
    store.setPlaygroundTarget({ kind: "explicit", target: "%5" });
    expect(rig.eventListeners.size).toBe(1);
    expect(rig.execCalls.at(-1)?.command).toBe(
      "refresh-client -B 'playground:%5:#{session_name}: #{window_name}'",
    );
  });

  it("tears down before re-subscribing on a format change — never leaks a subscription", () => {
    const { store, rig } = subscribedStore();
    store.setPlaygroundFormat("#{pane_pid}");
    store.setPlaygroundFormat("#{pane_current_command}");

    // One listener live at all times — every re-subscribe removed the prior.
    expect(rig.eventListeners.size).toBe(1);

    // Each re-subscribe is preceded by a `refresh-client -B playground` removal.
    const cmds = commandsOf(rig.execCalls);
    expect(
      cmds.filter((c) => c === "refresh-client -B playground"),
    ).toHaveLength(2);
    expect(cmds.at(-1)).toBe(
      "refresh-client -B 'playground::#{pane_current_command}'",
    );
  });

  it("a target change while subscribed tears down and re-subscribes (single active)", () => {
    const { store, rig } = subscribedStore();
    store.setPlaygroundTarget({ kind: "explicit", target: "%7" });

    expect(rig.eventListeners.size).toBe(1);
    const cmds = commandsOf(rig.execCalls);
    expect(cmds).toContain("refresh-client -B playground");
    expect(cmds.at(-1)).toBe(
      "refresh-client -B 'playground:%7:#{session_name}: #{window_name}'",
    );
  });

  it("switching to one-shot tears down the subscription before issuing display-message", () => {
    const { store, rig } = subscribedStore();
    const before = rig.execCalls.length;
    store.setPlaygroundMode("one-shot");

    expect(rig.eventListeners.size).toBe(0); // listener removed
    const after = commandsOf(rig.execCalls).slice(before);
    expect(after).toEqual([
      "refresh-client -B playground",
      "display-message -p '#{session_name}: #{window_name}'",
    ]); // teardown strictly precedes the one-shot
  });

  it("an identical refresh is a no-op — the subscription survives view re-mounts", () => {
    const { store, rig } = subscribedStore();
    const listenerBefore = [...rig.eventListeners][0];
    const callsBefore = rig.execCalls.length;

    store.refresh(); // e.g. the view re-mounting on a tab switch

    expect(rig.eventListeners.size).toBe(1);
    expect([...rig.eventListeners][0]).toBe(listenerBefore); // same listener, not rebuilt
    expect(rig.execCalls).toHaveLength(callsBefore); // no new command issued
  });

  it("applies subscription values, counting updates and ignoring other subscriptions", () => {
    const { store, rig } = subscribedStore();
    expect(store.playgroundResult).toEqual({ status: "idle" }); // before the first fire

    rig.emit(subEvent("sessions", "not-mine")); // demo's own subscription — ignored
    expect(store.playgroundResult).toEqual({ status: "idle" });

    rig.emit(subEvent("playground", "vim"));
    expect(store.playgroundResult).toEqual({
      status: "value",
      value: "vim",
      updateCount: 1,
    });

    rig.emit(subEvent("playground", "nvim"));
    expect(store.playgroundResult).toEqual({
      status: "value",
      value: "nvim",
      updateCount: 2,
    });
  });

  it("decodes latin1-container subscription values", () => {
    const { store, rig } = subscribedStore();
    rig.emit(subEvent("playground", "cafÃ©"));
    expect(store.playgroundResult).toEqual({
      status: "value",
      value: "café",
      updateCount: 1,
    });
  });

  it("re-subscribing resets the update counter and result to idle", () => {
    const { store, rig } = subscribedStore();
    rig.emit(subEvent("playground", "a"));
    expect(store.playgroundResult).toEqual({
      status: "value",
      value: "a",
      updateCount: 1,
    });

    store.setPlaygroundFormat("#{pane_pid}");
    expect(store.playgroundResult).toEqual({ status: "idle" });
  });

  it("dispose() removes the live subscription and stops listening", () => {
    const { store, rig } = subscribedStore();
    store.dispose();

    expect(rig.eventListeners.size).toBe(0);
    expect(commandsOf(rig.execCalls).at(-1)).toBe(
      "refresh-client -B playground",
    );

    // A late event from the dropped subscription is ignored.
    rig.emit(subEvent("playground", "late"));
    expect(store.playgroundResult).toEqual({ status: "idle" });
  });

  it("resets liveSig/disposeSubscription and drops the listener when the subscribe execute() rejects, so a later refresh() retries instead of no-op'ing forever", async () => {
    const { store, rig } = subscribedStore();
    expect(rig.eventListeners.size).toBe(1);
    const callsBefore = rig.execCalls.length;

    rig.execCalls[0].d.reject(new Error("bridge closed"));
    await tick();

    // The dead listener from the failed attempt is gone...
    expect(rig.eventListeners.size).toBe(0);

    // ...and refresh() with the SAME (mode, target, format) actually retries
    // rather than no-op'ing on a stale liveSig that thinks a subscription
    // is still live.
    store.refresh();
    expect(rig.execCalls.length).toBeGreaterThan(callsBefore);
    expect(rig.eventListeners.size).toBe(1);
  });

  it("surfaces a rejected subscribe as a visible error, not a silent forever-idle result", async () => {
    const { store, rig } = subscribedStore();

    rig.execCalls[0].d.reject(new Error("bridge closed"));
    await tick();

    expect(store.playgroundResult).toEqual({
      status: "error",
      message: "bridge closed",
    });
  });

  it("installs the subscription when the bridge reaches ready (boot into subscribed)", () => {
    // Persisted mode is subscribed, but the store is constructed before the
    // bridge is ready: the ready handler reconciles to the desired state.
    const rig = playgroundBridge();
    const ui = new UiStore();
    ui.setConsoleMode("subscribed");
    const store = new ConsoleStore(rig.bridge, ui);
    expect(rig.eventListeners.size).toBe(0); // nothing yet — bridge not ready

    rig.fireState("ready");
    expect(rig.eventListeners.size).toBe(1);
    expect(store.playgroundMode).toBe("subscribed");
  });
});

describe("UiStore — pushConsoleCommand", () => {
  it("caps the persisted recall list at CONSOLE_HISTORY_CAP, dropping oldest", () => {
    const ui = new UiStore();
    for (let i = 0; i < CONSOLE_HISTORY_CAP + 5; i++)
      ui.pushConsoleCommand(`c${i}`);

    expect(ui.console.commandHistory).toHaveLength(CONSOLE_HISTORY_CAP);
    expect(ui.console.commandHistory[0]).toBe("c5");
    expect(ui.console.commandHistory[CONSOLE_HISTORY_CAP - 1]).toBe(
      `c${CONSOLE_HISTORY_CAP + 4}`,
    );
  });
});
