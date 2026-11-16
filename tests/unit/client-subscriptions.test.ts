// tests/unit/client-subscriptions.test.ts
//
// `TmuxClient` carries format subscriptions as methods (`SubscriptionSurface`),
// sending exactly the commands the free `subscribeRaw`/`unsubscribe` send.

import { describe, expect, it } from "vitest";
import { TmuxClient } from "../../src/client.js";
import { subscribeRaw, unsubscribe } from "../../src/commands/index.js";
import { commandLine } from "../../src/protocol/encoder.js";
import type { TmuxTransport } from "../../src/transport/types.js";

function recordingTransport(): TmuxTransport & { readonly sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    send(command: string) {
      sent.push(command);
      return { ok: true } as const;
    },
    onData(): void {},
    onClose(): void {},
    close(): void {},
  };
}

describe("TmuxClient — subscriptions are methods of the connection", () => {
  it("subscribeRaw and unsubscribe send what the free functions send", () => {
    const viaMethods = recordingTransport();
    const a = new TmuxClient(viaMethods);
    void a.subscribeRaw("wt-x", "%3", "#{pane_width}");
    void a.unsubscribe("wt-x");

    const viaFunctions = recordingTransport();
    const b = new TmuxClient(viaFunctions);
    void subscribeRaw(b, "wt-x", "%3", "#{pane_width}");
    void unsubscribe(b, "wt-x");

    expect(viaMethods.sent).toEqual(viaFunctions.sent);
    expect(viaMethods.sent).toEqual([
      commandLine("refresh-client -B 'wt-x':'%3':'#{pane_width}'", 1),
      commandLine("refresh-client -B 'wt-x'", 2),
    ]);
  });

  it("a name tmux would split rejects, from the methods and the free functions alike", async () => {
    const sent = recordingTransport();
    const c = new TmuxClient(sent);
    const attempts = [
      () => c.subscribeRaw("a:b", "%3", "#{pane_width}"),
      () => c.unsubscribe("a b"),
      () => subscribeRaw(c, "a:b", "%3", "#{pane_width}"),
      () => unsubscribe(c, "a b"),
    ];
    for (const attempt of attempts) {
      await expect(attempt()).rejects.toBeInstanceOf(RangeError);
    }
    expect(sent.sent).toEqual([]);
  });
});
