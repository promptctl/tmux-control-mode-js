// src/connectors/bridge-dispatch.ts
// Shared server-side RPC-outcome pipeline for every TmuxClient bridge connector.
//
// A bridge server turns a parsed `RpcRequest` into one of three logical
// outcomes, and that classification is identical for every transport:
//   1. intercept the bridge-stateful methods (subscribeRaw / unsubscribe) so
//      ownership + refcount stay enforced by the shared BridgeConnection,
//      dispatching everything else through `dispatchRpcRequest`;
//   2. a tmux `%error` reply (TmuxCommandError) is a SUCCESSFUL bridge call
//      carrying a failed CommandResponse — the client sees `success:false`,
//      not a transport error;
//   3. a typed BridgeError (subscription conflict, unknown subscription, …)
//      surfaces its code verbatim, and any other throw collapses to
//      BRIDGE_INTERNAL.
//
// What is NOT shared — and stays in each connector — is the WIRE ENCODING of
// that outcome: the WS server emits `replyOk`/`replyError` frames, the
// Electron main returns an `InvokeResultEnvelope`. Those are genuinely
// transport-specific. This module owns the classification; the connectors own
// the encoding.
//
// [LAW:single-enforcer] One pipeline owns WHO may dispatch the bridge-stateful
// methods AND THAT every method gets dispatched + classified. Previously this
// lived once per connector with a documented "keep in sync" hazard: a future
// bridge-stateful method had to be added to the interception arm in every
// connector, and one that forgot routed it straight to `dispatchRpcRequest`,
// bypassing the refcount BridgeConnection exists to enforce. The single
// interception list here makes that drift unrepresentable.
// [LAW:decomposition] The cut is classify-vs-encode: the outcome union is the
// seam, carrying the whole truth of the call so each connector can encode it
// by looking only at the value.
// [LAW:dataflow-not-control-flow] Every call runs the same dispatch-then-
// classify pipe; the variability rides in the returned BridgeOutcome value,
// not in which branch a connector took.

import type { TmuxConnection } from "../client.js";
import { TmuxCommandError, TransportSendError } from "../errors.js";
import type { CommandResponse } from "../protocol/types.js";
import type { BridgeConnection, Peer } from "./bridge-connection.js";
import { BridgeError } from "./errors.js";
import { dispatchRpcRequest } from "./rpc-dispatch.js";
import type { RpcMethod, RpcRequest } from "./rpc.js";

// ---------------------------------------------------------------------------
// BridgeOutcome — the normalized result of dispatching one RpcRequest.
//
// `ok` and `tmux-error` BOTH carry a CommandResponse and BOTH are successful
// at the bridge layer; they are kept distinct because the Electron envelope
// reports them under different `status` tags, while the WS server collapses
// both to a `replyOk` frame. A `bridge-error` carries the typed BridgeError
// instance itself — WS reads `.code`/`.message`, Electron calls `.toPayload()`,
// so handing both the instance lets each take exactly what its wire needs.
//
// [LAW:types-are-the-program] Three logical outcomes, three variants; an
// illegal mix (an "ok" with an error, a "bridge-error" with no error) is
// unrepresentable.
// ---------------------------------------------------------------------------

export type BridgeOutcome =
  | { readonly kind: "ok"; readonly response: CommandResponse }
  | { readonly kind: "tmux-error"; readonly response: CommandResponse }
  | { readonly kind: "bridge-error"; readonly error: BridgeError };

/**
 * Dispatch one already-parsed `RpcRequest` through the bridge and classify the
 * result into a `BridgeOutcome`. Never throws: every outcome — success, tmux
 * `%error`, typed bridge failure, or an unexpected throw — becomes a value in
 * the returned union, so callers encode a value rather than catch an error.
 *
 * Parsing untrusted payloads into an `RpcRequest` stays upstream in each
 * connector (it produces a wire frame directly on failure, before any outcome
 * exists); this pipeline begins once a valid request is in hand.
 */
export async function dispatchBridgeRequest(
  bridge: BridgeConnection,
  client: TmuxConnection,
  peer: Peer,
  req: RpcRequest,
): Promise<BridgeOutcome> {
  try {
    const response = await runBridgeDispatch(bridge, client, peer, req);
    return { kind: "ok", response };
  } catch (err) {
    return classifyDispatchError(req.method, err);
  }
}

// ---------------------------------------------------------------------------
// Interception: bridge-stateful methods route through BridgeConnection so
// subscription ownership + refcount + the divergent-resubscribe rejection are
// enforced exactly once; everything else dispatches verbatim.
//
// [LAW:single-enforcer] This is the ONE list of bridge-stateful methods. A new
// one is added here, never per connector.
// ---------------------------------------------------------------------------

function runBridgeDispatch(
  bridge: BridgeConnection,
  client: TmuxConnection,
  peer: Peer,
  req: RpcRequest,
): Promise<CommandResponse> {
  if (req.method === "subscribeRaw") {
    const [name, what, format] = req.args;
    return bridge.subscribeForPeer(peer, name, what, format);
  }
  if (req.method === "unsubscribe") {
    const [name] = req.args;
    return bridge.unsubscribeForPeer(peer, name);
  }
  return dispatchRpcRequest(client, req);
}

function classifyDispatchError(method: RpcMethod, err: unknown): BridgeOutcome {
  // [LAW:single-enforcer] TmuxCommandError is the typed receipt for a tmux
  // `%error` reply (see src/errors.ts). It is a SUCCESSFUL bridge call whose
  // response carries `success:false` — not a bridge failure.
  if (err instanceof TmuxCommandError) {
    return { kind: "tmux-error", response: err.response };
  }
  // A typed BridgeError raised by the shared helper (BRIDGE_UNKNOWN_SUBSCRIPTION,
  // BRIDGE_SUBSCRIPTION_FORMAT_CONFLICT, …) already carries the wire code —
  // surface it verbatim instead of collapsing into BRIDGE_INTERNAL.
  if (err instanceof BridgeError) {
    return { kind: "bridge-error", error: err };
  }
  // [LAW:one-type-per-behavior] A transport send refusal is an operational
  // close of the upstream tmux connection — the same consumer-facing state as
  // a bridge close, so it carries the same code, never BRIDGE_INTERNAL (which
  // means "bug"). The refusal reason rides in the message.
  if (err instanceof TransportSendError) {
    return {
      kind: "bridge-error",
      error: new BridgeError("BRIDGE_CLOSED", err.message),
    };
  }
  return { kind: "bridge-error", error: internalError(method, err) };
}

// ---------------------------------------------------------------------------
// internalError — wrap an unexpected throw as BRIDGE_INTERNAL.
//
// Carries the failing method name in the message and chains the cause's stack
// via `\nCaused by: …` so a renderer/peer that logs the reconstructed error
// localizes the failure to the function that actually threw, not just to the
// bridge frame that wrapped it. The chained stack is debug-aid: it rides on
// `BridgeError.toPayload().stack` (which the Electron wire carries) and is
// inert on the WS wire (which serializes only `{code, message}`).
//
// Exported so the Electron main's parse-failure fallback (where `method` is
// not yet known, hence a "<unknown>" label) builds its BRIDGE_INTERNAL the
// SAME way — one construction, not a twin. `method` is a free-form label here,
// not constrained to RpcMethod, so the pre-parse fallback can pass "<unknown>".
//
// [LAW:single-enforcer] The one place a BRIDGE_INTERNAL BridgeError is built.
// ---------------------------------------------------------------------------

export function internalError(method: string, err: unknown): BridgeError {
  const causeMsg = err instanceof Error ? err.message : String(err);
  const wrapped = new BridgeError(
    "BRIDGE_INTERNAL",
    `dispatch failed for method=${method}: ${causeMsg}`,
  );
  if (err instanceof Error && err.stack !== undefined) {
    const own = wrapped.stack ?? wrapped.message;
    wrapped.stack = `${own}\nCaused by: ${err.stack}`;
  }
  return wrapped;
}
