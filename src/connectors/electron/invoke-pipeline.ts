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
import {
  BridgeError,
  type InvokeResultEnvelope,
  type IpcMainInvokeEventLike,
} from "./types.js";
import type { PendingDispatch, SenderRegistry } from "./sender-registry.js";

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

function abortedEnvelope(method: string): InvokeResultEnvelope {
  return {
    status: "bridge-error",
    error: new BridgeError(
      "BRIDGE_ABORTED",
      `dispatch for method=${method} aborted: sender destroyed`,
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
  private readonly handlerCalls = new Set<Promise<InvokeResultEnvelope>>();

  constructor(private readonly deps: InvokePipelineDeps) {}

  // Bound so `ipcMain.handle(IPC.invoke, pipeline.handle)` keeps its `this`.
  handle = (
    event: IpcMainInvokeEventLike,
    ...args: unknown[]
  ): Promise<InvokeResultEnvelope> => {
    const p = this.run(event, ...args);
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
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    });
    try {
      await Promise.race([all, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async run(
    event: IpcMainInvokeEventLike,
    ...args: unknown[]
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
    const sender = this.deps.registry.getOrCreate(event.sender);
    // [LAW:no-ambient-temporal-coupling] The wc was already destroyed when this
    // queued invoke ran (its teardown fired first). There is no live sender to
    // bill and no point running a real command for a dead renderer — the reply
    // is moot. Abort before creating any state, so no peer is resurrected.
    if (sender === undefined) return abortedEnvelope(methodLabel(args[0]));
    const dispatch: PendingDispatch = { aborted: false };
    sender.pending.add(dispatch);

    try {
      let req: RpcRequest;
      try {
        req = parseRpcRequest(args[0]);
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
      if (dispatch.aborted) return abortedEnvelope(req.method);
      return encodeOutcome(outcome);
    } finally {
      sender.pending.delete(dispatch);
    }
  }
}
