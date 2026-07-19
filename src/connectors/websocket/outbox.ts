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

import type { CommandResponse } from "../../protocol/types.js";
import { BridgeError, type ResultFrame, type RpcMethod } from "./protocol.js";

interface Pending {
  readonly method: RpcMethod;
  readonly frame: string;
  resolve(r: CommandResponse): void;
  reject(e: BridgeError): void;
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
  // or the connection drains.
  enqueue(
    id: string,
    method: RpcMethod,
    frame: string,
    timeoutMs: number,
  ): Promise<CommandResponse> {
    return new Promise<CommandResponse>((resolve, reject) => {
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

      const entry: Pending = {
        method,
        frame,
        resolve,
        reject,
        timer,
        transmitted: false,
      };
      this.pending.set(id, entry);
      this.transmit(entry);
    });
  }

  // Settle the pending call a result frame answers. No-op if the call already
  // timed out (its entry is gone).
  settle(frame: ResultFrame): void {
    const p = this.pending.get(frame.id);
    if (p === undefined) return;
    this.pending.delete(frame.id);
    clearTimeout(p.timer);
    if (frame.ok) {
      p.resolve(frame.response);
    } else {
      p.reject(BridgeError.fromPayload(frame.error));
    }
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
