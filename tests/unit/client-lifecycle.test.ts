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
import {
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
    t.feed("%begin 1 1 0\n");
    t.triggerClose("ENOENT");

    await expect(call).rejects.toBeInstanceOf(TransportClosedError);
  });

  it("does not disturb a command that already settled before close", async () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t);
    t.feed(STARTUP_GREETING);

    const done = client.execute("list-windows");
    t.feed("%begin 1 1 0\n%end 1 1 0\n");
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
    t.feed("%begin 5 1 0\n");
    // Truncated %end: only 2 of the 3 required fields (SPEC.md §5).
    t.feed("%end 5 1\n");
    // Real traffic after the malformed terminator — must route as a
    // notification, not misroute as this command's output.
    t.feed("%window-add @9\n");

    await expect(call).rejects.toBeInstanceOf(TmuxProtocolError);
    await expect(call).rejects.toMatchObject({
      commandNumber: 1,
      line: "%end 5 1",
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
    t.feed("%begin 6 2 0\n%end 6 2 0\n");
    await expect(second).resolves.toMatchObject({ success: true });
  });

  it("a malformed terminator on the startup greeting itself still reaches 'ready'", () => {
    // Mirrors the existing %error-during-greeting behavior (see
    // TmuxClient.handleMessage): there is no pending entry for the greeting,
    // but the phase must still close so every subsequent guard block
    // correlates normally.
    const t = createFakeTransport();
    const client = new TmuxClient(t);
    const states: ConnectionState[] = [];
    client.on("connection-state", (ev) => states.push(ev.state));
    const protocolErrors = vi.fn();
    client.on("protocol-error", protocolErrors);

    t.feed("%begin 0 0 1\n");
    t.feed("%end 0 0\n"); // truncated greeting terminator

    expect(client.connectionState).toEqual({ status: "ready" });
    expect(states).toContainEqual({ status: "ready" });
    expect(protocolErrors).toHaveBeenCalledWith({
      type: "protocol-error",
      commandNumber: 0,
      line: "%end 0 0",
    });

    // The connection correlates normally from here on.
    const call = client.execute("list-windows");
    t.feed("%begin 1 1 0\n%end 1 1 0\n");
    return expect(call).resolves.toMatchObject({ success: true });
  });
});

describe("TmuxClient — 'closed' is terminal", () => {
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
