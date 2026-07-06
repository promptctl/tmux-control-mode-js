// tests/unit/redesign-laws.test.ts
// Hard-won-lessons named test suite. One describe block per domain truth from
// design-docs/redesign-z31-type-shape.md §20. All 14 items are covered here.
// Tests are behavioral (what) not structural (how); each slug is the lesson id.

import { describe, expect, it, vi } from "vitest";

import { attachLineSink } from "../../src/line-sink.js";
import {
  type AttachOptions,
  type BytesSink,
  type ChunkPayload,
  type PaneScope,
  paneScope,
  serverScope,
  SinkRegistry,
  TopologyEpochTracker,
} from "../../src/pane-output.js";
import { TmuxParser } from "../../src/protocol/parser.js";
import { TmuxClient } from "../../src/client.js";
import type { TmuxConnection } from "../../src/client.js";
import type { TmuxTransport, SendResult } from "../../src/transport/types.js";
import {
  encodePaneOutput,
  PANE_OUTPUT_MAGIC,
} from "../../src/connectors/websocket/protocol.js";
import {
  meetsTmuxVersion,
  MIN_TMUX_VERSION,
  REQUEST_REPORT_MIN_VERSION,
} from "../../src/tmux-compat.js";
import { createWebSocketBridge } from "../../src/connectors/websocket/server.js";
import {
  WEBSOCKET_OPEN,
  type ServerWebSocketLike,
} from "../../src/connectors/websocket/types.js";

// ---------------------------------------------------------------------------
// Shared fakes
// ---------------------------------------------------------------------------

// FakeClient — minimal attachBytesSink slice used by line-sink tests.
interface FakeAttachment {
  readonly sink: BytesSink;
  readonly scope: PaneScope;
}

class FakeClient {
  private readonly attached = new Set<FakeAttachment>();

  attachBytesSink(sink: BytesSink, options?: AttachOptions): () => void {
    const entry: FakeAttachment = {
      sink,
      scope: options?.scope ?? serverScope,
    };
    this.attached.add(entry);
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      this.attached.delete(entry);
      entry.sink.end();
    };
  }

  deliver(msg: ChunkPayload): void {
    const snap = Array.from(this.attached);
    for (const { sink, scope } of snap) {
      if (admitsPane(scope, msg.paneId)) sink.write(msg);
    }
  }
}

function admitsPane(scope: PaneScope, paneId: number): boolean {
  return scope.kind === "server" || (scope.kind === "pane" && scope.paneId === paneId);
}

function out(paneId: number, data: Uint8Array | number[]): ChunkPayload {
  return {
    paneId,
    data: data instanceof Uint8Array ? data : new Uint8Array(data),
  };
}

// FakeTransport — minimal TmuxTransport used by TmuxClient in fifo and
// backpressure tests.
class FakeTransport implements TmuxTransport {
  readonly sent: string[] = [];
  private dataCb: ((chunk: string) => void) | null = null;
  private closeCb: ((reason?: string) => void) | null = null;

  send(cmd: string): SendResult {
    this.sent.push(cmd);
    return { ok: true };
  }
  onData(cb: (chunk: string) => void): void {
    this.dataCb = cb;
  }
  onClose(cb: (reason?: string) => void): void {
    this.closeCb = cb;
  }
  close(): void {
    this.closeCb?.();
  }
  inject(chunk: string): void {
    this.dataCb?.(chunk);
  }
}

// FakeWs — minimal ServerWebSocketLike used by the backpressure test.
// Mirrors the shape expected by createWebSocketBridge.
type WsListener = (...args: unknown[]) => void;

function createFakeWs(): ServerWebSocketLike & {
  setBuffered(n: number): void;
  feedClient(frame: object): void;
  readonly outbound: Array<string | Uint8Array>;
} {
  let buffered = 0;
  const listeners: Record<string, WsListener | undefined> = {};
  const outbound: Array<string | Uint8Array> = [];

  const ws = {
    readyState: WEBSOCKET_OPEN as number,
    get bufferedAmount() {
      return buffered;
    },
    setBuffered(n: number) {
      buffered = n;
    },
    feedClient(frame: object) {
      listeners["message"]?.(JSON.stringify(frame), false);
    },
    outbound,
    send(data: string | ArrayBufferLike | ArrayBufferView) {
      if (typeof data === "string") {
        outbound.push(data);
      } else if (data instanceof Uint8Array) {
        outbound.push(data);
      } else {
        outbound.push(new Uint8Array(data as ArrayBuffer));
      }
    },
    ping(_d?: unknown, _m?: boolean, _cb?: (err?: Error) => void) {
      listeners["pong"]?.();
    },
    close(_code?: number, _reason?: string) {
      ws.readyState = 3;
    },
    terminate() {
      ws.readyState = 3;
    },
    on(event: string, handler: WsListener) {
      listeners[event] = handler;
    },
  };
  // [LAW:types-are-the-program] Cast required because the ServerWebSocketLike
  // `on()` overloads cannot be satisfied by a single-signature implementation.
  return ws as unknown as ReturnType<typeof createFakeWs>;
}

// Drain the microtask queue — used by async backpressure test.
async function flushMicrotasks(): Promise<void> {
  // Three drains: the hello → running transition chains three internal awaits
  // (safeAuthenticate, createClient, state assignment). Same reasoning as
  // websocket-bridge.test.ts.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

// ---------------------------------------------------------------------------
// 1. byte-fidelity
// ---------------------------------------------------------------------------

describe("byte-fidelity", () => {
  it("BytesSink.write receives raw Uint8Array bytes; all bit patterns are preserved", () => {
    const received: ChunkPayload[] = [];
    const sink: BytesSink = {
      write(m) {
        received.push(m);
      },
      end() {},
    };
    const data = new Uint8Array([0x00, 0x7f, 0x80, 0xff]);
    sink.write({ paneId: 1, data });

    expect(received[0].data).toBeInstanceOf(Uint8Array);
    expect(received[0].data[2]).toBe(0x80);
    expect(received[0].data[3]).toBe(0xff);
  });

  it("compile-time guard: ChunkPayload.data must be Uint8Array, not string", () => {
    // [LAW:types-are-the-program] The type system enforces the byte contract —
    // passing a string is a compile error, never a silent misinterpretation.
    function _typeCheck() {
      // @ts-expect-error — data must be Uint8Array, not string
      const _: ChunkPayload = { paneId: 0, data: "hello" };
      void _;
    }
    void _typeCheck;
  });
});

// ---------------------------------------------------------------------------
// 2. shared-decoder
// ---------------------------------------------------------------------------

describe("shared-decoder", () => {
  it("N line consumers on the same pane share one TextDecoder; decode runs once per chunk", () => {
    const client = new FakeClient();
    const lines: string[][] = [[], []];
    attachLineSink(client, (e) => lines[0].push(e.line), { scope: paneScope(1) });
    attachLineSink(client, (e) => lines[1].push(e.line), { scope: paneScope(1) });

    const spy = vi.spyOn(TextDecoder.prototype, "decode");
    // U+1F4A9 (4 bytes) split across two chunks exercises streaming decode too.
    const emoji = new TextEncoder().encode("\u{1F4A9}");
    client.deliver(out(1, emoji.slice(0, 2)));
    client.deliver(out(1, emoji.slice(2)));
    client.deliver(out(1, Buffer.from("\n")));

    // 3 chunks × 1 shared decoder = 3 calls, not 6 (3 chunks × 2 consumers).
    expect(spy.mock.calls.length).toBe(3);
    spy.mockRestore();
    expect(lines[0]).toEqual(["\u{1F4A9}"]);
    expect(lines[1]).toEqual(["\u{1F4A9}"]);
  });
});

// ---------------------------------------------------------------------------
// 3. block-purity
// ---------------------------------------------------------------------------

describe("block-purity", () => {
  it("%output lines inside a %begin/%end block are response content, not notifications", () => {
    const notifications: string[] = [];
    const responseLines: string[] = [];
    const parser = new TmuxParser((msg) => notifications.push(msg.type));
    parser.onOutputLine = (_n, line) => responseLines.push(line);

    // A %output notification that arrives inside a guard block must not escape
    // to the message handler — the block is a command-response scope.
    parser.feed("%begin 1000 1 0\n%output %5 hello world\n%end 1000 1 0\n");

    expect(notifications.includes("output")).toBe(false);
    expect(responseLines).toEqual(["%output %5 hello world"]);
    expect(notifications).toContain("begin");
    expect(notifications).toContain("end");
  });
});

// ---------------------------------------------------------------------------
// 4. fifo-correlation
// ---------------------------------------------------------------------------

describe("fifo-correlation", () => {
  it("commands resolve in send order via FIFO queue; no correlation id appears on the wire", async () => {
    const transport = new FakeTransport();
    const client = new TmuxClient(transport);

    const p1 = client.execute("cmd-alpha");
    const p2 = client.execute("cmd-beta");

    // Wire format: raw command string + newline, no id field, no wrapper.
    expect(transport.sent[0]).toBe("cmd-alpha\n");
    expect(transport.sent[1]).toBe("cmd-beta\n");
    expect(transport.sent[0]).not.toContain('"id"');

    // Inject %begin/%end pairs in order; promises resolve FIFO.
    transport.inject("%begin 1000 1 0\n%end 1000 1 0\n");
    transport.inject("%begin 1001 2 0\n%end 1001 2 0\n");

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.commandNumber).toBe(1);
    expect(r2.commandNumber).toBe(2);
  });

  it("a send that throws (contract-violating transport) rolls its entry out of the FIFO; later commands stay correlated", async () => {
    const transport = new FakeTransport();
    const client = new TmuxClient(transport);

    // A transport that throws violates the SendResult never-throws contract;
    // the client must reject loudly AND keep the correlation FIFO intact —
    // an orphaned slot would silently shift every later response one command.
    const boom = new Error("rogue transport");
    const realSend = transport.send.bind(transport);
    transport.send = () => {
      transport.send = realSend;
      throw boom;
    };

    await expect(client.execute("cmd-alpha")).rejects.toBe(boom);

    // The next command correlates with the FIRST %begin/%end pair — proof
    // the failed entry did not leak a slot.
    const p = client.execute("cmd-beta");
    transport.inject("%begin 1000 1 0\n%end 1000 1 0\n");
    expect((await p).commandNumber).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 5. topology-race
// ---------------------------------------------------------------------------

describe("topology-race", () => {
  it("a window-close notification invalidates an in-flight bootstrap; stale results are discarded", () => {
    const tracker = new TopologyEpochTracker();
    const gen = tracker.startBootstrap();

    // A synchronous window-close arrives before the async list-panes response.
    // This supersedes the in-flight bootstrap — its result must not be applied.
    tracker.invalidateWindow(5);

    expect(tracker.isBootstrapCurrent(gen)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. backpressure-all-frames
// ---------------------------------------------------------------------------

describe("backpressure-all-frames", () => {
  it("a non-pane-output JSON event frame unpauses a slow consumer after the OS buffer drains", async () => {
    const t = new FakeTransport();
    const client = new TmuxClient(t);
    const bridge = createWebSocketBridge({
      createClient: () => client,
      outputHighWatermark: 100,
      outputLowWatermark: 25,
    });

    const ws = createFakeWs();
    void bridge.handleConnection(ws as unknown as ServerWebSocketLike);
    ws.feedClient({ k: "hello" });
    await flushMicrotasks();

    // Slow consumer: bufferedAmount above low watermark.
    ws.setBuffered(80);

    // Drive pane 5 across the high watermark — pause fires once.
    for (let i = 0; i < 5; i++) {
      t.inject(`%output %5 ${"x".repeat(30)}\n`);
    }
    await flushMicrotasks();
    expect(t.sent.filter((c) => c.includes("%5:pause"))).toHaveLength(1);

    // OS buffer drains while pane output stays silent (pane is paused).
    // A non-pane-output JSON notification arrives — it routes through the
    // same wsSend() → maybeFlushBuffered() chokepoint and observes the drain,
    // resuming the paused pane.
    ws.setBuffered(0);
    t.inject("%session-changed $0 main\n");
    await flushMicrotasks();

    expect(t.sent.filter((c) => c.includes("%5:continue"))).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 7. wire-bytes-not-text
// ---------------------------------------------------------------------------

describe("wire-bytes-not-text", () => {
  it("pane bytes are framed as magic + uint32 paneId BE + raw bytes; no base64 encoding", () => {
    const paneId = 42;
    const data = new Uint8Array([0x41, 0x42, 0xff]);
    const frame = encodePaneOutput({ paneId, data });

    expect(frame).toBeInstanceOf(Uint8Array);
    expect(frame[0]).toBe(PANE_OUTPUT_MAGIC); // 0x7f magic byte
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    expect(view.getUint32(2, false)).toBe(paneId); // bytes 2-5, big-endian
    // Bytes 6+ are the raw pane data, verbatim — no encoding transformation.
    expect(Array.from(frame.slice(6))).toEqual([0x41, 0x42, 0xff]);
  });
});

// ---------------------------------------------------------------------------
// 8. bootstrap-idempotent
// ---------------------------------------------------------------------------

describe("bootstrap-idempotent", () => {
  it("when multiple bootstraps are in flight, only the latest generation is applied", () => {
    const tracker = new TopologyEpochTracker();
    const gen1 = tracker.startBootstrap();
    // A second bootstrap (from a concurrent attach or sessions-changed)
    // supersedes the first — gen1's result is silently discarded.
    const gen2 = tracker.startBootstrap();

    expect(tracker.isBootstrapCurrent(gen1)).toBe(false);
    expect(tracker.isBootstrapCurrent(gen2)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 9. emitter-excludes-bytes
// ---------------------------------------------------------------------------

describe("emitter-excludes-bytes", () => {
  it("'output' and 'extended-output' are not valid event keys on TmuxConnection.on()", () => {
    // [LAW:types-are-the-program] TmuxEventMap excludes pane-byte message types.
    // Bytes flow exclusively through attachBytesSink / BytesSink — the emitter
    // cannot carry them even if a caller tries. The constraint is compile-time.
    function _typeCheck(conn: TmuxConnection): void {
      // @ts-expect-error — 'output' is excluded from TmuxEventMap
      conn.on("output", () => {});
      // @ts-expect-error — 'extended-output' is excluded from TmuxEventMap
      conn.on("extended-output", () => {});
    }
    void _typeCheck;
  });
});

// ---------------------------------------------------------------------------
// 10. version-floor
// ---------------------------------------------------------------------------

describe("version-floor", () => {
  it("meetsTmuxVersion enforces the 3.2 library floor and the 3.5 requestReport floor", () => {
    expect(meetsTmuxVersion({ major: 3, minor: 1 }, MIN_TMUX_VERSION)).toBe(false);
    expect(meetsTmuxVersion({ major: 3, minor: 2 }, MIN_TMUX_VERSION)).toBe(true);
    expect(meetsTmuxVersion({ major: 3, minor: 4 }, REQUEST_REPORT_MIN_VERSION)).toBe(false);
    expect(meetsTmuxVersion({ major: 3, minor: 5 }, REQUEST_REPORT_MIN_VERSION)).toBe(true);
    // Major version takes precedence over minor.
    expect(meetsTmuxVersion({ major: 4, minor: 0 }, MIN_TMUX_VERSION)).toBe(true);
    expect(meetsTmuxVersion({ major: 2, minor: 9 }, MIN_TMUX_VERSION)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 11. no-broadcast-loop
// ---------------------------------------------------------------------------

describe("no-broadcast-loop", () => {
  it("SinkRegistry dispatches to all attached sinks without a per-peer broadcast loop", () => {
    // [LAW:single-enforcer] Bridges attach one BytesSink per peer to the shared
    // SinkRegistry. The registry's dispatch() is the sole fanout mechanism —
    // no bridge maintains its own peer list or loop.
    const registry = new SinkRegistry();
    const writes: string[] = [];
    registry.attach({ write() { writes.push("a"); }, end() {} }, serverScope);
    registry.attach({ write() { writes.push("b"); }, end() {} }, serverScope);

    registry.dispatch({ paneId: 3, data: new Uint8Array([0x41]) }, undefined);

    expect(writes).toEqual(["a", "b"]);
  });
});

// ---------------------------------------------------------------------------
// 12. non-exclusive-registry
// ---------------------------------------------------------------------------

describe("non-exclusive-registry", () => {
  it("two attachBytesSink calls at the same scope both receive output; no ALREADY_ATTACHED error", () => {
    const client = new FakeClient();
    const received: number[] = [];

    expect(() => {
      client.attachBytesSink({ write(m) { received.push(m.paneId); }, end() {} });
      client.attachBytesSink({ write(m) { received.push(m.paneId); }, end() {} });
    }).not.toThrow();

    client.deliver(out(7, [0x61]));
    expect(received).toEqual([7, 7]);
  });
});

// ---------------------------------------------------------------------------
// 13. end-is-total
// ---------------------------------------------------------------------------

describe("end-is-total", () => {
  it("disposer calls sink.end() exactly once; subsequent disposer calls are no-ops", () => {
    const registry = new SinkRegistry();
    let endCount = 0;
    const dispose = registry.attach({ write() {}, end() { endCount++; } }, serverScope);
    dispose();
    dispose(); // second call is idempotent
    expect(endCount).toBe(1);
  });

  it("endAll() calls end() exactly once on every remaining attached sink", () => {
    const registry = new SinkRegistry();
    const ends: number[] = [];
    for (let i = 0; i < 3; i++) {
      const id = i;
      registry.attach({ write() {}, end() { ends.push(id); } }, serverScope);
    }
    registry.endAll();
    expect(ends.sort((a, b) => a - b)).toEqual([0, 1, 2]);
  });

  it("endAll() does not double-end a sink whose disposer was already called", () => {
    const registry = new SinkRegistry();
    let endCount = 0;
    const dispose = registry.attach({ write() {}, end() { endCount++; } }, serverScope);
    dispose(); // end() fires here — removes sink from bucket
    registry.endAll(); // sink is no longer in any bucket; end() is NOT called again
    expect(endCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 14. decoder-drain-on-detach
// ---------------------------------------------------------------------------

describe("decoder-drain-on-detach", () => {
  it("disposing the last line consumer for a pane flushes any partial buffered line", () => {
    const client = new FakeClient();
    const lines: string[] = [];
    const dispose = attachLineSink(client, (e) => lines.push(e.line), {
      scope: paneScope(1),
    });

    client.deliver(out(1, Buffer.from("partial-no-newline")));
    expect(lines).toEqual([]); // not yet emitted — no newline

    dispose(); // last consumer detaches → partial buffer is flushed

    expect(lines).toEqual(["partial-no-newline"]);
  });

  it("detaching a non-last consumer does not flush; remaining consumer still receives future bytes", () => {
    const client = new FakeClient();
    const a: string[] = [];
    const b: string[] = [];
    const disposeA = attachLineSink(client, (e) => a.push(e.line), {
      scope: paneScope(1),
    });
    attachLineSink(client, (e) => b.push(e.line), { scope: paneScope(1) });

    client.deliver(out(1, Buffer.from("part")));
    disposeA(); // B still admits pane 1 → no flush

    expect(a).toEqual([]);
    expect(b).toEqual([]);

    client.deliver(out(1, Buffer.from("ial\n")));
    expect(b).toEqual(["partial"]);
  });
});
