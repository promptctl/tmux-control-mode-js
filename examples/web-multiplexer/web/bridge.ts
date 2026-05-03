// examples/web-multiplexer/web/bridge.ts
// Renderer-side bridge surface — re-exported from the library so the demo
// shares one canonical contract with any other consumer of
// `@promptctl/tmux-control-mode-js`.
//
// The library declares `TmuxBridge` and `WireEntry` generic over the
// transport's request envelope. This demo specializes both with
// `InspectorRequest` — a `RpcRequest` (the canonical bridge wire shape from
// `src/connectors/rpc.ts`) augmented with a monotonic `id` so the inspector
// can correlate `out` and `in-response` entries. The id lives on the wire
// envelope and not in the protocol because adapters allocate it locally for
// observability; the library's actual transports correlate calls through
// their own internal mechanisms (`WebSocketTmuxClient`'s frame ids,
// Electron's `ipcRenderer.invoke` promise).
//
// [LAW:one-source-of-truth] No interface declared in this file. Adding a
// method to `TmuxBridge` happens in `src/connectors/types.ts`; this file
// just specializes the generics. `RpcRequest` is the single source of truth
// for bridged-method shapes — adding/removing/renaming a method touches
// `src/connectors/rpc.ts` and propagates here automatically.

import type {
  TmuxBridge as LibTmuxBridge,
  WireEntry as LibWireEntry,
  WireHandler as LibWireHandler,
} from "../../../src/connectors/types.js";
import type { RpcRequest } from "../../../src/connectors/rpc.js";

export type {
  ConnState,
  EventHandler,
  ErrorHandler,
  StateHandler,
} from "../../../src/connectors/types.js";

/**
 * The wire-entry payload for outbound calls in this demo. `RpcRequest` is
 * the canonical method+args shape used by both the WebSocket and Electron
 * connectors; the `id` is an inspector-local monotonic tag so the timeline
 * can pair an `out` entry with its eventual `in-response` / `in-error`
 * entry. Adapters generate it; the library protocol does not see it.
 */
export type InspectorRequest = RpcRequest & { readonly id: string };

export type WireEntry = LibWireEntry<InspectorRequest>;
export type WireHandler = LibWireHandler<InspectorRequest>;
export type TmuxBridge = LibTmuxBridge<InspectorRequest>;
