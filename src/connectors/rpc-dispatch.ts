// src/connectors/rpc-dispatch.ts
// Server-side dispatcher for RpcRequest.
//
// [LAW:single-enforcer] Every dispatch goes through dispatchRpcRequest; the
// resolved shape is RpcResponseMap[M] (rpc.ts) so callers never special-case
// any variant themselves — they already know the shape from the method name.
// [LAW:types-are-the-program] A switch on `req.method` narrows `req` to the
// exact RpcRequest member inside each case, so `req.args` and the handler
// call are provably sound — no cast. The old lookup-table form (`DISPATCH[
// req.method]`) lost that correlation at the point of indexing a mapped
// object type by a union key, which is exactly where TypeScript cannot
// verify soundness and required an `as` cast instead.
// [LAW:dataflow-not-control-flow] Traded deliberately, not silently: the old
// table WAS the one-indexed-lookup shape this law prefers, but that shape is
// exactly what lost the method/args/response correlation above. A plain
// `function` per method would restore dataflow but reintroduce the
// drift-prone "N places to edit" this file's comment above has always
// warned against. The switch is the narrower violation — one file, one
// control-flow fan-out, still exhaustive by construction — chosen because
// soundness here outweighs the dataflow preference.
// [LAW:types-are-the-program] Typed against TmuxConnection, not TmuxClient —
// the dispatcher needs execute + on/off only; the class is over-specified.
//
// Exhaustiveness: the `default` branch hands `req` to `assertNever`, whose
// parameter type is `never`. Adding a new RpcRequest variant without a
// matching `case` makes that call a compile error — the same guarantee the
// old table's `satisfies Dispatcher` gave, without needing a cast to call
// through it.
//
// Every commands.* function (and TmuxConnection.execute) already returns a
// Promise, so each case returns it directly — no per-case `Promise.resolve`
// wrapper to keep in sync as cases are added.

import type { TmuxConnection } from "../client.js";
import type { RpcRequest, RpcResponseMap } from "./rpc.js";
import { assertNever } from "../protocol/assert-never.js";
import * as commands from "../commands/index.js";

export function dispatchRpcRequest(
  client: TmuxConnection,
  req: RpcRequest,
): Promise<RpcResponseMap[RpcRequest["method"]]> {
  switch (req.method) {
    case "execute":
      return client.execute(req.args[0]);
    case "listWindows":
      return commands.listWindows(client);
    case "listPanes":
      return commands.listPanes(client);
    case "listSessions":
      return commands.listSessions(client);
    case "sendKeys":
      return commands.sendKeys(client, req.args[0], req.args[1]);
    case "splitWindow":
      return commands.splitWindow(client, req.args[0]);
    case "setSize":
      return commands.setSize(client, req.args[0], req.args[1]);
    case "setPaneAction":
      return commands.setPaneAction(client, req.args[0], req.args[1]);
    case "subscribeRaw":
      return commands.subscribeRaw(
        client,
        req.args[0],
        req.args[1],
        req.args[2],
      );
    case "unsubscribe":
      return commands.unsubscribe(client, req.args[0]);
    case "setFlags":
      return commands.setFlags(client, req.args[0]);
    case "clearFlags":
      return commands.clearFlags(client, req.args[0]);
    case "requestReport":
      return commands.requestReport(client, req.args[0], req.args[1]);
    case "queryClipboard":
      return commands.queryClipboard(client);
    default:
      return assertNever(req, "dispatchRpcRequest");
  }
}
