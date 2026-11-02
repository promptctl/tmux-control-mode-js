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
// [LAW:types-are-the-program] Typed against TmuxConnection, not TmuxClient —
// the dispatcher needs execute + on/off only; the class is over-specified.
//
// Exhaustiveness: the `default` branch assigns `req` to a `never`-typed
// binding. Adding a new RpcRequest variant without a matching `case` makes
// that assignment a compile error — the same guarantee the old table's
// `satisfies Dispatcher` gave, without needing a cast to call through it.

import type { TmuxConnection } from "../client.js";
import type { RpcRequest, RpcResponseMap } from "./rpc.js";
import * as commands from "../commands/index.js";

export function dispatchRpcRequest(
  client: TmuxConnection,
  req: RpcRequest,
): Promise<RpcResponseMap[RpcRequest["method"]]> {
  switch (req.method) {
    case "execute":
      return Promise.resolve(client.execute(req.args[0]));
    case "listWindows":
      return Promise.resolve(commands.listWindows(client));
    case "listPanes":
      return Promise.resolve(commands.listPanes(client));
    case "listSessions":
      return Promise.resolve(commands.listSessions(client));
    case "sendKeys":
      return Promise.resolve(
        commands.sendKeys(client, req.args[0], req.args[1]),
      );
    case "splitWindow":
      return Promise.resolve(commands.splitWindow(client, req.args[0]));
    case "setSize":
      return Promise.resolve(
        commands.setSize(client, req.args[0], req.args[1]),
      );
    case "setPaneAction":
      return Promise.resolve(
        commands.setPaneAction(client, req.args[0], req.args[1]),
      );
    case "subscribeRaw":
      return Promise.resolve(
        commands.subscribeRaw(client, req.args[0], req.args[1], req.args[2]),
      );
    case "unsubscribe":
      return Promise.resolve(commands.unsubscribe(client, req.args[0]));
    case "setFlags":
      return Promise.resolve(commands.setFlags(client, req.args[0]));
    case "clearFlags":
      return Promise.resolve(commands.clearFlags(client, req.args[0]));
    case "requestReport":
      return Promise.resolve(
        commands.requestReport(client, req.args[0], req.args[1]),
      );
    case "queryClipboard":
      return Promise.resolve(commands.queryClipboard(client));
    default: {
      const _exhaustive: never = req;
      throw new Error(
        `unhandled RPC method: ${(_exhaustive as RpcRequest).method}`,
      );
    }
  }
}
