// src/connectors/rpc-dispatch.ts
// Server-side dispatcher for RpcRequest.
//
// [LAW:single-enforcer] One dispatch table for every bridge connector. Every
// dispatch goes through dispatchRpcRequest; every method resolves to the same
// Promise<CommandResponse> shape so callers never special-case any variant.
// [LAW:dataflow-not-control-flow] One indexed lookup; the variant in
// RpcRequest is what decides which free-function call runs.
// [LAW:one-type-per-behavior] One Dispatcher mapped type covers every method;
// the satisfies clause forces compile-time exhaustiveness.
// [LAW:types-are-the-program] Typed against TmuxConnection, not TmuxClient —
// the dispatch table needs execute + on/off only; the class is over-specified.

import type { TmuxConnection } from "../client.js";
import type { CommandResponse } from "../protocol/types.js";
import type { RpcRequest } from "./rpc.js";
import * as commands from "../commands/index.js";

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
    client: TmuxConnection,
    args: R["args"],
  ) => Promise<CommandResponse> | CommandResponse;
};

const DISPATCH: Dispatcher = Object.assign(Object.create(null) as Dispatcher, {
  execute: (c, [command]) => c.execute(command),
  listWindows: (c) => commands.listWindows(c),
  listPanes: (c) => commands.listPanes(c),
  sendKeys: (c, [target, keys]) => commands.sendKeys(c, target, keys),
  splitWindow: (c, [options]) => commands.splitWindow(c, options),
  setSize: (c, [width, height]) => commands.setSize(c, width, height),
  setPaneAction: (c, [paneId, action]) =>
    commands.setPaneAction(c, paneId, action),
  subscribeRaw: (c, [name, what, format]) =>
    commands.subscribeRaw(c, name, what, format),
  unsubscribe: (c, [name]) => commands.unsubscribe(c, name),
  setFlags: (c, [flags]) => commands.setFlags(c, flags),
  clearFlags: (c, [flags]) => commands.clearFlags(c, flags),
  requestReport: (c, [paneId, report]) =>
    commands.requestReport(c, paneId, report),
  queryClipboard: (c) => commands.queryClipboard(c),
} satisfies Dispatcher);

export function dispatchRpcRequest(
  client: TmuxConnection,
  req: RpcRequest,
): Promise<CommandResponse> {
  const fn = DISPATCH[req.method] as (
    c: TmuxConnection,
    a: RpcRequest["args"],
  ) => Promise<CommandResponse> | CommandResponse;
  return Promise.resolve(fn(client, req.args));
}
