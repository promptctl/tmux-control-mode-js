// tests/unit/connectors-bridge.test.ts
//
// Unit tests for the renderer-side bridge adapters under
// src/connectors/bridge/. Both `paneSessionClientFromBridge` and
// `BridgeModelClient` are pure adapters — a fake TmuxBridge feeds events
// in, asserts go on the handler/wire side.

import { describe, it, expect } from "vitest";
import {
  BridgeModelClient,
  paneSessionClientFromBridge,
} from "../../src/connectors/bridge/index.js";
import { PaneAction } from "../../src/protocol/types.js";
import type { CommandResponse, TmuxMessage } from "../../src/protocol/types.js";
import type {
  ConnState,
  ErrorHandler,
  EventHandler,
  StateHandler,
  TmuxBridge,
  WireHandler,
} from "../../src/connectors/types.js";

// ---------------------------------------------------------------------------
// Fake bridge
// ---------------------------------------------------------------------------

interface FakeBridge extends TmuxBridge {
  emit(ev: TmuxMessage): void;
  setState(state: ConnState): void;
  readonly executed: string[];
  readonly sentKeys: Array<{ target: string; keys: string }>;
  readonly paneActions: Array<{ paneId: number; action: PaneAction }>;
  /** Number of live `onEvent` listeners — proves single-registration. */
  eventListenerCount(): number;
  /** Resolve the next pending `execute` with a successful response. */
  resolveLastExecute(): void;
}

function createFakeBridge(): FakeBridge {
  const eventHandlers = new Set<EventHandler>();
  const stateHandlers = new Set<StateHandler>();
  let currentState: ConnState = "connecting";
  const executed: string[] = [];
  const sentKeys: Array<{ target: string; keys: string }> = [];
  const paneActions: Array<{ paneId: number; action: PaneAction }> = [];
  const pendingExecutes: Array<(r: CommandResponse) => void> = [];

  const okResponse: CommandResponse = {
    success: true,
    command: "",
    output: "",
    error: "",
  };

  return {
    execute(command) {
      executed.push(command);
      return new Promise<CommandResponse>((resolve) => {
        pendingExecutes.push(resolve);
      });
    },
    sendKeys(target, keys) {
      sentKeys.push({ target, keys });
      return Promise.resolve(okResponse);
    },
    setPaneAction(paneId, action) {
      paneActions.push({ paneId, action });
      return Promise.resolve(okResponse);
    },
    detach() {},
    connect() {},
    disconnect() {},
    onEvent(h: EventHandler) {
      eventHandlers.add(h);
      return () => eventHandlers.delete(h);
    },
    onError(_h: ErrorHandler) {
      return () => {};
    },
    onState(h: StateHandler) {
      stateHandlers.add(h);
      // Contract from connectors/types.ts: synchronous current-state delivery.
      h(currentState);
      return () => stateHandlers.delete(h);
    },
    onWire(_h: WireHandler) {
      return () => {};
    },
    emit(ev) {
      for (const h of eventHandlers) h(ev);
    },
    setState(state) {
      currentState = state;
      for (const h of stateHandlers) h(state);
    },
    eventListenerCount: () => eventHandlers.size,
    resolveLastExecute() {
      const r = pendingExecutes.shift();
      if (r === undefined) throw new Error("no pending execute");
      r({ ...okResponse, command: executed[executed.length - 1] ?? "" });
    },
    executed,
    sentKeys,
    paneActions,
  };
}

// ---------------------------------------------------------------------------
// paneSessionClientFromBridge
// ---------------------------------------------------------------------------

describe("paneSessionClientFromBridge", () => {
  it("routes pane events from the bridge fan-in stream to typed handlers", () => {
    const bridge = createFakeBridge();
    const client = paneSessionClientFromBridge(bridge);

    const outputs: number[] = [];
    const extended: number[] = [];
    const pauses: number[] = [];
    const continues: number[] = [];

    client.on("output", (m) => outputs.push(m.paneId));
    client.on("extended-output", (m) => extended.push(m.paneId));
    client.on("pause", (m) => pauses.push(m.paneId));
    client.on("continue", (m) => continues.push(m.paneId));

    bridge.emit({
      type: "output",
      paneId: 5,
      data: new Uint8Array([0x61]),
    });
    bridge.emit({
      type: "extended-output",
      paneId: 6,
      age: 100,
      data: new Uint8Array([0x62]),
    });
    bridge.emit({ type: "pause", paneId: 7 });
    bridge.emit({ type: "continue", paneId: 8 });

    expect(outputs).toEqual([5]);
    expect(extended).toEqual([6]);
    expect(pauses).toEqual([7]);
    expect(continues).toEqual([8]);
  });

  it("registers exactly ONE bridge.onEvent listener regardless of session count", () => {
    const bridge = createFakeBridge();
    const client = paneSessionClientFromBridge(bridge);

    // Five "sessions" subscribing — should still be one bridge listener.
    for (let i = 0; i < 5; i++) {
      client.on("output", () => {});
      client.on("pause", () => {});
    }

    expect(bridge.eventListenerCount()).toBe(1);
  });

  it("off() detaches a previously-registered handler", () => {
    const bridge = createFakeBridge();
    const client = paneSessionClientFromBridge(bridge);

    const seen: number[] = [];
    const handler = (m: { paneId: number }): void => {
      seen.push(m.paneId);
    };
    client.on("output", handler);
    bridge.emit({ type: "output", paneId: 1, data: new Uint8Array() });
    client.off("output", handler);
    bridge.emit({ type: "output", paneId: 2, data: new Uint8Array() });

    expect(seen).toEqual([1]);
  });

  it("ignores non-pane events", () => {
    const bridge = createFakeBridge();
    const client = paneSessionClientFromBridge(bridge);

    let count = 0;
    client.on("output", () => count++);

    bridge.emit({
      type: "subscription-changed",
      name: "x",
      sessionId: 1,
      windowId: -1,
      windowIndex: -1,
      paneId: -1,
      value: "",
    });
    bridge.emit({ type: "session-window-changed", sessionId: 1, windowId: 2 });

    expect(count).toBe(0);
  });

  it("forwards execute / sendKeys / setPaneAction to the bridge", async () => {
    const bridge = createFakeBridge();
    const client = paneSessionClientFromBridge(bridge);

    const exec = client.execute("display-message");
    bridge.resolveLastExecute();
    await exec;

    await client.sendKeys("%5", "abc");
    await client.setPaneAction(5, PaneAction.Pause);

    expect(bridge.executed).toEqual(["display-message"]);
    expect(bridge.sentKeys).toEqual([{ target: "%5", keys: "abc" }]);
    expect(bridge.paneActions).toEqual([
      { paneId: 5, action: PaneAction.Pause },
    ]);
  });
});

// ---------------------------------------------------------------------------
// BridgeModelClient
// ---------------------------------------------------------------------------

describe("BridgeModelClient", () => {
  it("subscribeSessions issues refresh-client -B with the scoped format and routes inbound rows", async () => {
    const bridge = createFakeBridge();
    const client = new BridgeModelClient(bridge);

    const seen: Array<Record<"id" | "name", string>[]> = [];
    const subPromise = client.subscribeSessions(
      ["id", "name"] as const,
      (rows) => seen.push(rows),
    );
    // The execute promise won't resolve until we drive the fake; resolve it.
    bridge.resolveLastExecute();
    const handle = await subPromise;

    // The execute string should embed `refresh-client -B` with our auto name.
    const wire = bridge.executed[0]!;
    expect(wire).toMatch(/^refresh-client -B 'bridge-cm-sub-1':/);
    // Format embedded after the `:'':'<format>'` should be the scoped format.
    expect(wire).toContain("#{S:");

    // Now deliver a `%subscription-changed` for that name.
    bridge.emit({
      type: "subscription-changed",
      name: "bridge-cm-sub-1",
      sessionId: -1,
      windowId: -1,
      windowIndex: -1,
      paneId: -1,
      // FIELD_SEP = \x1f, ROW_SEP = \x1e. Format appends ROW_SEP after every
      // row, so the trailing \x1e here mirrors the wire shape.
      value: "$1\x1falpha\x1e$2\x1fbeta\x1e",
    });

    expect(seen).toEqual([
      [
        { id: "$1", name: "alpha" },
        { id: "$2", name: "beta" },
      ],
    ]);

    handle.dispose();
    // Disposing fires `refresh-client -B <name>` (no format → unsubscribe).
    expect(bridge.executed).toHaveLength(2);
    expect(bridge.executed[1]).toBe("refresh-client -B 'bridge-cm-sub-1'");
  });

  it("fans out the four model-relevant events to typed handlers", () => {
    const bridge = createFakeBridge();
    const client = new BridgeModelClient(bridge);

    const seen: string[] = [];
    client.on("client-session-changed", () => seen.push("css"));
    client.on("layout-change", () => seen.push("lc"));
    client.on("session-window-changed", () => seen.push("swc"));
    client.on("window-pane-changed", () => seen.push("wpc"));

    bridge.emit({
      type: "client-session-changed",
      clientName: "/tmp/socket,42,0",
      sessionId: 1,
      name: "main",
    });
    bridge.emit({
      type: "layout-change",
      windowId: 2,
      windowLayout: "x",
      windowVisibleLayout: "y",
      windowFlags: "",
    });
    bridge.emit({ type: "session-window-changed", sessionId: 1, windowId: 2 });
    bridge.emit({ type: "window-pane-changed", windowId: 2, paneId: 3 });

    expect(seen).toEqual(["css", "lc", "swc", "wpc"]);
  });

  it("on closed→ready, fires subscriptions-reset and re-issues every live subscription", async () => {
    const bridge = createFakeBridge();
    const client = new BridgeModelClient(bridge);

    // Register one subscription.
    const subPromise = client.subscribePanes(["id"] as const, () => {});
    bridge.resolveLastExecute();
    await subPromise;
    expect(bridge.executed).toHaveLength(1);

    // First ready transition is the initial bring-up — does NOT re-issue.
    bridge.setState("ready");

    let resets = 0;
    client.on("subscriptions-reset", () => resets++);

    // Now simulate a drop + reconnect.
    bridge.setState("closed");
    bridge.setState("connecting");
    bridge.setState("ready");

    expect(resets).toBe(1);
    // Re-issue must have been emitted under the same auto name.
    const reissued = bridge.executed.filter((c) =>
      c.includes("'bridge-cm-sub-1'"),
    );
    // Original subscribe + re-issue = 2.
    expect(reissued.length).toBe(2);
  });

  it("dispose detaches all listeners and stops routing", () => {
    const bridge = createFakeBridge();
    const client = new BridgeModelClient(bridge);

    let count = 0;
    client.on("layout-change", () => count++);
    bridge.emit({
      type: "layout-change",
      windowId: 1,
      windowLayout: "",
      windowVisibleLayout: "",
      windowFlags: "",
    });
    expect(count).toBe(1);

    client.dispose();
    bridge.emit({
      type: "layout-change",
      windowId: 1,
      windowLayout: "",
      windowVisibleLayout: "",
      windowFlags: "",
    });
    expect(count).toBe(1);
    // dispose should also detach the bridge.onEvent listener it registered.
    expect(bridge.eventListenerCount()).toBe(0);
  });
});
