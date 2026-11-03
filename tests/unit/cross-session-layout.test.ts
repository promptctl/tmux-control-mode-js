// tests/unit/cross-session-layout.test.ts
// In-process tests for the cross-session layout relay: the pure decode and
// delivery-planning helpers, and CrossSessionLayoutRelay driven through a
// fake TmuxConnection. See tests/integration/cross-session-layout.test.ts
// for the real-tmux end-to-end repro.

import { describe, it, expect } from "vitest";
import {
  CrossSessionLayoutRelay,
  decodeDelivery,
  decodeEntries,
  planDelivery,
} from "../../src/cross-session-layout.js";
import type { CrossSessionLayoutMessage } from "../../src/cross-session-layout.js";
import type { TmuxConnection } from "../../src/client.js";
import { TmuxCommandError, TransportClosedError } from "../../src/errors.js";
import type {
  CommandResponse,
  SubscriptionChangedMessage,
} from "../../src/protocol/types.js";

describe("decodeEntries", () => {
  it("decodes every entry of a same-tick burst", () => {
    expect(decodeEntries("1:@2,2:@4,")).toEqual({
      entries: [
        { seq: 1, windowId: 2 },
        { seq: 2, windowId: 4 },
      ],
      skips: [],
    });
  });

  it("returns nothing for an empty value", () => {
    expect(decodeEntries("")).toEqual({ entries: [], skips: [] });
  });

  it("skips foreign text and recovers the next real entry", () => {
    const { entries, skips } = decodeEntries("junk,3:@2,");
    expect(skips).toEqual([{ skippedBytes: 5 }]);
    expect(entries).toEqual([{ seq: 3, windowId: 2 }]);
  });

  it("stops without a diagnostic on an incomplete trailing entry", () => {
    expect(decodeEntries("1:@2,2:@4").entries).toEqual([
      { seq: 1, windowId: 2 },
    ]);
  });

  it("drops the first entry of a CAP-length value unread, even when it looks well-formed", () => {
    // `12:@4,` sheared to `2:@4,` parses — with the wrong seq.
    const filler = "99:@9,".repeat(683); // 4098 bytes
    const value = `2:@4,${filler}`.slice(-4096);
    expect(value.length).toBe(4096);
    const { entries, skips } = decodeEntries(value);
    expect(skips).toEqual([]);
    expect(entries.every((e) => e.seq === 99)).toBe(true);
  });
});

describe("planDelivery", () => {
  const e = (seq: number, windowId: number) => ({ seq, windowId });

  it("keeps only entries newer than lastSeq", () => {
    const plan = planDelivery([e(4, 1), e(5, 2), e(6, 3)], 4);
    expect(plan.windowIds).toEqual([2, 3]);
    expect(plan).toMatchObject({ lostEntries: 0, lastSeq: 6 });
  });

  it("fetches a window that changed again after a previous delivery", () => {
    // The old position-based diff treated a re-appended identical entry as
    // already processed; seq makes the second change a new entry.
    expect(planDelivery([e(1, 2), e(2, 2)], 1).windowIds).toEqual([2]);
  });

  it("deduplicates repeated changes to one window within a delivery", () => {
    expect(planDelivery([e(1, 0), e(2, 0)], 0).windowIds).toEqual([0]);
  });

  it("counts entries truncated away before this relay saw them", () => {
    expect(planDelivery([e(10, 1)], 6).lostEntries).toBe(3);
  });

  it("is a no-op when nothing is newer", () => {
    expect(planDelivery([e(3, 1)], 3)).toEqual({
      windowIds: [],
      lostEntries: 0,
      lastSeq: 3,
    });
  });
});

// ---------------------------------------------------------------------------
// CrossSessionLayoutRelay over a fake connection
// ---------------------------------------------------------------------------

type Handler = (msg: SubscriptionChangedMessage) => void;

function commandError(prefix: string): TmuxCommandError {
  const window = /@\d+/.exec(prefix)?.[0] ?? "";
  return new TmuxCommandError({
    commandNumber: 0,
    timestamp: 0,
    output: [window ? `can't find window: ${window}` : `failed: ${prefix}`],
    success: false,
  });
}

const HOOK = "window-layout-changed[9001]";

/**
 * Answers the relay's commands the way tmux would: the baseline read returns
 * `seq` and the epoch, `show-hooks` the global entry, a layout fetch a
 * layout line, everything else succeeds empty. `set-hook` installs the
 * entry and the epoch bump counts. `fail` makes matching commands reject
 * once.
 */
const PANE_1 = { paneId: 1, width: 80, height: 24, x: 0, y: 0 };

function fakeConnection(
  seq = "",
  layoutReply = "$2\tb25e,80x24,0,0,1\tb25e,80x24,0,0,1\t*",
) {
  const sent: string[] = [];
  let hookInstalled = false;
  let epoch = 0;
  const handlers = new Set<Handler>();
  const failures: { prefix: string; error: Error }[] = [];
  const pendingFetches: (() => void)[] = [];
  let holdFetches = false;
  const respond = (output: string[]): CommandResponse => ({
    commandNumber: sent.length,
    timestamp: 0,
    output,
    success: true,
  });
  const conn: TmuxConnection = {
    execute(command: string): Promise<CommandResponse> {
      sent.push(command);
      const failIdx = failures.findIndex((f) => command.startsWith(f.prefix));
      if (failIdx !== -1) {
        const [{ error }] = failures.splice(failIdx, 1);
        return Promise.reject(error);
      }
      if (command.includes("#{window_layout}")) {
        const reply = respond([layoutReply]);
        if (!holdFetches) return Promise.resolve(reply);
        return new Promise((resolve) =>
          pendingFetches.push(() => resolve(reply)),
        );
      }
      if (command.startsWith("show-hooks")) {
        return Promise.resolve(
          respond([hookInstalled ? `${HOOK} set-option x` : `${HOOK} `]),
        );
      }
      if (command.startsWith("set-hook")) hookInstalled = true;
      if (command.includes("@ttcmjs-cross-session-layout-epoch ")) epoch += 1;
      if (command.startsWith("display-message")) {
        return Promise.resolve(respond([`${seq}|${epoch}`]));
      }
      return Promise.resolve(respond([]));
    },
    on(_event: string, handler: Handler) {
      handlers.add(handler);
    },
    off(_event: string, handler: Handler) {
      handlers.delete(handler);
    },
    attachBytesSink() {
      return () => {};
    },
    connectionState: { status: "ready" },
  } as unknown as TmuxConnection;
  return {
    conn,
    sent,
    handlers,
    fail: (prefix: string, error: Error = commandError(prefix)) =>
      failures.push({ prefix, error }),
    holdFetches: () => {
      holdFetches = true;
    },
    releaseFetches: () => pendingFetches.splice(0).forEach((r) => r()),
    clearHook: () => {
      hookInstalled = false;
    },
    /** Another relay, elsewhere, repaired the hook. */
    bumpEpoch: () => {
      epoch += 1;
    },
    /** A delivery of the current epoch, `uncovered` as `@<wid>,` text, then `buffer`. */
    deliver: (buffer: string, uncovered = "") => {
      const value = `${epoch}|${uncovered}|${buffer}`;
      for (const h of handlers) {
        h({
          type: "subscription-changed",
          name: "ttcmjs-cross-session-layout",
          sessionId: -1,
          windowId: -1,
          windowIndex: -1,
          paneId: -1,
          value,
        } as SubscriptionChangedMessage);
      }
    },
  };
}

function relayOver(fake: ReturnType<typeof fakeConnection>) {
  const emitted: CrossSessionLayoutMessage[] = [];
  const relay = new CrossSessionLayoutRelay(fake.conn, (m) => emitted.push(m));
  return { relay, emitted };
}

const settle = () => new Promise((r) => setTimeout(r, 0));
const subscribes = (sent: string[]) =>
  sent.filter((c) => c.startsWith("refresh-client -B")).length;

// Every first delivery reports coverage; these tests are about the layout path.
const layoutEvents = (emitted: CrossSessionLayoutMessage[]) =>
  emitted.filter((m) => m.type !== "cross-session-layout-uncovered");

describe("CrossSessionLayoutRelay", () => {
  it("never writes the shared buffer, so it cannot consume another relay's entries", async () => {
    const fake = fakeConnection();
    const { relay } = relayOver(fake);
    await relay.enable();
    fake.deliver("1:@7,");
    await settle();
    const writes = fake.sent.filter((c) =>
      c.startsWith("set-option -gF @ttcmjs-cross-session-layout "),
    );
    expect(writes).toEqual([]);
  });

  it("does not replay entries older than the seq read at enable", async () => {
    const fake = fakeConnection("5");
    const { relay, emitted } = relayOver(fake);
    await relay.enable();
    fake.deliver("4:@1,5:@2,6:@3,");
    await settle();
    expect(layoutEvents(emitted)).toEqual([
      expect.objectContaining({
        type: "cross-session-layout-change",
        sessionId: 2,
        windowId: 3,
      }),
    ]);
  });

  it("reports the session tmux resolves the window in, with its flags", async () => {
    const fake = fakeConnection();
    const { relay, emitted } = relayOver(fake);
    await relay.enable();
    fake.deliver("1:@4,");
    await settle();
    expect(fake.sent).toContainEqual(
      expect.stringContaining("display-message -p -t @4 "),
    );
    expect(layoutEvents(emitted)).toEqual([
      {
        type: "cross-session-layout-change",
        sessionId: 2,
        windowId: 4,
        windowLayout: "b25e,80x24,0,0,1",
        windowVisibleLayout: "b25e,80x24,0,0,1",
        windowFlags: "*",
        layout: { kind: "parsed", panes: [PANE_1] },
        visibleLayout: { kind: "parsed", panes: [PANE_1] },
      },
    ]);
  });

  it("carries each pane's geometry for a zoomed window in another session", async () => {
    const full = "8205,80x24,0,0{40x24,0,0,0,39x24,41,0,1}";
    const fake = fakeConnection("", `$2\t${full}\tb25e,80x24,0,0,1\t*Z`);
    const { relay, emitted } = relayOver(fake);
    await relay.enable();
    fake.deliver("1:@4,");
    await settle();
    expect(layoutEvents(emitted)).toMatchObject([
      {
        layout: {
          kind: "parsed",
          panes: [
            { paneId: 0, width: 40, height: 24, x: 0, y: 0 },
            { paneId: 1, width: 39, height: 24, x: 41, y: 0 },
          ],
        },
        visibleLayout: { kind: "parsed", panes: [PANE_1] },
      },
    ]);
  });

  it("delivers a malformed layout with its failure arm, never guessed geometry", async () => {
    const fake = fakeConnection(
      "",
      "$2\tabcd,80x24,0,0,1\tb25e,80x24,0,0,1\t*",
    );
    const { relay, emitted } = relayOver(fake);
    await relay.enable();
    fake.deliver("1:@4,");
    await settle();
    expect(layoutEvents(emitted)).toMatchObject([
      {
        windowLayout: "abcd,80x24,0,0,1",
        layout: { kind: "malformed" },
        visibleLayout: { kind: "parsed", panes: [PANE_1] },
      },
    ]);
  });

  it("reports an overrun when entries were truncated away unseen", async () => {
    const fake = fakeConnection("2");
    const { relay, emitted } = relayOver(fake);
    await relay.enable();
    fake.deliver("6:@1,");
    await settle();
    expect(emitted).toContainEqual({
      type: "cross-session-layout-overrun",
      lostEntries: 3,
    });
  });

  it("subscribes once for nested enables and unsubscribes on the last disable", async () => {
    const fake = fakeConnection();
    const { relay } = relayOver(fake);
    await Promise.all([relay.enable(), relay.enable()]);
    expect(subscribes(fake.sent)).toBe(1);
    await relay.disable();
    expect(fake.handlers.size).toBe(1);
    await relay.disable();
    expect(fake.handlers.size).toBe(0);
    expect(fake.sent.at(-1)).toMatch(/^refresh-client -B/);
  });

  it("recovers after a failed enable instead of staying broken", async () => {
    const fake = fakeConnection();
    const { relay } = relayOver(fake);
    fake.fail("set-hook");
    await expect(relay.enable()).rejects.toThrow(/set-hook/);
    await relay.enable();
    expect(subscribes(fake.sent)).toBe(1);
    expect(fake.handlers.size).toBe(1);
  });

  it("detaches its listener when the subscribe itself fails", async () => {
    const fake = fakeConnection();
    const { relay } = relayOver(fake);
    fake.fail("refresh-client -B");
    await expect(relay.enable()).rejects.toThrow();
    expect(fake.handlers.size).toBe(0);
  });

  it("emits nothing from a fetch still in flight when disable resolves", async () => {
    const fake = fakeConnection();
    const { relay, emitted } = relayOver(fake);
    await relay.enable();
    fake.holdFetches();
    fake.deliver("1:@1,");
    await relay.disable();
    fake.releaseFetches();
    await settle();
    expect(layoutEvents(emitted)).toEqual([]);
  });

  it("emits fetch-failed for a window that vanished", async () => {
    const fake = fakeConnection();
    const { relay, emitted } = relayOver(fake);
    await relay.enable();
    fake.fail("display-message -p -t @9 ");
    fake.deliver("1:@9,");
    await settle();
    expect(layoutEvents(emitted)).toEqual([
      {
        type: "cross-session-layout-fetch-failed",
        windowId: 9,
        reason: "can't find window: @9",
      },
    ]);
  });

  it("emits nothing for a fetch cut off by the connection closing", async () => {
    const fake = fakeConnection();
    const { relay, emitted } = relayOver(fake);
    await relay.enable();
    fake.fail("display-message -p -t @9 ", new TransportClosedError("gone"));
    fake.deliver("1:@9,");
    await settle();
    expect(layoutEvents(emitted)).toEqual([]);
  });

  it("reports any other fetch rejection as fetch-failed rather than rejecting the delivery", async () => {
    const fake = fakeConnection();
    const { relay, emitted } = relayOver(fake);
    await relay.enable();
    fake.fail("display-message -p -t @9 ", new Error("malformed guard"));
    fake.deliver("1:@9,");
    await settle();
    expect(layoutEvents(emitted)).toEqual([
      {
        type: "cross-session-layout-fetch-failed",
        windowId: 9,
        reason: "Error: malformed guard",
      },
    ]);
  });

  it("rejects enable when the seq counter is not an integer", async () => {
    const fake = fakeConnection("garbage");
    const { relay } = relayOver(fake);
    await expect(relay.enable()).rejects.toThrow(/not an integer/);
    expect(fake.handlers.size).toBe(0);
  });
});

describe("decodeDelivery", () => {
  it("splits the epoch and uncovered windows from the buffer", () => {
    expect(decodeDelivery("2|@3,@5,|1:@3,")).toEqual({
      coverage: { epoch: "2", uncovered: [3, 5] },
      buffer: "1:@3,",
    });
  });

  it("reads an empty uncovered half as full coverage", () => {
    expect(decodeDelivery("||1:@3,").coverage).toEqual({
      epoch: "",
      uncovered: [],
    });
  });

  it("reduces a window linked into several sessions, in any order, to one id", () => {
    expect(decodeDelivery("|@5,@3,@5,|").coverage?.uncovered).toEqual([3, 5]);
  });

  it("rejects a head that is not the format's output", () => {
    expect(decodeDelivery("|@3|1:@3,").coverage).toBeNull();
    expect(decodeDelivery("1:@3,")).toEqual({ coverage: null, buffer: "" });
  });

  it("rejects an epoch that is not tmux's numeric reading", () => {
    expect(decodeDelivery("x|@3,|1:@3,").coverage).toBeNull();
  });
});

describe("CrossSessionLayoutRelay coverage", () => {
  const coverageCommands = (sent: string[]) =>
    sent.filter((c) => c.startsWith("set-hook") || c.startsWith("show-hooks"));
  const ofType = (emitted: CrossSessionLayoutMessage[], type: string) =>
    emitted.filter((m) => m.type === type);

  it("reinstalls a cleared hook and reports it restored", async () => {
    const fake = fakeConnection();
    const { relay, emitted } = relayOver(fake);
    await relay.enable();
    fake.deliver("", "");
    await settle();
    fake.clearHook();
    fake.deliver("", "@0,@1,@2,");
    await settle();
    expect(fake.sent.filter((c) => c.startsWith("set-hook"))).toHaveLength(2);
    fake.deliver("", "");
    await settle();
    expect(emitted).toEqual([
      { type: "cross-session-layout-uncovered", windowIds: [] },
      { type: "cross-session-layout-uncovered", windowIds: [0, 1, 2] },
      { type: "cross-session-layout-hook-restored" },
      { type: "cross-session-layout-uncovered", windowIds: [] },
    ]);
  });

  it("reports a repair another relay made, without repairing itself", async () => {
    const fake = fakeConnection();
    const { relay, emitted } = relayOver(fake);
    await relay.enable();
    fake.deliver("", "");
    await settle();
    const before = coverageCommands(fake.sent).length;
    fake.bumpEpoch();
    fake.deliver("", "");
    await settle();
    expect(ofType(emitted, "cross-session-layout-hook-restored")).toHaveLength(
      1,
    );
    expect(coverageCommands(fake.sent).length).toBe(before);
  });

  it("reports windows a local hook shadows without overriding it, and coverage returning", async () => {
    const fake = fakeConnection();
    const { relay, emitted } = relayOver(fake);
    await relay.enable();
    fake.deliver("", "@4,");
    await settle();
    fake.deliver("", "");
    await settle();
    expect(
      fake.sent.filter((c) => c.startsWith("set-hook") && c.includes(" -w")),
    ).toEqual([]);
    expect(emitted).toEqual([
      { type: "cross-session-layout-uncovered", windowIds: [4] },
      { type: "cross-session-layout-uncovered", windowIds: [] },
    ]);
  });

  it("does not re-report an unchanged or reordered set", async () => {
    const fake = fakeConnection();
    const { relay, emitted } = relayOver(fake);
    await relay.enable();
    fake.deliver("", "@4,@7,");
    fake.deliver("1:@2,", "@7,@4,");
    fake.deliver("1:@2,2:@2,", "@4,@7,");
    await settle();
    expect(ofType(emitted, "cross-session-layout-uncovered")).toHaveLength(1);
  });

  it("issues no coverage commands while coverage is whole", async () => {
    const fake = fakeConnection();
    const { relay } = relayOver(fake);
    await relay.enable();
    const before = coverageCommands(fake.sent).length;
    fake.deliver("1:@2,", "");
    fake.deliver("1:@2,2:@2,", "");
    await settle();
    expect(coverageCommands(fake.sent).length).toBe(before);
  });

  it("repairs a hook cleared while every window was already shadowed", async () => {
    const fake = fakeConnection();
    const { relay, emitted } = relayOver(fake);
    await relay.enable();
    fake.deliver("", "@4,");
    await settle();
    fake.clearHook();
    // The set is unchanged — only the buffer moved.
    fake.deliver("1:@4,", "@4,");
    await settle();
    fake.deliver("1:@4,", "");
    await settle();
    expect(ofType(emitted, "cross-session-layout-hook-restored")).toHaveLength(
      1,
    );
  });

  it("retries a refused repair on the next delivery", async () => {
    const fake = fakeConnection();
    const { relay } = relayOver(fake);
    await relay.enable();
    fake.clearHook();
    fake.fail("show-hooks");
    fake.deliver("", "@4,");
    await settle();
    fake.deliver("1:@4,", "@4,");
    await settle();
    expect(
      fake.sent.filter((c) =>
        c.includes('@ttcmjs-cross-session-layout-epoch "'),
      ),
    ).toHaveLength(2);
  });

  it("queues one repair for a burst of deliveries", async () => {
    const fake = fakeConnection();
    const { relay } = relayOver(fake);
    await relay.enable();
    const before = fake.sent.filter((c) => c.startsWith("show-hooks")).length;
    fake.deliver("", "@4,");
    fake.deliver("1:@4,", "@4,");
    fake.deliver("2:@4,", "@4,");
    await settle();
    expect(
      fake.sent.filter((c) => c.startsWith("show-hooks")).length - before,
    ).toBe(1);
  });

  it("leaves a present hook alone during a repair", async () => {
    const fake = fakeConnection();
    const { relay } = relayOver(fake);
    await relay.enable();
    const before = fake.sent.filter((c) => c.startsWith("set-hook")).length;
    fake.deliver("", "@4,");
    await settle();
    expect(fake.sent.filter((c) => c.startsWith("set-hook")).length).toBe(
      before,
    );
  });

  it("replaces whatever command sits at the reserved index", async () => {
    const fake = fakeConnection();
    const { relay } = relayOver(fake);
    await relay.enable();
    await relay.disable();
    const before = fake.sent.filter((c) => c.startsWith("set-hook")).length;
    await relay.enable();
    expect(fake.sent.filter((c) => c.startsWith("set-hook")).length).toBe(
      before + 1,
    );
  });

  it("tells a listener joining a live subscription the current set", async () => {
    const fake = fakeConnection();
    const { relay, emitted } = relayOver(fake);
    await relay.enable();
    fake.deliver("", "@4,");
    await settle();
    await relay.enable();
    expect(ofType(emitted, "cross-session-layout-uncovered")).toEqual([
      { type: "cross-session-layout-uncovered", windowIds: [4] },
      { type: "cross-session-layout-uncovered", windowIds: [4] },
    ]);
  });

  it("reports full coverage after re-enabling, even when it was last reported uncovered", async () => {
    const fake = fakeConnection();
    const { relay, emitted } = relayOver(fake);
    await relay.enable();
    fake.deliver("", "@4,");
    await settle();
    await relay.disable();
    await relay.enable();
    fake.deliver("", "");
    await settle();
    expect(ofType(emitted, "cross-session-layout-uncovered").at(-1)).toEqual({
      type: "cross-session-layout-uncovered",
      windowIds: [],
    });
  });

  it("reports a refused repair rather than staying quiet", async () => {
    const fake = fakeConnection();
    const { relay, emitted } = relayOver(fake);
    await relay.enable();
    fake.fail("show-hooks");
    fake.deliver("", "@4,");
    await settle();
    expect(emitted).toContainEqual({
      type: "cross-session-layout-repair-failed",
      reason: "failed: show-hooks",
    });
  });

  it("reports a value that is not the subscribed shape as a decode error", async () => {
    const fake = fakeConnection();
    const { relay, emitted } = relayOver(fake);
    await relay.enable();
    fake.deliver("", "junk");
    await settle();
    expect(emitted).toContainEqual({
      type: "cross-session-layout-decode-error",
      skippedBytes: "1|junk|".length,
    });
  });
});
