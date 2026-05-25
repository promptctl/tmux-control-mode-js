// tests/unit/pane-sink-registry.test.ts
// Direct behavior-level tests for `PaneSinkRegistry`. Every TmuxClientLike
// implementation (TmuxClient, TmuxClientProxy, WebSocketTmuxClient,
// BridgePaneStreamClient, FakeTmuxClient) owns one and dispatches from its
// message-receive path BEFORE `emit(msg)`. Pinning the registry's contract
// here means each of those clients inherits the assertion by construction:
// there is exactly one implementation, so behavioral equivalence across
// transports follows from "they all use this class."
//
// [LAW:behavior-not-structure] Tests assert WHAT the registry promises:
//   pre-emit snapshot (no back-fill on re-entrant attach), iteration-safe
//   detach inside a sink's write, per-pane isolation, per-attachment
//   lifecycle, disposer idempotency, and no-op on non-pane-output. None
//   of these assert HOW attachments are stored.
//
// Out of scope here (and out of scope per the `PaneByteSink` contract
// itself): error isolation across sinks. A throwing sink propagates and
// aborts the rest of the per-chunk dispatch — that's by design, and the
// registry is not responsible for catching. What the registry DOES
// provide is isolation between the canonical sink path and the
// deprecated emit-listener path: sinks fire BEFORE `emit(msg)` in every
// TmuxClientLike implementation, so a throwing `on('output', …)`
// listener cannot poison sink delivery for the same chunk. That
// property lives in the per-client message-receive path (see
// `TmuxClient.handleMessage`, `TmuxClientProxy.eventHandler`,
// `WebSocketTmuxClient.dispatchEvent`, etc.), not in the registry.
//
// [LAW:single-enforcer] These assertions sit on the canonical class. Every
//   TmuxClientLike-shaped object that owns a `PaneSinkRegistry` is covered
//   without needing N parallel test suites.

import { describe, expect, it } from "vitest";

import {
  PaneSinkRegistry,
  type PaneByteSink,
} from "../../src/pane-sink.js";
import type { OutputMessage, TmuxMessage } from "../../src/protocol/types.js";

function paneOutput(paneId: number, ...bytes: number[]): OutputMessage {
  return { type: "output", paneId, data: new Uint8Array(bytes) };
}

interface Recorder extends PaneByteSink {
  readonly chunks: Uint8Array[];
  readonly endCount: { value: number };
}

function recorder(): Recorder {
  const chunks: Uint8Array[] = [];
  const endCount = { value: 0 };
  return {
    chunks,
    endCount,
    write(b): void {
      chunks.push(b.slice());
    },
    end(): void {
      endCount.value += 1;
    },
  };
}

describe("PaneSinkRegistry.dispatch", () => {
  it("delivers a chunk only to sinks attached when the chunk arrived (pre-emit snapshot)", () => {
    const reg = new PaneSinkRegistry();
    const a = recorder();
    const lateAttached = recorder();

    // `a` attaches a SIBLING sink mid-dispatch. Per the contract, the
    // sibling MUST NOT see the current chunk — the dispatch operates on a
    // snapshot taken before iteration. This is the "no back-fill"
    // invariant `TmuxClient.attachPaneSink` documents and that every
    // bridge owning a `PaneSinkRegistry` inherits.
    const trigger: PaneByteSink = {
      write(): void {
        reg.attach(1, lateAttached);
      },
    };
    reg.attach(1, trigger);
    reg.attach(1, a);

    reg.dispatch(paneOutput(1, 0x41));

    expect(a.chunks).toHaveLength(1);
    expect(lateAttached.chunks).toHaveLength(0);

    // The late-attached sink IS in the registry for any FUTURE chunk.
    reg.dispatch(paneOutput(1, 0x42));
    expect(lateAttached.chunks).toHaveLength(1);
  });

  it("delivers a chunk to sinks even if a sibling detaches itself mid-dispatch", () => {
    const reg = new PaneSinkRegistry();
    const observed: string[] = [];

    // `a` disposes itself during its own write. The snapshot keeps every
    // attached-at-dispatch-time sink in scope for the rest of this chunk —
    // detach during dispatch does NOT prevent later sinks from firing.
    const a: PaneByteSink = {
      write(): void {
        observed.push("a");
        disposeA();
      },
    };
    const b: PaneByteSink = {
      write(): void {
        observed.push("b");
      },
    };
    const disposeA = reg.attach(1, a);
    reg.attach(1, b);

    reg.dispatch(paneOutput(1, 0x41));

    expect(observed).toEqual(["a", "b"]);
  });

  it("isolates per-pane attachments — bytes for pane X never reach a sink attached to pane Y", () => {
    const reg = new PaneSinkRegistry();
    const onPane1 = recorder();
    const onPane2 = recorder();

    reg.attach(1, onPane1);
    reg.attach(2, onPane2);

    reg.dispatch(paneOutput(1, 0xa1, 0xa2));
    reg.dispatch(paneOutput(2, 0xb1));

    expect(onPane1.chunks).toHaveLength(1);
    expect(onPane1.chunks[0]).toEqual(new Uint8Array([0xa1, 0xa2]));
    expect(onPane2.chunks).toHaveLength(1);
    expect(onPane2.chunks[0]).toEqual(new Uint8Array([0xb1]));
  });

  it("treats each attach() call as independent — N attaches yield N disposers and N end() calls", () => {
    const reg = new PaneSinkRegistry();
    const sink = recorder();

    const d1 = reg.attach(1, sink);
    const d2 = reg.attach(1, sink);

    reg.dispatch(paneOutput(1, 0x41));
    // Same sink attached twice → write fires twice for one chunk.
    expect(sink.chunks).toHaveLength(2);

    d1();
    expect(sink.endCount.value).toBe(1);

    // Second attachment still active.
    reg.dispatch(paneOutput(1, 0x42));
    expect(sink.chunks).toHaveLength(3);

    d2();
    expect(sink.endCount.value).toBe(2);

    // Both disposed.
    reg.dispatch(paneOutput(1, 0x43));
    expect(sink.chunks).toHaveLength(3);
  });

  it("makes the disposer idempotent — a second call is a no-op (no extra end())", () => {
    const reg = new PaneSinkRegistry();
    const sink = recorder();
    const dispose = reg.attach(1, sink);

    dispose();
    dispose();
    dispose();

    expect(sink.endCount.value).toBe(1);
  });

  it("is a cheap no-op on messages with no pane bytes and on panes with no sinks", () => {
    const reg = new PaneSinkRegistry();
    const sink = recorder();
    reg.attach(1, sink);

    // Non-pane-output messages flow through untouched.
    const notPaneBytes: TmuxMessage = {
      type: "begin",
      commandNumber: 1,
      timestamp: 0,
      flags: 0,
    };
    reg.dispatch(notPaneBytes);
    expect(sink.chunks).toHaveLength(0);

    // Pane with no attachments.
    reg.dispatch(paneOutput(99, 0x41));
    expect(sink.chunks).toHaveLength(0);
  });
});
