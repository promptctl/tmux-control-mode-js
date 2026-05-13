// src/connectors/rpc-dispatch.ts
// Server-side dispatcher for RpcRequest. Imports TmuxClient — must NOT be
// reachable from any browser/renderer transitive import graph. The renderer-
// safe types and parser live in `./rpc.ts`.
//
// [LAW:single-enforcer] One dispatch table for every bridge connector. Every
// dispatch goes through dispatchRpcRequest; every method resolves to the same
// Promise<CommandResponse> shape so callers never special-case any variant.
// [LAW:dataflow-not-control-flow] One indexed lookup; the variant in
// RpcRequest is what decides which TmuxClient call runs.
// [LAW:one-type-per-behavior] One Dispatcher mapped type covers every method;
// the satisfies clause forces compile-time exhaustiveness.

import type { TmuxClient } from "../client.js";
import type { CommandResponse } from "../protocol/types.js";
import type { RpcRequest } from "./rpc.js";

// ---------------------------------------------------------------------------
// Dispatcher — single exhaustive table mapping method → invocation.
//
// Backed by Object.create(null) for defense-in-depth: a payload reaching here
// has already been validated by parseRpcRequest, but the null prototype means
// even a hypothetical bypass cannot resolve `constructor`/`__proto__` to a
// built-in function.
// ---------------------------------------------------------------------------

type Dispatcher = {
  readonly [R in RpcRequest as R["method"]]: (
    client: TmuxClient,
    args: R["args"],
  ) => Promise<CommandResponse> | CommandResponse;
};

const DISPATCH: Dispatcher = Object.assign(Object.create(null) as Dispatcher, {
  execute: (c, [command]) => c.execute(command),
  listWindows: (c) => c.listWindows(),
  listPanes: (c) => c.listPanes(),
  sendKeys: (c, [target, keys]) => c.sendKeys(target, keys),
  splitWindow: (c, [options]) => c.splitWindow(options),
  setSize: (c, [width, height]) => c.setSize(width, height),
  setPaneAction: (c, [paneId, action]) => c.setPaneAction(paneId, action),
  subscribe: (c, [name, what, format]) => c.subscribe(name, what, format),
  unsubscribe: (c, [name]) => c.unsubscribe(name),
  setFlags: (c, [flags]) => c.setFlags(flags),
  clearFlags: (c, [flags]) => c.clearFlags(flags),
  requestReport: (c, [paneId, report]) => c.requestReport(paneId, report),
  queryClipboard: (c) => c.queryClipboard(),
} satisfies Dispatcher);

/**
 * Dispatch a parsed RpcRequest against a TmuxClient. Always returns a
 * Promise<CommandResponse> — every entry in DISPATCH delegates to a
 * TmuxClient method whose result is a CommandResponse, so the dispatcher
 * resolves or rejects on that call without per-variant special-casing.
 */
export function dispatchRpcRequest(
  client: TmuxClient,
  req: RpcRequest,
): Promise<CommandResponse> {
  const fn = DISPATCH[req.method] as (
    c: TmuxClient,
    a: RpcRequest["args"],
  ) => Promise<CommandResponse> | CommandResponse;
  return Promise.resolve(fn(client, req.args));
}
