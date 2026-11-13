// tests/unit/client-lifecycle.test.ts
// TmuxClient lifecycle invariants — tmux-lifecycle-zng.2:
//   - transport close settles every outstanding execute() promise (queued
//     and inflight) instead of leaving it to hang forever.
//   - the public 'exit' event fires exactly once per connection, even though
//     tmux's parsed %exit notification and the transport's own close signal
//     are two independent sources.
//   - 'closed' is terminal: a chunk delivered after the transport reports
//     closed must not resurrect 'ready'.

import { describe, expect, it, vi } from "vitest";

import { TmuxClient } from "../../src/client.js";
import type { TmuxTransport } from "../../src/transport/types.js";
import type { ConnectionState } from "../../src/connection-state.js";
import type { CommandResponse } from "../../src/protocol/types.js";
import {
  TmuxInvalidCommandError,
  TmuxProtocolError,
  TransportClosedError,
  TransportSendError,
} from "../../src/errors.js";
import { STARTUP_GREETING } from "./_helpers/greeting.js";

interface FakeTransport extends TmuxTransport {
  feed(chunk: string): void;
  triggerClose(reason?: string): void;
}

function createFakeTransport(): FakeTransport {
  const dataCallbacks: ((chunk: string) => void)[] = [];
  const closeCallbacks: ((reason?: string) => void)[] = [];
  return {
    send() {
      return { ok: true } as const;
    },
    onData(cb): void {
      dataCallbacks.push(cb);
    },
    onClose(cb): void {
      closeCallbacks.push(cb);
    },
    close(): void {},
    feed(chunk): void {
      dataCallbacks.forEach((cb) => cb(chunk));
    },
    triggerClose(reason): void {
      closeCallbacks.forEach((cb) => cb(reason));
    },
  };
}

describe("TmuxClient — settles every pending promise on transport close", () => {
  it("rejects a queued command (send accepted, %begin never arrived)", async () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t);

    const call = client.execute("list-windows");
    t.triggerClose("ENOENT");

    await expect(call).rejects.toBeInstanceOf(TransportClosedError);
    await expect(call).rejects.toMatchObject({ reason: "ENOENT" });
  });

  it("rejects an inflight command (%begin arrived, %end/%error never did)", async () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t);
    t.feed(STARTUP_GREETING);

    const call = client.execute("list-windows");
    t.feed("%begin 1 1 1\n");
    t.triggerClose("ENOENT");

    await expect(call).rejects.toBeInstanceOf(TransportClosedError);
  });

  it("does not disturb a command that already settled before close", async () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t);
    t.feed(STARTUP_GREETING);

    const done = client.execute("list-windows");
    t.feed("%begin 1 1 1\n%end 1 1 1\n");
    const hanging = client.execute("list-panes");
    t.triggerClose();

    await expect(done).resolves.toMatchObject({ success: true });
    await expect(hanging).rejects.toBeInstanceOf(TransportClosedError);
  });

  it("a post-close execute() rejects immediately, even against a transport that never honors close", async () => {
    // This fake's send() always returns {ok: true} regardless of close —
    // deliberately misbehaving, so the guard in execute() (not good transport
    // behavior) is what's proven to prevent the hang.
    const t = createFakeTransport();
    const client = new TmuxClient(t);
    t.triggerClose();

    await expect(client.execute("list-windows")).rejects.toBeInstanceOf(
      TransportSendError,
    );
  });
});

describe("TmuxClient — one command is one non-empty line", () => {
  it.each([
    ["new-window -c '/tmp/x\nkill-server\n'"],
    [""],
    ["   "],
    ["# comment only"],
  ])(
    "rejects %j without sending it, so correlation stays intact",
    async (bad) => {
      const t = createFakeTransport();
      const send = vi.spyOn(t, "send");
      const client = new TmuxClient(t);
      t.feed(STARTUP_GREETING);

      await expect(client.execute(bad)).rejects.toBeInstanceOf(
        TmuxInvalidCommandError,
      );
      expect(send).not.toHaveBeenCalled();

      const next = client.execute("list-windows");
      t.feed("%begin 1 1 1\n%end 1 1 1\n");
      await expect(next).resolves.toMatchObject({ success: true });
    },
  );
});

describe("TmuxClient — exactly one 'exit' event", () => {
  it("prefers tmux's %exit reason over the transport's raw close reason", () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t);
    const exits = vi.fn();
    client.on("exit", exits);

    t.feed("%exit lost tty\n");
    t.triggerClose("EPIPE");

    expect(exits).toHaveBeenCalledTimes(1);
    expect(exits).toHaveBeenCalledWith({ type: "exit", reason: "lost tty" });
    // The 'exit' event's dedup and connectionState's reason classification
    // are independent computations over the same onClose call — tmux's own
    // %exit reason won the 'exit' event above, but connectionState still
    // classifies by the transport's own raw close reason, which here still
    // carried an error (EPIPE) even though tmux exited gracefully.
    expect(client.connectionState).toEqual({
      status: "closed",
      reason: "transport-error",
    });
  });

  it("falls back to the transport's reason when tmux never sent %exit", () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t);
    const exits = vi.fn();
    client.on("exit", exits);

    t.triggerClose("ENOENT");

    expect(exits).toHaveBeenCalledTimes(1);
    expect(exits).toHaveBeenCalledWith({ type: "exit", reason: "ENOENT" });
  });

  it("fires with reason=undefined on a clean close with no %exit", () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t);
    const exits = vi.fn();
    client.on("exit", exits);

    t.triggerClose();

    expect(exits).toHaveBeenCalledTimes(1);
    expect(exits).toHaveBeenCalledWith({ type: "exit", reason: undefined });
  });

  it("a second %exit from a misbehaving transport does not re-emit", () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t);
    const exits = vi.fn();
    client.on("exit", exits);

    // SPEC guarantees tmux sends %exit at most once; this proves the guard,
    // not tmux's good behavior, is what enforces "exactly once" here.
    t.feed("%exit lost tty\n");
    t.feed("%exit duplicate\n");

    expect(exits).toHaveBeenCalledTimes(1);
    expect(exits).toHaveBeenCalledWith({ type: "exit", reason: "lost tty" });
  });
});

// tmux-server-events-6sp.sik: a failed attach's text used to be discarded and
// the caller got only `exit 1`. The wire traces are real tmux 3.8's.
describe("TmuxClient — why the connection ended reaches 'exit' and every rejection", () => {
  it.each([
    {
      ended: "with the startup command's %error text",
      wire: "%begin 1 1 0\ncan't find session: nope\n%error 1 1 0\n%exit\n",
      close: "exit 1",
      reason: "can't find session: nope",
      ready: true,
    },
    {
      ended: "with the line tmux writes for a startup command it cannot parse",
      wire: "command attach-session: unknown flag -Z\n%exit\n",
      close: "exit 1",
      reason: "command attach-session: unknown flag -Z",
      ready: false,
    },
    {
      ended: "with the transport's reason when tmux wrote nothing",
      wire: "",
      close: "no server running on /tmp/tmux-501/idle",
      reason: "no server running on /tmp/tmux-501/idle",
      ready: false,
    },
    {
      ended: "with tmux's %exit reason, not the process's exit code",
      wire: "%exit server exited unexpectedly\n",
      close: "exit 1",
      reason: "server exited unexpectedly",
      ready: false,
    },
    {
      ended: "with no reason on a bare %exit, whatever the exit code",
      wire: STARTUP_GREETING + "%exit\n",
      close: "exit 1",
      reason: undefined,
      ready: true,
    },
    {
      ended: "with no reason when the only unguarded line was run-shell's",
      wire: STARTUP_GREETING + "'false' returned 1\n%exit\n",
      close: "exit 1",
      reason: undefined,
      ready: true,
    },
    {
      ended:
        "with no reason when an unguarded line came before a startup reply that succeeded",
      wire: "Last login: Fri\n" + STARTUP_GREETING + "%exit\n",
      close: "exit 1",
      reason: undefined,
      ready: true,
    },
    {
      ended:
        "with no reason when an unguarded line came before a startup reply whose terminator was malformed",
      wire: "Last login: Fri\n%begin 1 1 0\n%end\n%exit\n",
      close: "exit 1",
      reason: undefined,
      ready: true,
    },
    {
      ended:
        "with no reason on a `-CC` stream, whose startup reply follows the DCS introducer",
      wire: "\x1bP1000p%begin 1 1 0\r\n%end 1 1 0\r\n%exit\r\n\x1b\\",
      close: "exit 1",
      reason: undefined,
      ready: true,
    },
  ])("$ended", async ({ wire, close, reason, ready }) => {
    const t = createFakeTransport();
    const client = new TmuxClient(t);
    const exits = vi.fn();
    client.on("exit", exits);
    const states: ConnectionState[] = [];
    client.on("connection-state", (ev) => states.push(ev.state));

    const pending = client.execute("list-sessions");
    t.feed(wire);
    t.triggerClose(close);

    expect(exits).toHaveBeenCalledTimes(1);
    expect(exits).toHaveBeenCalledWith({ type: "exit", reason });
    await expect(pending).rejects.toBeInstanceOf(TransportClosedError);
    await expect(pending).rejects.toMatchObject({ reason });
    expect(states.some((s) => s.status === "ready")).toBe(ready);

    const late = client.execute("list-sessions");
    await expect(late).rejects.toBeInstanceOf(TransportSendError);
    await expect(late).rejects.toMatchObject({
      reason:
        reason === undefined
          ? "transport closed"
          : `transport closed: ${reason}`,
    });
  });

  it("a command issued before the startup reply gets its own reply, not the startup one", async () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t);

    const call = client.execute("list-sessions");
    t.feed("%begin 1 1 0\nstartup output\n%end 1 1 0\n");
    t.feed("%begin 2 2 1\n$0 main\n%end 2 2 1\n");

    await expect(call).resolves.toMatchObject({ output: ["$0 main"] });
  });
});

// tmux-server-events-6sp.lgu: tmux writes a guard block for every command it
// runs for the client and marks with flags 1 the ones that answer a line the
// client wrote. A block marked 0 used to take the oldest caller's entry, so
// every reply after it went to the wrong caller.
describe("TmuxClient — a reply to a command no caller wrote is an 'unsolicited-response'", () => {
  function connect(): {
    t: FakeTransport;
    client: TmuxClient;
    unsolicited: CommandResponse[];
  } {
    const t = createFakeTransport();
    const client = new TmuxClient(t);
    const unsolicited: CommandResponse[] = [];
    client.on("unsolicited-response", (ev) => unsolicited.push(ev.response));
    return { t, client, unsolicited };
  }

  it("a later command of the startup list takes no caller's reply, and its failure is not why the connection ended", async () => {
    const { t, client, unsolicited } = connect();
    const exits = vi.fn();
    client.on("exit", exits);

    const first = client.execute("list-sessions");
    const second = client.execute("list-windows");
    // tmux -C attach-session -t =a \; kill-session -t =nope
    t.feed("%begin 7 1 0\n%end 7 1 0\n");
    t.feed("%begin 7 2 0\ncan't find session: nope\n%error 7 2 0\n");
    t.feed("%begin 7 3 1\n$0 a\n%end 7 3 1\n");
    t.feed("%begin 7 4 1\n@0 zsh\n%end 7 4 1\n");

    await expect(first).resolves.toMatchObject({ output: ["$0 a"] });
    await expect(second).resolves.toMatchObject({ output: ["@0 zsh"] });
    expect(unsolicited).toEqual([
      { commandNumber: 1, timestamp: 7, output: [], success: true },
      {
        commandNumber: 2,
        timestamp: 7,
        output: ["can't find session: nope"],
        success: false,
      },
    ]);

    t.feed("%exit\n");
    t.triggerClose("exit 1");
    expect(exits).toHaveBeenCalledWith({ type: "exit", reason: undefined });
  });

  it("the startup command's own failed reply is announced as well as ending the connection", () => {
    const { t, unsolicited } = connect();

    t.feed("%begin 7 1 0\ncan't find session: nope\n%error 7 1 0\n");

    expect(unsolicited).toEqual([
      {
        commandNumber: 1,
        timestamp: 7,
        output: ["can't find session: nope"],
        success: false,
      },
    ]);
  });

  it("an after-hook's block between two callers' replies takes neither", async () => {
    const { t, client, unsolicited } = connect();
    t.feed(STARTUP_GREETING);
    unsolicited.length = 0;

    const rename = client.execute("rename-window x");
    const show = client.execute("display-message -p ok");
    t.feed("%begin 7 5 1\n%end 7 5 1\n");
    t.feed("%begin 7 6 0\nhook ran\n%end 7 6 0\n");
    t.feed("%begin 7 7 1\nok\n%end 7 7 1\n");

    await expect(rename).resolves.toMatchObject({ output: [] });
    await expect(show).resolves.toMatchObject({ output: ["ok"] });
    expect(unsolicited).toEqual([
      { commandNumber: 6, timestamp: 7, output: ["hook ran"], success: true },
    ]);
  });

  it("a block the transport closed inside is not announced", () => {
    const { t, unsolicited } = connect();
    t.feed(STARTUP_GREETING);
    unsolicited.length = 0;

    t.feed("%begin 7 2 0\nhalf a reply\n");
    t.triggerClose();

    expect(unsolicited).toEqual([]);
  });
});

describe("TmuxClient — 'closed' is terminal", () => {
  it("a chunk delivered after close does not resurrect 'ready'", () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t);
    const states: ConnectionState[] = [];
    client.on("connection-state", (ev) => states.push(ev.state));

    t.feed("%begin 1 1 0\n%end 1 1 0\n");
    t.triggerClose();
    t.feed("%begin 2 2 0\n%end 2 2 0\n");

    expect(client.connectionState).toEqual({
      status: "closed",
      reason: "exit",
    });
    expect(states.at(-1)).toEqual({ status: "closed", reason: "exit" });
  });

  it("a %exit that arrives after transport close does not re-emit 'exit'", () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t);
    const exits = vi.fn();
    client.on("exit", exits);

    // Close arrives first (tmux never got to send %exit) and synthesizes one.
    t.triggerClose("ENOENT");
    // A late chunk containing %exit — a delayed/chaotic-delivery race — must
    // not dispatch through handleMessage at all once closed is terminal.
    t.feed("%exit lost tty\n");

    expect(exits).toHaveBeenCalledTimes(1);
    expect(exits).toHaveBeenCalledWith({ type: "exit", reason: "ENOENT" });
  });
});

// tmux-lifecycle-zng.4: a truncated %end/%error mid-block used to wedge the
// parser in output-routing mode for the rest of the connection (the parser's
// `msg === null` branch skipped the malformed terminator without resetting
// activeCommandNumber). The parser now force-closes the block and surfaces a
// `protocol-error`; this suite proves TmuxClient settles the affected command
// with it and that correlation for every command after it proceeds normally.
describe("TmuxClient — malformed guard terminator settles instead of wedging", () => {
  it("rejects the inflight command with TmuxProtocolError and keeps routing after it", async () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t);
    t.feed(STARTUP_GREETING);

    const protocolErrors = vi.fn();
    client.on("protocol-error", protocolErrors);
    const notifications = vi.fn();
    client.on("window-add", notifications);

    const call = client.execute("list-windows");
    t.feed("%begin 5 1 1\n");
    // Output tmux produced before the wire corrupted — this must survive on
    // the rejection, not be discarded (the diagnostic value TmuxCommandError
    // already preserves for a well-formed %error).
    t.feed("@2 editor\n");
    // Truncated %end: only 2 of the 3 required fields (SPEC.md §5).
    t.feed("%end 5 1\n");
    // Real traffic after the malformed terminator — must route as a
    // notification, not misroute as this command's output.
    t.feed("%window-add @9\n");

    await expect(call).rejects.toBeInstanceOf(TmuxProtocolError);
    await expect(call).rejects.toMatchObject({
      commandNumber: 1,
      line: "%end 5 1",
      output: ["@2 editor"],
    });
    expect(protocolErrors).toHaveBeenCalledTimes(1);
    expect(protocolErrors).toHaveBeenCalledWith({
      type: "protocol-error",
      commandNumber: 1,
      line: "%end 5 1",
    });
    expect(notifications).toHaveBeenCalledTimes(1);
    expect(notifications).toHaveBeenCalledWith({
      type: "window-add",
      windowId: 9,
    });

    // The connection is not wedged: a subsequent command still correlates.
    const second = client.execute("list-panes");
    t.feed("%begin 6 2 1\n%end 6 2 1\n");
    await expect(second).resolves.toMatchObject({ success: true });
  });

  it("a malformed terminator on the startup greeting itself still reaches 'ready'", () => {
    // The startup reply settles like any other block, so every subsequent
    // guard block correlates normally.
    const t = createFakeTransport();
    const client = new TmuxClient(t);
    const states: ConnectionState[] = [];
    client.on("connection-state", (ev) => states.push(ev.state));
    const protocolErrors = vi.fn();
    client.on("protocol-error", protocolErrors);
    const unsolicited = vi.fn();
    client.on("unsolicited-response", unsolicited);

    t.feed("%begin 0 0 0\n");
    t.feed("%end 0 0\n"); // truncated greeting terminator

    expect(client.connectionState).toEqual({ status: "ready" });
    // No response to announce: 'protocol-error' is the report.
    expect(unsolicited).not.toHaveBeenCalled();
    expect(states).toContainEqual({ status: "ready" });
    expect(protocolErrors).toHaveBeenCalledWith({
      type: "protocol-error",
      commandNumber: 0,
      line: "%end 0 0",
    });

    // The connection correlates normally from here on.
    const call = client.execute("list-windows");
    t.feed("%begin 1 1 1\n%end 1 1 1\n");
    return expect(call).resolves.toMatchObject({ success: true });
  });
});
