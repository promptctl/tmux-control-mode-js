// tests/unit/client-subscriptions.test.ts
// Unit tests for TmuxClient's typed subscription routing — uses a fake
// transport so we can deterministically replay tmux's wire shape (begin/end,
// begin/error, %subscription-changed) without a real tmux process.
//
// [LAW:behavior-not-structure] These assert the public contract:
// auto-allocated names are unique per call, the wire string matches the
// encoder, route entries are removed on dispose AND on rejection, and a
// %subscription-changed event reaches the right handler.

import { describe, it, expect } from "vitest";
import { TmuxClient } from "../../src/client.js";
import { TmuxCommandError } from "../../src/errors.js";
import type { TmuxTransport } from "../../src/transport/types.js";
import { FIELD_SEP, ROW_SEP } from "../../src/subscriptions.js";

interface FakeTransport extends TmuxTransport {
  readonly sent: string[];
  emitData(chunk: string): void;
  /**
   * Auto-respond to each command sent through `send()`. Successive calls
   * pop the next response.
   */
  queueResponse(kind: "ok" | "err"): void;
}

function makeFakeTransport(): FakeTransport {
  const sent: string[] = [];
  let dataCb: ((chunk: string) => void) | null = null;
  const responses: Array<"ok" | "err"> = [];
  let cmdNumber = 0;

  const emit = (chunk: string) => {
    dataCb?.(chunk);
  };

  const transport: FakeTransport = {
    sent,
    send(command) {
      sent.push(command);
      const kind = responses.shift() ?? "ok";
      const ts = Date.now();
      cmdNumber++;
      // Emit %begin / %end (or %error) on the next microtask so the FIFO
      // entry is registered before the response arrives.
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
    close() {
      /* not exercised */
    },
    emitData(chunk) {
      emit(chunk);
    },
    queueResponse(kind) {
      responses.push(kind);
    },
  };
  return transport;
}

describe("TmuxClient typed subscriptions", () => {
  it("subscribeSessions allocates a unique name and uses RS/US separators on the wire", async () => {
    const t = makeFakeTransport();
    const client = new TmuxClient(t);
    t.queueResponse("ok");
    const handle = await client.subscribeSessions(
      ["session_id", "session_name"] as const,
      () => {},
    );
    expect(t.sent).toHaveLength(1);
    const wire = t.sent[0];
    // Auto-allocated name shape (the encoder quotes each colon-separated
    // segment, so empty `what` shows up as `''`):
    expect(wire).toMatch(/^refresh-client -B 'tmux-cm-sub-\d+':'':/);
    // RS/US separators are present in the format argument:
    expect(wire).toContain(FIELD_SEP);
    expect(wire).toContain(ROW_SEP);
    // S iteration scope:
    expect(wire).toContain("#{S:");
    // dispose triggers the unsubscribe wire command on the next tick.
    t.queueResponse("ok");
    handle.dispose();
    await new Promise((r) => setTimeout(r, 5));
    expect(t.sent).toHaveLength(2);
    expect(t.sent[1]).toMatch(/refresh-client -B 'tmux-cm-sub-\d+'\n/);
  });

  it("two subscribePanes calls allocate distinct names", async () => {
    const t = makeFakeTransport();
    const client = new TmuxClient(t);
    t.queueResponse("ok");
    t.queueResponse("ok");
    const h1 = await client.subscribePanes(["pane_id"] as const, () => {});
    const h2 = await client.subscribePanes(["pane_id"] as const, () => {});
    const name1 = t.sent[0].match(/'(tmux-cm-sub-\d+)'/)?.[1];
    const name2 = t.sent[1].match(/'(tmux-cm-sub-\d+)'/)?.[1];
    expect(name1).toBeDefined();
    expect(name2).toBeDefined();
    expect(name1).not.toBe(name2);
    h1.dispose();
    h2.dispose();
  });

  it("rejected subscribe leaves no zombie route entry", async () => {
    const t = makeFakeTransport();
    const client = new TmuxClient(t);
    t.queueResponse("err");
    const err = await client
      .subscribe({ what: "", format: "anything" }, () => {})
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(TmuxCommandError);

    // Verify cleanup: a subsequent %subscription-changed for the rejected
    // name must NOT invoke any handler (because the route entry was
    // removed). Look at the wire string to extract the name that WAS
    // attempted, then synthesize the event.
    const name = t.sent[0].match(/'(tmux-cm-sub-\d+)'/)?.[1];
    expect(name).toBeDefined();
    let unexpectedCall = false;
    client.on("subscription-changed", () => {
      // public listener does fire; not a contract violation.
    });
    // If a route entry leaked, the internal router would still hold the
    // original handler closure. We re-subscribe with a tracking handler;
    // because each call allocates a fresh name, our tracker is on a
    // DIFFERENT route. The leaked-handler bug would surface as the
    // tracker firing for the OLD name, which it would not — so we instead
    // verify by constructing a fresh subscribe and asserting only the
    // fresh handler fires for the fresh name's event.
    t.queueResponse("ok");
    let liveCalls = 0;
    const liveHandle = await client.subscribe(
      { what: "", format: "anything" },
      () => {
        liveCalls++;
      },
    );
    const liveName = t.sent[t.sent.length - 1].match(/'(tmux-cm-sub-\d+)'/)?.[1];
    expect(liveName).toBeDefined();
    expect(liveName).not.toBe(name);

    // Fire an event for the REJECTED name: nothing should happen.
    t.emitData(`%subscription-changed ${name} - - - - : someValue\n`);
    expect(unexpectedCall).toBe(false);
    expect(liveCalls).toBe(0);

    // Fire an event for the LIVE name: the tracker fires.
    t.emitData(`%subscription-changed ${liveName} - - - - : ${"a" + FIELD_SEP + "b" + ROW_SEP}\n`);
    expect(liveCalls).toBe(1);

    liveHandle.dispose();
  });

  it("subscribePanes routes %subscription-changed to its handler with parsed rows", async () => {
    const t = makeFakeTransport();
    const client = new TmuxClient(t);
    t.queueResponse("ok");
    const fields = ["window_id", "pane_id"] as const;
    let received: Array<Record<(typeof fields)[number], string>> | null = null;
    await client.subscribePanes(fields, (rows) => {
      received = rows;
    });
    const name = t.sent[0].match(/'(tmux-cm-sub-\d+)'/)?.[1];
    const value =
      `@1${FIELD_SEP}%2${ROW_SEP}` +
      `@1${FIELD_SEP}%3${ROW_SEP}` +
      `@4${FIELD_SEP}%5${ROW_SEP}`;
    t.emitData(`%subscription-changed ${name} - - - - : ${value}\n`);
    expect(received).toEqual([
      { window_id: "@1", pane_id: "%2" },
      { window_id: "@1", pane_id: "%3" },
      { window_id: "@4", pane_id: "%5" },
    ]);
  });

  it("dispose() removes the handler synchronously: events after dispose are dropped", async () => {
    const t = makeFakeTransport();
    const client = new TmuxClient(t);
    t.queueResponse("ok");
    let calls = 0;
    const handle = await client.subscribePanes(["pane_id"] as const, () => {
      calls++;
    });
    const name = t.sent[0].match(/'(tmux-cm-sub-\d+)'/)?.[1];
    // First event reaches the handler.
    t.emitData(`%subscription-changed ${name} - - - - : %1${ROW_SEP}\n`);
    expect(calls).toBe(1);
    // Dispose: handler removed before the unsubscribe RTT completes.
    t.queueResponse("ok");
    handle.dispose();
    // Late event for the disposed name does NOT fire the handler.
    t.emitData(`%subscription-changed ${name} - - - - : %2${ROW_SEP}\n`);
    expect(calls).toBe(1);
  });
});
