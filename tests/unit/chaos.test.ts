// tests/unit/chaos.test.ts
// The chaos transport decorator and its fuzzing harness. Two layers:
//   1. The pure pieces (seeded RNG, corruptors, ManualClock, planChunk) tested
//      directly — deterministic, exact.
//   2. withChaos wrapping a real MockTmuxServer driving a real TmuxClient — the
//      live fuzzer: feed the parser and command state machine a lossy, hostile
//      wire and assert they cope (never throw, recover for clean traffic).
//
// [LAW:verifiable-goals] Every chaotic run is a pure function of its seed, so a
//   failing fuzz seed is printed and replayable — a bug you can re-run is a bug
//   you can fix.

import { describe, it, expect } from "vitest";
import {
  withChaos,
  planChunk,
  ManualClock,
  corruptChunk,
  ALL_CORRUPTIONS,
  mulberry32,
  randomInt,
  type CorruptionKind,
} from "../../src/chaos/index.js";
import { MockTmuxServer } from "../../src/mock/index.js";
import type { MockScenario } from "../../src/mock/index.js";
import { TmuxClient } from "../../src/client.js";
import {
  TmuxParser,
  serializeMessage,
  decodeOctalEscapes,
  encodeOctalEscapes,
} from "../../src/protocol/index.js";
import type { TmuxMessage } from "../../src/protocol/index.js";
import type { TmuxTransport, SendResult } from "../../src/transport/types.js";
import type { EmitterMessage } from "../../src/emitter.js";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/** A transport whose inbound stream the test drives by hand via {@link push}. */
class FakeTransport implements TmuxTransport {
  readonly sent: string[] = [];
  closed = false;
  private dataCb: ((chunk: string) => void) | undefined;

  send(command: string): SendResult {
    if (this.closed) return { ok: false, reason: "transport closed" };
    this.sent.push(command);
    return { ok: true };
  }
  onData(callback: (chunk: string) => void): void {
    this.dataCb = callback;
  }
  onClose(): void {}
  close(): void {
    this.closed = true;
  }
  /** Simulate the inner transport emitting one inbound chunk. */
  push(chunk: string): void {
    this.dataCb?.(chunk);
  }
}

/** A generator returning a scripted sequence, then `last` forever — for exact draws. */
function scripted(values: number[]): () => number {
  let i = 0;
  return () => (i < values.length ? values[i++] : values[values.length - 1]);
}

function collectEvents(client: TmuxClient): EmitterMessage[] {
  const events: EmitterMessage[] = [];
  client.on("*", (ev) => events.push(ev));
  return events;
}

// ---------------------------------------------------------------------------
// Seeded RNG
// ---------------------------------------------------------------------------

describe("mulberry32 — reproducible randomness", () => {
  it("same seed yields the same sequence", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const seqA = Array.from({ length: 8 }, () => a());
    const seqB = Array.from({ length: 8 }, () => b());
    expect(seqA).toEqual(seqB);
  });

  it("different seeds diverge", () => {
    const a = mulberry32(1);
    const b = mulberry32(2);
    expect(a()).not.toEqual(b());
  });

  it("draws stay in [0, 1)", () => {
    const r = mulberry32(7);
    for (let i = 0; i < 1000; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("randomInt respects [lo, hi) and collapses an empty range to lo", () => {
    const r = mulberry32(99);
    for (let i = 0; i < 1000; i++) {
      const v = randomInt(r, 3, 7);
      expect(v).toBeGreaterThanOrEqual(3);
      expect(v).toBeLessThan(7);
    }
    expect(randomInt(r, 5, 5)).toBe(5);
    expect(randomInt(r, 5, 2)).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Corruptors
// ---------------------------------------------------------------------------

describe("corruptChunk — every applied corruption truly changes a non-empty chunk", () => {
  it("each kind alters the chunk it applies to (no silent no-op)", () => {
    const r = mulberry32(123);
    // A chunk carrying an octal escape so flip-octal is applicable too.
    const chunk = `%output %1 hi${encodeOctalEscapes(new Uint8Array([0x1b, 7]))}\n`;
    const kinds: CorruptionKind[] = [...ALL_CORRUPTIONS];
    for (const kind of kinds) {
      const out = corruptChunk(chunk, r, [kind]);
      expect(out, `kind ${kind} should change the chunk`).not.toBe(chunk);
    }
  });

  it("truncate shortens; drop-newline strips exactly the trailing LF", () => {
    const r = mulberry32(5);
    const line = "%window-add @7\n";
    expect(corruptChunk(line, r, ["truncate"]).length).toBeLessThan(line.length);
    expect(corruptChunk(line, r, ["drop-newline"])).toBe("%window-add @7");
  });

  it("flip-octal makes a well-formed escape malformed (decoder falls back to '?')", () => {
    const r = mulberry32(11);
    const payload = encodeOctalEscapes(new Uint8Array([0x1b])); // "\033"
    const line = `%output %1 ${payload}`;
    const corrupted = corruptChunk(line, r, ["flip-octal"]);
    // The corrupted escape decodes to the malformed-recovery marker.
    const decoded = decodeOctalEscapes(corrupted.slice(`%output %1 `.length));
    expect(Array.from(decoded)).toContain(0x3f); // '?'
  });

  it("falls back to a guaranteed corruptor when no requested kind applies", () => {
    const r = mulberry32(3);
    // flip-octal requested, but no escape present → must still change the chunk.
    const line = "%window-add @1\n";
    const out = corruptChunk(line, r, ["flip-octal"]);
    expect(out).not.toBe(line);
  });

  it("an empty chunk has nothing to corrupt and is returned as-is", () => {
    const r = mulberry32(1);
    expect(corruptChunk("", r, ALL_CORRUPTIONS)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// ManualClock
// ---------------------------------------------------------------------------

describe("ManualClock — the explicit timing owner", () => {
  it("fires nothing until time is advanced past the due point", () => {
    const clock = new ManualClock();
    const fired: string[] = [];
    clock.schedule(() => fired.push("a"), 10);
    clock.advance(5);
    expect(fired).toEqual([]);
    clock.advance(5);
    expect(fired).toEqual(["a"]);
  });

  it("reorders by due time — a later, shorter delay overtakes an earlier one", () => {
    const clock = new ManualClock();
    const fired: string[] = [];
    clock.schedule(() => fired.push("A"), 90); // scheduled first, due later
    clock.schedule(() => fired.push("B"), 10); // scheduled second, due first
    clock.advance(100);
    expect(fired).toEqual(["B", "A"]);
  });

  it("ties fire in scheduling order", () => {
    const clock = new ManualClock();
    const fired: string[] = [];
    clock.schedule(() => fired.push("first"), 10);
    clock.schedule(() => fired.push("second"), 10);
    clock.advance(10);
    expect(fired).toEqual(["first", "second"]);
  });

  it("honours callbacks scheduled during an advance (re-entrancy)", () => {
    const clock = new ManualClock();
    const fired: number[] = [];
    clock.schedule(() => {
      fired.push(1);
      clock.schedule(() => fired.push(2), 5); // due within the same window
    }, 5);
    clock.advance(10);
    expect(fired).toEqual([1, 2]);
  });

  it("runAll drains every pending callback regardless of time", () => {
    const clock = new ManualClock();
    const fired: string[] = [];
    clock.schedule(() => fired.push("x"), 1_000_000);
    expect(clock.pending).toBe(1);
    clock.runAll();
    expect(fired).toEqual(["x"]);
    expect(clock.pending).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// planChunk — the pure decision core
// ---------------------------------------------------------------------------

describe("planChunk — pure, ordered, reproducible decisions", () => {
  const base = {
    dropRate: 0,
    corruptRate: 0,
    latency: { min: 0, max: 0 },
    kinds: ALL_CORRUPTIONS,
  };

  it("drops when the first draw falls under dropRate", () => {
    const plan = planChunk("line\n", { ...base, dropRate: 1, random: scripted([0]) });
    expect(plan.kind).toBe("drop");
  });

  it("delivers the chunk unchanged with zero delay when all rates are zero", () => {
    const plan = planChunk("line\n", { ...base, random: mulberry32(1) });
    expect(plan).toEqual({ kind: "deliver", payload: "line\n", delayMs: 0 });
  });

  it("corrupts when the second draw falls under corruptRate", () => {
    const plan = planChunk("%window-add @1\n", {
      ...base,
      corruptRate: 1,
      kinds: ["flip-byte"],
      random: mulberry32(8),
    });
    expect(plan.kind).toBe("deliver");
    if (plan.kind === "deliver") expect(plan.payload).not.toBe("%window-add @1\n");
  });

  it("samples a delay within the latency window", () => {
    const plan = planChunk("line\n", {
      ...base,
      latency: { min: 10, max: 20 },
      random: mulberry32(2),
    });
    expect(plan.kind).toBe("deliver");
    if (plan.kind === "deliver") {
      expect(plan.delayMs).toBeGreaterThanOrEqual(10);
      expect(plan.delayMs).toBeLessThanOrEqual(20);
    }
  });
});

// ---------------------------------------------------------------------------
// withChaos — the decorator mechanics
// ---------------------------------------------------------------------------

describe("withChaos — decorator over a fake transport", () => {
  it("passes send / close straight through (chaos is inbound-only)", () => {
    const inner = new FakeTransport();
    const chaos = withChaos(inner, { dropRate: 1 });
    chaos.send("kill-pane\n");
    chaos.close();
    expect(inner.sent).toEqual(["kill-pane\n"]);
    expect(inner.closed).toBe(true);
  });

  it("with all rates zero it is a transparent pass-through (synchronous)", () => {
    const inner = new FakeTransport();
    const chaos = withChaos(inner);
    const got: string[] = [];
    chaos.onData((c) => got.push(c));
    inner.push("%window-add @1\n");
    expect(got).toEqual(["%window-add @1\n"]);
  });

  it("drops inbound chunks at dropRate 1", () => {
    const inner = new FakeTransport();
    const chaos = withChaos(inner, { dropRate: 1 });
    const got: string[] = [];
    chaos.onData((c) => got.push(c));
    inner.push("%window-add @1\n");
    expect(got).toEqual([]);
  });

  it("corrupts inbound chunks at corruptRate 1", () => {
    const inner = new FakeTransport();
    const chaos = withChaos(inner, {
      corruptRate: 1,
      corruptions: ["flip-byte"],
      seed: 4,
    });
    const got: string[] = [];
    chaos.onData((c) => got.push(c));
    inner.push("%window-add @1\n");
    expect(got).toHaveLength(1);
    expect(got[0]).not.toBe("%window-add @1\n");
  });

  it("holds delayed chunks until the clock advances, and reorders by delay", () => {
    const clock = new ManualClock();
    const inner = new FakeTransport();
    // Script draws so chunk A gets a long delay, chunk B a short one.
    // Per chunk: [drop?, corrupt?, latencySample]; dropRate/corruptRate 0.
    const chaos = withChaos(inner, {
      latencyMs: { min: 0, max: 100 },
      clock,
      random: scripted([0.9, 0.9, 0.9, 0.9, 0.9, 0.1]),
    });
    const got: string[] = [];
    chaos.onData((c) => got.push(c));

    inner.push("A\n");
    inner.push("B\n");
    expect(got).toEqual([]); // nothing delivered yet — the clock owns timing
    clock.advance(100);
    expect(got).toEqual(["B\n", "A\n"]); // B (delay 10) overtakes A (delay 90)
  });

  it("is deterministic: same seed over the same input yields the same output", () => {
    const run = (): string[] => {
      const inner = new FakeTransport();
      const chaos = withChaos(inner, {
        dropRate: 0.3,
        corruptRate: 0.5,
        seed: 1234,
      });
      const got: string[] = [];
      chaos.onData((c) => got.push(c));
      for (let i = 0; i < 50; i++) inner.push(`%window-add @${i}\n`);
      return got;
    };
    expect(run()).toEqual(run());
  });

  it("rejects out-of-range options loudly", () => {
    const inner = new FakeTransport();
    expect(() => withChaos(inner, { dropRate: 1.5 })).toThrow(RangeError);
    expect(() => withChaos(inner, { corruptRate: -0.1 })).toThrow(RangeError);
    expect(() => withChaos(inner, { latencyMs: { min: 5, max: 1 } })).toThrow(
      RangeError,
    );
  });
});

// ---------------------------------------------------------------------------
// Parser recovery — a corrupted line must not poison the line after it
// ---------------------------------------------------------------------------

describe("parser recovery under corruption", () => {
  it("a corrupted line does not poison a well-framed line that follows", () => {
    const seen: TmuxMessage[] = [];
    const parser = new TmuxParser((m) => seen.push(m));
    const r = mulberry32(77);

    const clean1 = serializeMessage({ type: "session-changed", sessionId: 1, name: "main" });
    const mid = serializeMessage({ type: "window-add", windowId: 9 });
    const clean3 = serializeMessage({ type: "window-add", windowId: 10 });

    parser.feed(clean1 + "\n");
    // Corrupt only the content, then re-add the LF so framing is preserved —
    // the parser must reject/garble this line yet keep going.
    parser.feed(corruptChunk(mid, r, ["flip-byte"]) + "\n");
    parser.feed(clean3 + "\n");

    expect(seen).toContainEqual({ type: "session-changed", sessionId: 1, name: "main" });
    expect(seen).toContainEqual({ type: "window-add", windowId: 10 });
  });
});

// ---------------------------------------------------------------------------
// Live harness — withChaos(mock) drives a real TmuxClient
// ---------------------------------------------------------------------------

describe("withChaos drives a real TmuxClient", () => {
  const greetingScenario: MockScenario = {
    greeting: [
      { type: "session-changed", sessionId: 1, name: "main" },
      { type: "sessions-changed" },
      { type: "window-add", windowId: 2 },
    ],
  };

  it("transparently delivers a clean session and resolves a command (latency via clock)", async () => {
    const clock = new ManualClock();
    const scenario: MockScenario = {
      ...greetingScenario,
      respond: (cmd) =>
        cmd.startsWith("list-windows") ? { kind: "ok", output: ["@2 editor"] } : undefined,
    };
    const server = new MockTmuxServer(scenario);
    const chaos = withChaos(server, { latencyMs: { min: 2, max: 2 }, clock });
    const client = new TmuxClient(chaos);
    const events = collectEvents(client);

    server.start();
    const exec = client.execute("list-windows");
    expect(events).toEqual([]); // latency holds everything until the clock turns
    clock.runAll();

    const response = await exec;
    expect(response.success).toBe(true);
    expect(response.output).toEqual(["@2 editor"]);
    expect(events).toEqual(
      expect.arrayContaining([
        { type: "session-changed", sessionId: 1, name: "main" },
        { type: "window-add", windowId: 2 },
      ]),
    );
  });

  it("a clean stream (zero rates) surfaces the full greeting — chaos is opt-in", () => {
    const server = new MockTmuxServer(greetingScenario);
    const client = new TmuxClient(withChaos(server));
    const events = collectEvents(client);
    server.start();
    expect(events).toEqual(
      expect.arrayContaining([
        { type: "session-changed", sessionId: 1, name: "main" },
        { type: "sessions-changed" },
        { type: "window-add", windowId: 2 },
      ]),
    );
  });

  // The fuzzer: many seeds, each a hostile wire. The bar is that the parser and
  // command state machine never throw — a crash on any seed fails the test and
  // prints the seed for replay. [LAW:verifiable-goals]
  it("never throws across a fuzzed space of lossy, corrupt, jittered wires", () => {
    const sampleMessages: TmuxMessage[] = [
      { type: "window-add", windowId: 3 },
      { type: "window-renamed", windowId: 3, name: "editor" },
      { type: "session-changed", sessionId: 1, name: "main" },
      { type: "output", paneId: 1, data: new Uint8Array([104, 105, 0x1b, 7, 0]) },
      { type: "layout-change", windowId: 3, windowLayout: "b1f2,80x24,0,0,1", windowVisibleLayout: "b1f2,80x24,0,0,1", windowFlags: "*" },
      { type: "window-close", windowId: 3 },
      { type: "sessions-changed" },
      { type: "pane-mode-changed", paneId: 1 },
    ];

    for (let seed = 0; seed < 60; seed++) {
      const clock = new ManualClock();
      const server = new MockTmuxServer({
        ...greetingScenario,
        respond: () => ({ kind: "ok", output: ["row-a", "row-b"] }),
      });
      const chaos = withChaos(server, {
        seed,
        dropRate: 0.2,
        corruptRate: 0.4,
        latencyMs: { min: 0, max: 3 },
        clock,
      });

      expect(() => {
        const client = new TmuxClient(chaos);
        collectEvents(client);
        server.start();
        for (const msg of sampleMessages) server.emit(msg);
        // Detached, swallowed — a corrupted block may resolve, reject, or hang;
        // none of those is a crash, which is all this fuzzer asserts.
        void client.execute("list-windows").catch(() => undefined);
        void client.execute("display-message x").catch(() => undefined);
        clock.runAll();
      }, `chaos seed ${seed} crashed the client`).not.toThrow();
    }
  });
});
