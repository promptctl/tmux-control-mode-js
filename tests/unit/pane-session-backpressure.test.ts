// tests/unit/pane-session-backpressure.test.ts
// Unit tests for PaneSession's per-pane backpressure surface — pause/resume,
// tmux %pause/%continue reflection, and sink-stall auto-pause/resume.
//
// These tests run against a hand-rolled fake PaneSessionClient so they
// exercise the dataflow without needing a tmux process. Round-tripping
// against real tmux is covered in tests/integration/pane-session.test.ts.

import { describe, it, expect } from "vitest";
import {
  PaneSession,
  type PaneSessionClient,
  type PauseReason,
  type TerminalSink,
} from "../../src/pane-session.js";
import {
  PaneAction,
  type CommandResponse,
  type ContinueMessage,
  type ExtendedOutputMessage,
  type OutputMessage,
  type PauseMessage,
} from "../../src/protocol/types.js";

// ---------------------------------------------------------------------------
// Fake client — captures setPaneAction calls and lets the test fire fake
// pause/continue notifications and output events into PaneSession.
// ---------------------------------------------------------------------------

interface FakeClient extends PaneSessionClient {
  emitPause(paneId: number): void;
  emitContinue(paneId: number): void;
  emitOutput(paneId: number, data: Uint8Array): void;
  readonly actions: { paneId: number; action: PaneAction }[];
  readonly executes: string[];
}

function createFakeClient(): FakeClient {
  const outputHandlers = new Set<(msg: OutputMessage) => void>();
  const extendedHandlers = new Set<(msg: ExtendedOutputMessage) => void>();
  const pauseHandlers = new Set<(msg: PauseMessage) => void>();
  const continueHandlers = new Set<(msg: ContinueMessage) => void>();
  const actions: { paneId: number; action: PaneAction }[] = [];
  const executes: string[] = [];

  const ok = (): CommandResponse => ({
    commandNumber: 0,
    timestamp: Date.now(),
    output: [],
    success: true,
  });

  const client = {
    on(event: string, handler: unknown): void {
      if (event === "output") outputHandlers.add(handler as never);
      else if (event === "extended-output") extendedHandlers.add(handler as never);
      else if (event === "pause") pauseHandlers.add(handler as never);
      else if (event === "continue") continueHandlers.add(handler as never);
    },
    off(event: string, handler: unknown): void {
      if (event === "output") outputHandlers.delete(handler as never);
      else if (event === "extended-output") extendedHandlers.delete(handler as never);
      else if (event === "pause") pauseHandlers.delete(handler as never);
      else if (event === "continue") continueHandlers.delete(handler as never);
    },
    execute(command: string): Promise<CommandResponse> {
      executes.push(command);
      // capture-pane and display-message are issued by attach()'s seed.
      // Return shaped responses so the seed completes; callers that don't
      // use attach() never see this path.
      if (command.startsWith("capture-pane")) {
        return Promise.resolve({ ...ok(), output: [""] });
      }
      if (command.startsWith("display-message")) {
        return Promise.resolve({ ...ok(), output: ["0;0"] });
      }
      return Promise.resolve(ok());
    },
    sendKeys(): Promise<CommandResponse> {
      return Promise.resolve(ok());
    },
    setPaneAction(paneId: number, action: PaneAction): Promise<CommandResponse> {
      actions.push({ paneId, action });
      return Promise.resolve(ok());
    },
    actions,
    executes,
    emitPause(paneId: number): void {
      const msg: PauseMessage = { type: "pause", paneId };
      for (const h of pauseHandlers) h(msg);
    },
    emitContinue(paneId: number): void {
      const msg: ContinueMessage = { type: "continue", paneId };
      for (const h of continueHandlers) h(msg);
    },
    emitOutput(paneId: number, data: Uint8Array): void {
      const msg: OutputMessage = { type: "output", paneId, data };
      for (const h of outputHandlers) h(msg);
    },
  };

  return client;
}

// ---------------------------------------------------------------------------
// Sinks
// ---------------------------------------------------------------------------

interface RecordingSink extends TerminalSink {
  readonly chunks: Uint8Array[];
}

function syncSink(): RecordingSink {
  const chunks: Uint8Array[] = [];
  return {
    chunks,
    write(bytes) {
      chunks.push(bytes);
    },
    resize() {},
    onData() {
      return { dispose() {} };
    },
    focus() {},
  };
}

interface AsyncSink extends RecordingSink {
  /** Number of chunks not yet acked. */
  readonly outstanding: () => number;
  /** Resolve all currently outstanding async writes. */
  drain(): void;
}

function asyncSink(): AsyncSink {
  const chunks: Uint8Array[] = [];
  const pending: (() => void)[] = [];
  return {
    chunks,
    write(bytes) {
      chunks.push(bytes);
    },
    writeAsync(bytes) {
      chunks.push(bytes);
      return new Promise<void>((resolve) => pending.push(resolve));
    },
    resize() {},
    onData() {
      return { dispose() {} };
    },
    focus() {},
    outstanding() {
      return pending.length;
    },
    drain() {
      while (pending.length > 0) {
        const r = pending.shift();
        r?.();
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PANE = 7;

async function flushMicrotasks(): Promise<void> {
  // Drain microtasks twice — `then` fan-out from sink writeAsync can need
  // an extra tick before the listeners observe the final state.
  await Promise.resolve();
  await Promise.resolve();
}

async function attach(
  client: PaneSessionClient,
  sink: TerminalSink,
  options?: {
    stallHighChunks?: number;
    stallLowChunks?: number;
  },
): Promise<PaneSession> {
  const session = new PaneSession({
    client,
    paneId: PANE,
    sink,
    ...options,
  });
  await session.attach();
  return session;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PaneSession backpressure", () => {
  it("consumer pause/resume fires events and sends wire commands", async () => {
    const client = createFakeClient();
    const sink = syncSink();
    const session = await attach(client, sink);

    const pausedReasons: PauseReason[] = [];
    let resumedCount = 0;
    session.on("paused", ({ reason }) => pausedReasons.push(reason));
    session.on("resumed", () => {
      resumedCount += 1;
    });

    expect(session.isPaused).toBe(false);
    session.pause();
    expect(session.isPaused).toBe(true);
    expect(pausedReasons).toEqual(["consumer"]);
    expect(client.actions).toEqual([{ paneId: PANE, action: PaneAction.Pause }]);

    session.resume();
    expect(session.isPaused).toBe(false);
    expect(resumedCount).toBe(1);
    expect(client.actions).toEqual([
      { paneId: PANE, action: PaneAction.Pause },
      { paneId: PANE, action: PaneAction.Continue },
    ]);

    session.dispose();
  });

  it("pause()/resume() are idempotent", async () => {
    const client = createFakeClient();
    const sink = syncSink();
    const session = await attach(client, sink);

    let pauseCount = 0;
    let resumeCount = 0;
    session.on("paused", () => {
      pauseCount += 1;
    });
    session.on("resumed", () => {
      resumeCount += 1;
    });

    session.pause();
    session.pause();
    session.pause();
    expect(pauseCount).toBe(1);
    expect(client.actions).toHaveLength(1);

    session.resume();
    session.resume();
    expect(resumeCount).toBe(1);
    expect(client.actions).toHaveLength(2);

    session.dispose();
  });

  it("tmux %pause emits paused with reason='tmux' and does NOT echo wire command", async () => {
    const client = createFakeClient();
    const sink = syncSink();
    const session = await attach(client, sink);

    const reasons: PauseReason[] = [];
    session.on("paused", ({ reason }) => reasons.push(reason));

    client.emitPause(PANE);
    expect(reasons).toEqual(["tmux"]);
    // Critical: the wire command was NOT echoed back. tmux already paused;
    // sending refresh-client -A %X:pause again would be redundant.
    expect(client.actions).toEqual([]);

    client.emitContinue(PANE);
    expect(session.isPaused).toBe(false);
    // Nor on the resume side — tmux continued on its own.
    expect(client.actions).toEqual([]);

    session.dispose();
  });

  it("tmux pause for a different pane id is ignored", async () => {
    const client = createFakeClient();
    const sink = syncSink();
    const session = await attach(client, sink);

    let count = 0;
    session.on("paused", () => {
      count += 1;
    });

    client.emitPause(PANE + 1);
    client.emitPause(PANE - 1);
    expect(count).toBe(0);
    expect(session.isPaused).toBe(false);

    session.dispose();
  });

  it("consumer pause + tmux %continue resumes (and emits 'resumed')", async () => {
    const client = createFakeClient();
    const sink = syncSink();
    const session = await attach(client, sink);

    let resumed = 0;
    session.on("resumed", () => {
      resumed += 1;
    });

    session.pause();
    expect(session.isPaused).toBe(true);
    client.emitContinue(PANE);
    expect(session.isPaused).toBe(false);
    expect(resumed).toBe(1);

    session.dispose();
  });

  it("auto-pauses on sink-stall when outstanding chunks exceed high water", async () => {
    const client = createFakeClient();
    const sink = asyncSink();
    const session = await attach(client, sink, {
      stallHighChunks: 5,
      stallLowChunks: 2,
    });

    const reasons: PauseReason[] = [];
    session.on("paused", ({ reason }) => reasons.push(reason));

    // Pump 4 chunks — below the high water mark; no pause.
    for (let i = 0; i < 4; i++) {
      client.emitOutput(PANE, new Uint8Array([i]));
    }
    expect(reasons).toEqual([]);

    // The 5th chunk crosses the threshold.
    client.emitOutput(PANE, new Uint8Array([99]));
    expect(reasons).toEqual(["sink-stall"]);
    expect(client.actions).toEqual([{ paneId: PANE, action: PaneAction.Pause }]);

    session.dispose();
  });

  it("auto-resumes after sink-stall when outstanding chunks drain below low water", async () => {
    const client = createFakeClient();
    const sink = asyncSink();
    const session = await attach(client, sink, {
      stallHighChunks: 5,
      stallLowChunks: 2,
    });

    let resumed = 0;
    session.on("resumed", () => {
      resumed += 1;
    });

    // Trigger stall.
    for (let i = 0; i < 5; i++) {
      client.emitOutput(PANE, new Uint8Array([i]));
    }
    expect(session.isPaused).toBe(true);

    // Drain — all 5 promises resolve, outstandingChunks drops to 0
    // (≤ stallLowChunks=2), auto-resume fires.
    sink.drain();
    await flushMicrotasks();
    expect(session.isPaused).toBe(false);
    expect(resumed).toBe(1);
    expect(client.actions).toEqual([
      { paneId: PANE, action: PaneAction.Pause },
      { paneId: PANE, action: PaneAction.Continue },
    ]);

    session.dispose();
  });

  it("consumer pause is NOT cleared by sink drain (auto-resume only fires for sink-stall reason)", async () => {
    const client = createFakeClient();
    const sink = asyncSink();
    const session = await attach(client, sink, {
      stallHighChunks: 5,
      stallLowChunks: 2,
    });

    let resumed = 0;
    session.on("resumed", () => {
      resumed += 1;
    });

    // Consumer pauses first — this is the active reason.
    session.pause();
    expect(session.isPaused).toBe(true);

    // Bytes pile up while paused (PaneSession still routes them through
    // writeAsync from tmux's perspective there's no flow until refresh-client
    // reaches tmux; but for this unit test we model the race where some
    // output already crossed the wire).
    for (let i = 0; i < 8; i++) {
      client.emitOutput(PANE, new Uint8Array([i]));
    }

    // Drain — outstanding hits 0. Auto-resume MUST NOT fire because the
    // consumer pause is the active reason; only the consumer can clear it.
    sink.drain();
    await flushMicrotasks();
    expect(session.isPaused).toBe(true);
    expect(resumed).toBe(0);
    expect(client.actions).toEqual([{ paneId: PANE, action: PaneAction.Pause }]);

    session.resume();
    expect(session.isPaused).toBe(false);
    expect(resumed).toBe(1);

    session.dispose();
  });

  it("sinks without writeAsync skip stall accounting entirely", async () => {
    const client = createFakeClient();
    const sink = syncSink();
    // Set absurdly low stall threshold; without writeAsync it should never trip.
    const session = await attach(client, sink, {
      stallHighChunks: 1,
      stallLowChunks: 0,
    });

    let pausedCount = 0;
    session.on("paused", () => {
      pausedCount += 1;
    });

    for (let i = 0; i < 100; i++) {
      client.emitOutput(PANE, new Uint8Array([i]));
    }

    expect(pausedCount).toBe(0);
    expect(client.actions).toEqual([]);
    // Seed itself writes 2 chunks (snapshot + cursor restore) before live
    // bytes start; the 100 emitOutput calls land on top of that.
    const liveChunks = sink.chunks.length - 2;
    expect(liveChunks).toBe(100);

    session.dispose();
  });

  it("dispose halts pending writeAsync acks from mutating state", async () => {
    const client = createFakeClient();
    const sink = asyncSink();
    const session = await attach(client, sink, {
      stallHighChunks: 5,
      stallLowChunks: 2,
    });

    let resumed = 0;
    session.on("resumed", () => {
      resumed += 1;
    });

    // Trip the stall.
    for (let i = 0; i < 5; i++) {
      client.emitOutput(PANE, new Uint8Array([i]));
    }
    expect(session.isPaused).toBe(true);

    session.dispose();

    // Now drain — the late acks must not fire 'resumed' on a disposed session.
    sink.drain();
    await flushMicrotasks();
    expect(resumed).toBe(0);
  });
});
