// tests/unit/client-reconnect.test.ts
// Unit tests for TmuxClient's reconnect-aware subscription lifecycle.
//
// Asserts the public contract added by `headless-api-resubscribe`:
//   - transport.onReconnect → client emits 'subscriptions-reset' SYNCHRONOUSLY
//     before any reissue wire traffic.
//   - reissueAll re-subscribes every live entry under fresh names.
//   - Disposed entries are NOT re-issued.
//   - SubscriptionHandle.dispose() remains valid across a reissue —
//     dispose targets the CURRENT (post-reissue) tmux name.
//   - %subscription-changed for the new name routes to the original handler.
//   - Per-subscription resubscribe failures emit 'subscription-error' with
//     `phase: 'resubscribe'` and do not throw out of the loop.
//
// [LAW:behavior-not-structure] Tests assert observable wire output and
// public-event delivery — never inspect TmuxClient private state.

import { describe, it, expect } from "vitest";
import { TmuxClient } from "../../src/client.js";
import type { TmuxTransport } from "../../src/transport/types.js";
import { ROW_SEP } from "../../src/subscriptions.js";

interface FakeReconnectingTransport extends TmuxTransport {
  readonly sent: string[];
  emitData(chunk: string): void;
  /** Trigger every onReconnect handler the client registered. */
  fireReconnect(): void;
  /** Auto-respond to each command sent through `send()`. */
  queueResponse(kind: "ok" | "err"): void;
}

function makeFakeTransport(): FakeReconnectingTransport {
  const sent: string[] = [];
  let dataCb: ((chunk: string) => void) | null = null;
  const reconnectCallbacks: (() => void)[] = [];
  const responses: Array<"ok" | "err"> = [];
  let cmdNumber = 0;

  const emit = (chunk: string) => {
    dataCb?.(chunk);
  };

  const transport: FakeReconnectingTransport = {
    sent,
    send(command) {
      sent.push(command);
      const kind = responses.shift() ?? "ok";
      const ts = Date.now();
      cmdNumber++;
      Promise.resolve().then(() => {
        emit(`%begin ${ts} ${cmdNumber} 0\n`);
        emit(
          kind === "ok"
            ? `%end ${ts} ${cmdNumber} 0\n`
            : `%error ${ts} ${cmdNumber} 0\n`,
        );
      });
    },
    onData(cb) {
      dataCb = cb;
    },
    onClose() {
      /* not exercised */
    },
    onReconnect(cb) {
      reconnectCallbacks.push(cb);
    },
    close() {
      /* not exercised */
    },
    emitData(chunk) {
      emit(chunk);
    },
    fireReconnect() {
      for (const cb of reconnectCallbacks) cb();
    },
    queueResponse(kind) {
      responses.push(kind);
    },
  };
  return transport;
}

function extractSubName(wire: string): string | undefined {
  return wire.match(/'(tmux-cm-sub-\d+)'/)?.[1];
}

describe("TmuxClient reconnect-aware subscription lifecycle", () => {
  it("emits 'subscriptions-reset' synchronously on transport.onReconnect, before any wire traffic", async () => {
    const t = makeFakeTransport();
    const client = new TmuxClient(t);

    t.queueResponse("ok");
    t.queueResponse("ok");
    await client.subscribePanes(["pane_id"] as const, () => {});
    await client.subscribeWindows(["window_id"] as const, () => {});
    const sentBefore = t.sent.length;

    let resetFired = 0;
    let sentAtResetTime = -1;
    client.on("subscriptions-reset", () => {
      resetFired++;
      sentAtResetTime = t.sent.length;
    });

    // Queue OKs for the upcoming reissues (one per live subscription).
    t.queueResponse("ok");
    t.queueResponse("ok");
    t.fireReconnect();

    expect(resetFired).toBe(1);
    // 'subscriptions-reset' must fire BEFORE any new wire traffic.
    expect(sentAtResetTime).toBe(sentBefore);

    // Allow the queued microtasks (sendRaw -> begin/end) to settle so the
    // reissue loop walks both entries.
    await new Promise((r) => setTimeout(r, 5));
    expect(t.sent.length).toBe(sentBefore + 2);
  });

  it("re-issues every live subscription under fresh names and routes new events to the original handler", async () => {
    const t = makeFakeTransport();
    const client = new TmuxClient(t);

    t.queueResponse("ok");
    let received: Array<Record<"pane_id", string>> | null = null;
    const handle = await client.subscribePanes(["pane_id"] as const, (rows) => {
      received = rows;
    });
    const oldName = extractSubName(t.sent[0]);
    expect(oldName).toBeDefined();

    // Trigger reconnect; expect one fresh subscribe wire.
    const sentBefore = t.sent.length;
    t.queueResponse("ok");
    t.fireReconnect();
    await new Promise((r) => setTimeout(r, 5));
    expect(t.sent.length).toBe(sentBefore + 1);
    const newName = extractSubName(t.sent[sentBefore]);
    expect(newName).toBeDefined();
    expect(newName).not.toBe(oldName);

    // Old name no longer routes — handler must not fire.
    t.emitData(`%subscription-changed ${oldName} - - - - : %1${ROW_SEP}\n`);
    expect(received).toBeNull();

    // New name routes to the SAME handler.
    t.emitData(`%subscription-changed ${newName} - - - - : %1${ROW_SEP}\n`);
    expect(received).toEqual([{ pane_id: "%1" }]);

    // Dispose targets the post-reissue subscription, not the stale name.
    t.queueResponse("ok");
    handle.dispose();
    await new Promise((r) => setTimeout(r, 5));
    const lastWire = t.sent[t.sent.length - 1];
    expect(lastWire).toContain(newName!);
    expect(lastWire).toMatch(/^refresh-client -B '/);
  });

  it("does not re-issue subscriptions disposed before reconnect", async () => {
    const t = makeFakeTransport();
    const client = new TmuxClient(t);

    t.queueResponse("ok");
    const handle = await client.subscribePanes(["pane_id"] as const, () => {});
    t.queueResponse("ok");
    handle.dispose();
    await new Promise((r) => setTimeout(r, 5));
    const sentBefore = t.sent.length;

    t.fireReconnect();
    await new Promise((r) => setTimeout(r, 5));
    // No subscribe wire issued — all entries were disposed.
    expect(t.sent.length).toBe(sentBefore);
  });

  it("emits 'subscription-error' on per-subscription resubscribe failure and continues with the rest", async () => {
    const t = makeFakeTransport();
    const client = new TmuxClient(t);

    t.queueResponse("ok");
    t.queueResponse("ok");
    await client.subscribePanes(["pane_id"] as const, () => {});
    await client.subscribeWindows(["window_id"] as const, () => {});

    const errors: Array<{ phase: string; name: string }> = [];
    client.on("subscription-error", (ev) => {
      errors.push({ phase: ev.phase, name: ev.name });
    });

    // First reissue fails (tmux %error), second succeeds.
    t.queueResponse("err");
    t.queueResponse("ok");
    t.fireReconnect();

    await new Promise((r) => setTimeout(r, 10));

    expect(errors).toHaveLength(1);
    expect(errors[0].phase).toBe("resubscribe");
    expect(errors[0].name).toMatch(/^tmux-cm-sub-\d+$/);
  });

  it("'subscriptions-reset' fires whether or not transport implements onReconnect (manual reissueAll)", async () => {
    // A transport WITHOUT onReconnect — like spawnTmux. The client should
    // still expose the reset behavior to consumers who choose to drive
    // reissueAll() manually (e.g. a custom reconnecting wrapper).
    const sent: string[] = [];
    let dataCb: ((chunk: string) => void) | null = null;
    const responses: Array<"ok" | "err"> = [];
    let cmdNumber = 0;
    const t: TmuxTransport = {
      send(command) {
        sent.push(command);
        const kind = responses.shift() ?? "ok";
        const ts = Date.now();
        cmdNumber++;
        Promise.resolve().then(() => {
          dataCb?.(`%begin ${ts} ${cmdNumber} 0\n`);
          dataCb?.(
            kind === "ok"
              ? `%end ${ts} ${cmdNumber} 0\n`
              : `%error ${ts} ${cmdNumber} 0\n`,
          );
        });
      },
      onData(cb) {
        dataCb = cb;
      },
      onClose() {},
      close() {},
      // NOTE: no onReconnect.
    };
    const queue = (kind: "ok" | "err") => responses.push(kind);

    const client = new TmuxClient(t);
    queue("ok");
    await client.subscribePanes(["pane_id"] as const, () => {});

    let resetFired = 0;
    client.on("subscriptions-reset", () => {
      resetFired++;
    });

    queue("ok");
    await client.reissueAll();
    expect(resetFired).toBe(1);
    expect(sent.length).toBe(2); // initial subscribe + reissue subscribe
  });
});
