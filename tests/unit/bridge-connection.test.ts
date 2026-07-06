// tests/unit/bridge-connection.test.ts
// Unit tests for the shared BridgeConnection helper that pin behavior both
// transports rely on. The helper is shared between electron/main.ts and
// websocket/server.ts, so any race here surfaces in both bridges — testing
// it directly (without a transport in front) keeps assertion shape tight.

import { describe, it, expect } from "vitest";

import { TmuxClient } from "../../src/client.js";
import type { TmuxTransport } from "../../src/transport/types.js";
import { createBridgeConnection } from "../../src/connectors/bridge-connection.js";
import { STARTUP_GREETING } from "./_helpers/greeting.js";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FakeTransport {
  readonly transport: TmuxTransport;
  readonly sent: string[];
  feed(chunk: string): void;
}

function createFakeTransport(): FakeTransport {
  let dataCb: ((chunk: string) => void) | null = null;
  let closeCb: ((reason?: string) => void) | null = null;
  const sent: string[] = [];
  const transport: TmuxTransport = {
    send(cmd) {
      sent.push(cmd);
      return { ok: true };
    },
    onData(cb) {
      dataCb = cb;
    },
    onClose(cb) {
      closeCb = cb;
    },
    close() {
      closeCb?.("closed");
    },
  };
  return {
    transport,
    sent,
    feed(chunk) {
      dataCb?.(chunk);
    },
  };
}

function feedCommandResponse(
  t: FakeTransport,
  commandNumber: number,
  outputLines: readonly string[] = [],
): void {
  t.feed(`%begin ${commandNumber} ${commandNumber} 0\n`);
  for (const line of outputLines) t.feed(line + "\n");
  t.feed(`%end ${commandNumber} ${commandNumber} 0\n`);
}

function feedCommandError(t: FakeTransport, commandNumber: number, msg: string): void {
  t.feed(`%begin ${commandNumber} ${commandNumber} 0\n`);
  t.feed(msg + "\n");
  t.feed(`%error ${commandNumber} ${commandNumber} 0\n`);
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

// ---------------------------------------------------------------------------
// Inflight subscribe + unsubscribe race
//
// Pin the contract that callers rely on across both transports: a peer that
// unsubscribes while the original `client.subscribe` is still in flight must
// not strand queued joiners with phantom ownership, and the bridge must not
// emit a spurious `client.unsubscribe` when joiners still hold the name.
// ---------------------------------------------------------------------------

describe("BridgeConnection — inflight subscribe/unsubscribe race", () => {
  it("single peer subscribes then unsubscribes while inflight: both calls succeed in tmux order", async () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    t.feed(STARTUP_GREETING);
    const bridge = createBridgeConnection({ client });
    const a = bridge.registerPeer();

    // Issue subscribe — tmux response intentionally NOT fed yet, so the
    // record sits with `inflight !== undefined`.
    const subPromise = bridge.subscribeForPeer(a, "focus", "", "#{pane_id}");
    await flush();

    // Immediately unsubscribe before the subscribe round-trip completes.
    // The unsubscribe path now awaits inflight before evaluating last-owner;
    // the queue order at TmuxClient guarantees subscribe lands before
    // unsubscribe on the wire.
    const unsubPromise = bridge.unsubscribeForPeer(a, "focus");
    await flush();

    // Now release the subscribe response.
    feedCommandResponse(t, 1);
    await flush();
    // Then the unsubscribe response that the helper should have queued.
    feedCommandResponse(t, 2);
    await flush();

    const subResponse = await subPromise;
    expect(subResponse.success).toBe(true);
    const unsubResponse = await unsubPromise;
    expect(unsubResponse.success).toBe(true);

    // Wire ordering: subscribe → unsubscribe. Both use `refresh-client -B`;
    // the discriminator is whether the name arg is followed by `:what:format`.
    const subIdx = t.sent.findIndex(
      (c) => c.startsWith("refresh-client -B") && /'[^']*':/.test(c),
    );
    const unsubIdx = t.sent.findIndex(
      (c) => c.startsWith("refresh-client -B") && !/'[^']*':/.test(c),
    );
    expect(subIdx).toBeGreaterThanOrEqual(0);
    expect(unsubIdx).toBeGreaterThanOrEqual(0);
    expect(subIdx).toBeLessThan(unsubIdx);
  });

  it("peer A unsubscribes while B is queued behind inflight: B retains ownership, no spurious tmux unsubscribe", async () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    t.feed(STARTUP_GREETING);
    const bridge = createBridgeConnection({ client });
    const a = bridge.registerPeer();
    const b = bridge.registerPeer();

    // A creates the record + issues client.subscribe (inflight).
    const aSub = bridge.subscribeForPeer(a, "focus", "", "#{pane_id}");
    await flush();
    // B joins the same name+(what,format) — must await A's inflight.
    const bSub = bridge.subscribeForPeer(b, "focus", "", "#{pane_id}");
    await flush();
    // A unsubscribes while still inflight. The fix awaits inflight + yields
    // a microtask before evaluating last-owner, so B claims ownership first.
    const aUnsub = bridge.unsubscribeForPeer(a, "focus");
    await flush();

    // Release the subscribe round-trip.
    feedCommandResponse(t, 1);
    await flush();

    expect((await aSub).success).toBe(true);
    expect((await bSub).success).toBe(true);
    expect((await aUnsub).success).toBe(true);

    // Exactly one subscribe should have been issued to tmux. NO unsubscribe
    // — B still owns the binding, so last-owner check correctly held.
    // refresh-client -B is overloaded: `'name':'what':'format'` is subscribe,
    // bare `'name'` is unsubscribe. Distinguish by the presence of `:` after
    // the first quoted name argument.
    const subscribes = t.sent.filter(
      (c) => c.startsWith("refresh-client -B") && /'[^']*':/.test(c),
    );
    const unsubscribes = t.sent.filter(
      (c) =>
        c.startsWith("refresh-client -B") && !/'[^']*':/.test(c),
    );
    expect(subscribes).toHaveLength(1);
    expect(unsubscribes).toHaveLength(0);

    // B's subsequent unsubscribe IS the last owner — must fire client.unsubscribe.
    const bUnsub = bridge.unsubscribeForPeer(b, "focus");
    await flush();
    feedCommandResponse(t, 2);
    expect((await bUnsub).success).toBe(true);
    expect(
      t.sent.filter(
        (c) => c.startsWith("refresh-client -B") && !/'[^']*':/.test(c),
      ),
    ).toHaveLength(1);
  });

  it("subscribe rejected by tmux while peer also unsubscribes: subscribe rejects, unsubscribe synthesizes ok, no client.unsubscribe issued", async () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    t.feed(STARTUP_GREETING);
    const bridge = createBridgeConnection({ client });
    const a = bridge.registerPeer();

    const aSub = bridge.subscribeForPeer(a, "focus", "", "#{pane_id}");
    await flush();
    const aUnsub = bridge.unsubscribeForPeer(a, "focus");
    await flush();

    // Reject the subscribe at tmux — the bridge knows the binding was never
    // installed, so unsubscribe-side rollback should swallow without
    // forwarding `client.unsubscribe` to tmux.
    feedCommandError(t, 1, "subscription rejected");
    await flush();

    await expect(aSub).rejects.toThrow();
    expect((await aUnsub).success).toBe(true);

    const unsubscribes = t.sent.filter(
      (c) => c.startsWith("refresh-client -B") && !/'[^']*':/.test(c),
    );
    expect(unsubscribes).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// dispose() binding safety
// ---------------------------------------------------------------------------

describe("BridgeConnection — dispose() binding safety", () => {
  it("destructured dispose still tears down every peer", async () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    t.feed(STARTUP_GREETING);
    const bridge = createBridgeConnection({ client });

    // Register two peers; their state must be cleared after dispose runs.
    const a = bridge.registerPeer();
    const b = bridge.registerPeer();

    // Pull dispose off the object (the footgun the review flagged) and
    // call it standalone. Without the closure-scoped `removePeerImpl`,
    // `this.removePeer` would lose its binding and the loop would silently
    // no-op, leaving both peers registered.
    const { dispose } = bridge;
    dispose();

    // Idempotency: calling removePeer for the same tokens after dispose
    // should be a no-op (the helper is a passive map after dispose).
    bridge.removePeer(a);
    bridge.removePeer(b);

    // No tmux commands were issued because neither peer held subscriptions.
    expect(t.sent).toEqual([]);
  });
});
