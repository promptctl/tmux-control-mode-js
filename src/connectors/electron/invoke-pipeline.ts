// src/connectors/electron/invoke-pipeline.ts
// [LAW:decomposition] Renderer command invocation, extracted from
// createMainBridge: parse → dispatch → encode, plus the two pieces of state
// that path needs — the per-sender in-flight dispatch set (for abort-on-
// teardown) and the handler-call set (for drain). The wiring shell holds
// neither.
//
// [LAW:single-enforcer] parseRpcRequest is the only validation site;
// dispatchBridgeRequest is the only dispatch+classify site. This module owns
// ONLY the Electron wire encoding of the outcome (the InvokeResultEnvelope
// discriminated union) and the RpcError → BridgeError mapping at the IPC seam.

import type { TmuxConnection } from "../../client.js";
import {
  mapRpcCode,
  parseRpcRequest,
  RpcError,
  type RpcRequest,
} from "../rpc.js";
import {
  type BridgeOutcome,
  dispatchBridgeRequest,
  internalError,
} from "../bridge-dispatch.js";
import type { BridgeConnection } from "../bridge-connection.js";
import { waitAtMost } from "../wait-at-most.js";
import {
  BridgeError,
  IPC,
  type InvokeResultEnvelope,
  type InvokeReturn,
  type IpcMainEventLike,
} from "./types.js";
import type {
  PendingDispatch,
  SenderRegistry,
  SenderState,
} from "./sender-registry.js";

// ---------------------------------------------------------------------------
// RpcError → BridgeError mapping + envelope construction at the IPC boundary.
//
// [LAW:single-enforcer] RpcError is connector-internal; it is mapped to a
// `BridgeError` here so the wire taxonomy is unified across both transports.
// The taxonomy translation (mapRpcCode) is single-sourced in `../rpc.js`; this
// seam keeps only the Electron-specific envelope (the message-prefix strip).
// ---------------------------------------------------------------------------

function rpcErrorToBridge(err: RpcError): BridgeError {
  // [LAW:one-source-of-truth] Read RpcError's own unprefixed message rather than
  // regex-stripping the `[CODE] ` prefix off `.message`. The BridgeError code
  // re-supplies its own prefix, so passing the bare text avoids double-prefixed
  // messages like `[BRIDGE_INVALID_ARG] [INVALID_ARG] ...` without coupling to
  // RpcError's message format.
  return new BridgeError(mapRpcCode(err.code), err.original);
}

function rpcErrorEnvelope(err: RpcError): InvokeResultEnvelope {
  return { status: "bridge-error", error: rpcErrorToBridge(err).toPayload() };
}

// Why an invoke was aborted, as its reply states it.
const NOT_FROM_PAGE_SHOWN =
  "not sent by the page its WebContents shows (the page has ended, or a " +
  "subframe sent it)";
const PEER_TORN_DOWN =
  "the page's peer was torn down while it ran (the page ended or " +
  "unregistered, or the bridge was disposed)";

function abortedEnvelope(method: string, reason: string): InvokeResultEnvelope {
  return {
    status: "bridge-error",
    error: new BridgeError(
      "BRIDGE_ABORTED",
      `dispatch for method=${method} aborted: ${reason}`,
    ).toPayload(),
  };
}

// Best-effort method name for labelling an aborted reply when the sender is
// already gone. A malformed request has no method — the label falls back rather
// than surfacing a parse error the moot reply doesn't need.
function methodLabel(raw: unknown): string {
  try {
    return parseRpcRequest(raw).method;
  } catch {
    return "<unknown>";
  }
}

// [LAW:single-enforcer] The BRIDGE_INTERNAL construction (method-labelled
// message + chained cause stack) lives once in `../bridge-dispatch.js`. This
// fallback covers only the pre-parse path, where the method is not yet known
// (`parseRpcRequest` threw something other than RpcError — defensive: it only
// ever throws RpcError). The post-parse dispatch path is classified inside
// dispatchBridgeRequest.
function internalErrorEnvelope(
  method: string,
  err: unknown,
): InvokeResultEnvelope {
  return {
    status: "bridge-error",
    error: internalError(method, err).toPayload(),
  };
}

// [LAW:decomposition] Electron wire encoding of a BridgeOutcome — the
// transport-specific half. `ok` and `tmux-error` keep their distinct envelope
// `status` tags; `bridge-error` serializes the typed BridgeError via
// `toPayload()` (structured-clone drops Error subclass fields, so the payload
// is what survives the IPC hop).
function encodeOutcome(outcome: BridgeOutcome): InvokeResultEnvelope {
  switch (outcome.kind) {
    case "ok":
      return { status: "ok", response: outcome.response };
    case "tmux-error":
      return { status: "tmux-error", response: outcome.response };
    case "bridge-error":
      return { status: "bridge-error", error: outcome.error.toPayload() };
  }
}

export interface InvokePipelineDeps {
  readonly bridge: BridgeConnection;
  // [LAW:types-are-the-program] The pipeline forwards `client` only to
  // `dispatchBridgeRequest`, which accepts the `TmuxConnection` interface — so
  // that, not the concrete `TmuxClient` class, is the honest dependency type.
  readonly client: TmuxConnection;
  readonly registry: Pick<SenderRegistry, "getOrCreate">;
}

export class InvokePipeline {
  // [LAW:one-source-of-truth] The abort signal lives on each sender's `pending`
  // set (owned by SenderRegistry, flagged on teardown) — not duplicated here.
  // This Set carries only the await targets for `drain`; it is populated on
  // invoke and self-cleans when each call settles.
  private readonly handlerCalls = new Set<Promise<InvokeReturn>>();

  constructor(private readonly deps: InvokePipelineDeps) {}

  // Bound so `ipcMain.handle(IPC.invoke, pipeline.handle)` keeps its `this`.
  handle = (
    event: IpcMainEventLike,
    ...args: unknown[]
  ): Promise<InvokeReturn> => {
    const p = this.answer(event, args[0], args[1]);
    this.handlerCalls.add(p);
    // The envelope-returning handler never rejects under normal flow, but keep
    // the symmetric cleanup so a programming error (a rejection that somehow
    // escapes the try/catch) does not leak into the tracking Set.
    const cleanup = (): void => {
      this.handlerCalls.delete(p);
    };
    p.then(cleanup, cleanup);
    return p;
  };

  async drain(timeoutMs?: number): Promise<void> {
    if (this.handlerCalls.size === 0) return;
    const all = Promise.allSettled([...this.handlerCalls]).then(
      () => undefined,
    );
    if (timeoutMs === undefined) {
      await all;
      return;
    }
    await waitAtMost(all, timeoutMs);
  }

  private async answer(
    event: IpcMainEventLike,
    rawId: unknown,
    raw: unknown,
  ): Promise<InvokeReturn> {
    if (typeof rawId !== "number" || !Number.isSafeInteger(rawId)) {
      const err = new RpcError(
        "INVALID_REQUEST",
        "invoke id is not an integer",
      );
      return { via: "invoke", result: rpcErrorEnvelope(err) };
    }
    const sender = this.deps.registry.getOrCreate(event);
    // [LAW:no-ambient-temporal-coupling] The sending page had already ended
    // when this queued invoke ran (its teardown fired first), or a subframe
    // sent it. There is no live sender to bill and no point running a real
    // command for a page that is gone — the reply is moot. Abort before
    // creating any state, so no peer is minted for the next page to inherit.
    if (sender === undefined) {
      const result = abortedEnvelope(methodLabel(raw), NOT_FROM_PAGE_SHOWN);
      return { via: "invoke", result };
    }
    const dispatch: PendingDispatch = { aborted: false };
    sender.pending.add(dispatch);
    const result = await this.run(sender, dispatch, raw).finally(() =>
      sender.pending.delete(dispatch),
    );
    // [LAW:no-ambient-temporal-coupling] The reply rides `IPC.event`, behind
    //   every event main sent the page before it — unless the sender was
    //   torn down meanwhile: `IPC.event` now reaches whatever document the
    //   WebContents shows next, so the reply goes back in the return.
    if (dispatch.aborted) return { via: "invoke", result };
    sender.wc.send(IPC.event, { type: "invoke-reply", id: rawId, result });
    return { via: "event" };
  }

  private async run(
    sender: SenderState,
    dispatch: PendingDispatch,
    raw: unknown,
  ): Promise<InvokeResultEnvelope> {
    // [LAW:dataflow-not-control-flow] The handler ALWAYS returns an
    // InvokeResultEnvelope — every outcome (success, tmux %error, bridge
    // failure) becomes a value in the envelope's discriminated union. The
    // handler never rejects.
    //
    // Why never reject: real Electron's `ipcMain.handle` serializes a promise
    // rejection by reading `.message` (and `.stack` in dev mode); structured-
    // clone DROPS subclass properties like `.code`. Throwing BridgeError out of
    // this handler loses the very piece of information the renderer needs to
    // branch on. The wire envelope carries `BridgeErrorPayload` (`{code,
    // message}`) so the renderer reconstructs a typed BridgeError via
    // `BridgeError.fromPayload`.
    //
    // [LAW:single-enforcer] parseRpcRequest is still the only validation site;
    // RpcError never escapes — it is mapped to BridgeError at this seam.
    let req: RpcRequest;
    try {
      req = parseRpcRequest(raw);
    } catch (err) {
      if (err instanceof RpcError) return rpcErrorEnvelope(err);
      return internalErrorEnvelope("<unknown>", err);
    }
    const outcome = await dispatchBridgeRequest(
      this.deps.bridge,
      this.deps.client,
      sender.peer,
      req,
    );
    // [LAW:no-ambient-temporal-coupling] If the sender was torn down while
    // the dispatch was in flight, the abort flag is the single owner of
    // "this reply is moot" — it overrides any outcome.
    if (dispatch.aborted) return abortedEnvelope(req.method, PEER_TORN_DOWN);
    return encodeOutcome(outcome);
  }
}
