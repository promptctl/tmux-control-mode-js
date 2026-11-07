// src/connectors/websocket/outbox.ts
// [LAW:decomposition] Call correlation + per-call timeout + the un-transmitted
// send queue, extracted from WebSocketTmuxClient. The owner holds no in-flight
// call state.
//
// [LAW:one-source-of-truth] A Pending entry IS the queue entry. `frame` is the
// encoded wire frame, re-sendable on reconnect; `transmitted` flips to true the
// moment the socket accepts the frame. There is no second outbox structure that
// can drift out of sync with the correlation map — two structures that must
// agree would be an invariant the type cannot enforce, so there is only one.

import { TmuxCommandError } from "../../errors.js";
import { answersNull, type RpcResponseMap } from "../rpc.js";
import type { DurationMs } from "./limits.js";
import {
  BridgeError,
  BridgeProtocolError,
  type ResultFrame,
  type RpcMethod,
} from "./protocol.js";

interface Pending {
  readonly method: RpcMethod;
  readonly frame: string;
  resolve(r: RpcResponseMap[RpcMethod]): void;
  reject(e: BridgeError | TmuxCommandError): void;
  timer: ReturnType<typeof setTimeout>;
  transmitted: boolean;
}

export class Outbox {
  // Insertion-ordered: FIFO transmit order is the Map's iteration order.
  private readonly pending = new Map<string, Pending>();

  // [LAW:effects-at-boundaries] `send` is the sole effectful seam. It returns
  // true iff the socket accepted the frame; false (never throwing) when the
  // socket is not in a writable/ready state. The Outbox stays pure of any
  // knowledge of connection state — it only asks "did this frame go out?".
  constructor(private readonly send: (frame: string) => boolean) {}

  // Register a call, arm its timeout, and attempt an immediate transmit.
  // Resolves/rejects when the matching result arrives, the deadline expires,
  // or the connection drains. [LAW:parse-dont-validate] The deadline arrives
  // stamped by limits.ts, so it is one a reply can meet.
  enqueue<M extends RpcMethod>(
    id: string,
    method: M,
    frame: string,
    timeoutMs: DurationMs,
  ): Promise<RpcResponseMap[M]> {
    return new Promise<RpcResponseMap[M]>((resolve, reject) => {
      const timer = setTimeout(() => {
        const p = this.pending.get(id);
        if (p === undefined) return;
        this.pending.delete(id);
        reject(
          new BridgeError(
            "BRIDGE_TIMEOUT",
            `request '${method}' timed out after ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);
      (timer as unknown as { unref?: () => void }).unref?.();

      // [LAW:types-are-the-program] `Pending` is keyed by id, not by method,
      // so it cannot carry M through the Map without an existential-type
      // workaround. The narrowing here is sound by the protocol's own
      // invariant (settle() only ever resolves an id with the response its
      // own request produced) — the same single-cast-site pattern
      // dispatchRpcRequest/VALIDATORS use for their own method-keyed tables.
      const entry: Pending = {
        method,
        frame,
        resolve: resolve as Pending["resolve"],
        reject,
        timer,
        transmitted: false,
      };
      this.pending.set(id, entry);
      this.transmit(entry);
    });
  }

  // Settle the pending call a result frame answers. No-op if the call already
  // timed out (its entry is gone). Returns the protocol violation, if the
  // frame broke the wire contract, so the client reports it on its error
  // channel like every other malformed frame.
  settle(frame: ResultFrame): BridgeProtocolError | undefined {
    const p = this.pending.get(frame.id);
    if (p === undefined) return undefined;
    this.pending.delete(frame.id);
    clearTimeout(p.timer);
    if (frame.ok) {
      // [LAW:parse-dont-validate] The frame parser cannot see the method; this
      // is the one place that pairs a response with the call it answers.
      if ((frame.response === null) !== answersNull(p.method)) {
        const violation = new BridgeProtocolError(
          `result for '${p.method}' has ${frame.response === null ? "a null" : "a non-null"} response`,
        );
        p.reject(violation);
        return violation;
      }
      p.resolve(frame.response);
    } else if ("tmuxError" in frame) {
      p.reject(new TmuxCommandError(frame.tmuxError));
    } else {
      p.reject(BridgeError.fromPayload(frame.error));
    }
    return undefined;
  }

  // [LAW:dataflow-not-control-flow] Same loop every ready transition: walk
  // pending in FIFO order, ask `send` to transmit each still-untransmitted
  // frame. Stop at the first that does not go out so FIFO order is preserved
  // for the next transition.
  flush(): void {
    for (const p of this.pending.values()) {
      this.transmit(p);
      if (!p.transmitted) return;
    }
  }

  // Connection ended: reject every pending call and clear the map in one
  // operation. There is no separate queue to survive this — the pre-fix bug it
  // guards against was a second outbox re-sending frames whose caller was
  // already rejected.
  drain(err: BridgeError): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      try {
        p.reject(err);
      } catch {
        // A caller's rejection handler throwing must not strand the rest.
      }
      this.pending.delete(id);
    }
  }

  private transmit(p: Pending): void {
    if (p.transmitted) return;
    if (this.send(p.frame)) {
      p.transmitted = true;
    }
    // Otherwise stays untransmitted; flush() retries on the next ready
    // transition. `send` owns the ready/OPEN gate and never throws.
  }
}
