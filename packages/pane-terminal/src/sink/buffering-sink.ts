// packages/pane-terminal/src/sink/buffering-sink.ts
//
// `BufferingSink` — canonical in-memory `TerminalSink` for tests and any
// caller that wants a renderer-free stand-in (CLI inspection, snapshot
// recording, the bench harness). Records every method call so tests can
// assert what the sink was asked to do, and concatenates `write()` payloads
// into a single byte view so byte-fidelity tests can `.equal()` the input.
//
// [LAW:one-source-of-truth] One sink class for tests. Gates 4 and 5 use
//   this; consumer-side fixtures should reuse it rather than re-implementing
//   capture-by-array.
// [LAW:behavior-not-structure] The sink records BEHAVIORAL events (seed,
//   write, resize, clear, dispose) — not internal renderer state. A test
//   that depends on internal Uint8Array buffer indices should examine the
//   call log, not the implementation.
// [LAW:no-defensive-null-guards] Methods never throw before dispose; after
//   dispose they no-op (the call is silently dropped). The dispose-after-use
//   contract is on the caller.

import type { TerminalSink, SeedCursor } from "./index.js";

/** A recorded `seed()` call. */
export interface SeedCall {
  readonly captured: string;
  readonly cursor: SeedCursor | null;
}

/** A recorded `resize()` call. */
export interface ResizeCall {
  readonly cols: number;
  readonly rows: number;
}

export interface BufferingSinkOptions {
  /**
   * Initial visibility for `isVisible()`. Default `true` (matches the
   * "fixture is in view" intent the gate-7 test expects). Use `false` to
   * model an attached-but-hidden sink in reseed-priority tests.
   */
  readonly visible?: boolean;
}

export class BufferingSink implements TerminalSink {
  /** Every `seed()` call in order. Reset by `clear()`. */
  readonly seedCalls: SeedCall[] = [];
  /** Every `write()` call's bytes, in order. Reset by `clear()`. */
  readonly writes: Uint8Array[] = [];
  /** Every `resize()` call in order. Reset by `clear()`. */
  readonly resizeCalls: ResizeCall[] = [];

  private isDisposed = false;
  private visible: boolean;
  // Counters — useful when a test wants "number of calls" without
  // walking the array (which BufferingSink also exposes).
  private clearCount = 0;
  private disposeCount = 0;

  constructor(opts: BufferingSinkOptions = {}) {
    this.visible = opts.visible ?? true;
  }

  // ---------------------------------------------------------------------------
  // TerminalSink
  // ---------------------------------------------------------------------------

  seed(captured: string, cursor: SeedCursor | null): void {
    if (this.isDisposed) return;
    this.seedCalls.push({ captured, cursor });
  }

  write(data: Uint8Array): void {
    if (this.isDisposed) return;
    // Push the reference, not a copy — gate 5 asserts byte-identity by
    // reference (`expect(sink.writes[0]).toBe(injected)`), and the design
    // doc's O3 ("zero decoding in pipeline") forbids any copy here.
    this.writes.push(data);
  }

  resize(cols: number, rows: number): void {
    if (this.isDisposed) return;
    this.resizeCalls.push({ cols, rows });
  }

  clear(): void {
    if (this.isDisposed) return;
    this.clearCount += 1;
    // Empty in-place so test code holding a reference to seedCalls/writes/
    // resizeCalls still sees the updated array (same identity).
    this.seedCalls.length = 0;
    this.writes.length = 0;
    this.resizeCalls.length = 0;
  }

  isVisible(): boolean {
    if (this.isDisposed) return false;
    return this.visible;
  }

  dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;
    this.disposeCount += 1;
    this.seedCalls.length = 0;
    this.writes.length = 0;
    this.resizeCalls.length = 0;
  }

  // ---------------------------------------------------------------------------
  // Test-only inspection helpers
  // ---------------------------------------------------------------------------

  /** True after `dispose()` has been called at least once. */
  get disposed(): boolean {
    return this.isDisposed;
  }

  /** Total `clear()` invocations across the lifetime of the sink. */
  get clearCalls(): number {
    return this.clearCount;
  }

  /** Total `dispose()` invocations across the lifetime of the sink. */
  get disposeCalls(): number {
    return this.disposeCount;
  }

  /**
   * Mutate visibility — used by the reseed-priority bench (gate 7) to
   * model "this sink is on the offscreen tab right now." No-op after
   * `dispose()` to honour the post-dispose contract documented at the top
   * of this file (every method becomes a no-op).
   */
  setVisible(v: boolean): void {
    if (this.isDisposed) return;
    this.visible = v;
  }

  /**
   * Concatenated byte view of every `write()` call since the last `clear()`
   * (or since construction). Returns a single new `Uint8Array` — useful
   * when a test wants to assert "the full byte stream the sink received
   * equals the bytes injected." Allocates; do NOT call from a hot path.
   */
  concatBytes(): Uint8Array {
    let total = 0;
    for (const w of this.writes) total += w.byteLength;
    const out = new Uint8Array(total);
    let off = 0;
    for (const w of this.writes) {
      out.set(w, off);
      off += w.byteLength;
    }
    return out;
  }
}
