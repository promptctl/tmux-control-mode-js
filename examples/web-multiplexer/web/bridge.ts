// examples/web-multiplexer/web/bridge.ts
// Renderer-side bridge surface — re-exported from the library so the demo
// shares one canonical contract with any other consumer of
// `@promptctl/tmux-control-mode-js`.
//
// The library declares `TmuxBridge` and `WireEntry` generic over the
// transport's request envelope. This demo specializes both with
// `ClientToServer` from `../shared/protocol.ts` so its inspector renders
// typed payloads (kind, id, etc.) instead of `unknown`.
//
// [LAW:one-source-of-truth] No interface declared in this file. Adding a
// method to `TmuxBridge` happens in `src/connectors/types.ts`; this file
// just specializes the generics.

import type {
  TmuxBridge as LibTmuxBridge,
  WireEntry as LibWireEntry,
  WireHandler as LibWireHandler,
} from "../../../src/connectors/types.js";
import type { ClientToServer } from "../shared/protocol.ts";

export type {
  ConnState,
  EventHandler,
  ErrorHandler,
  StateHandler,
} from "../../../src/connectors/types.js";

export type WireEntry = LibWireEntry<ClientToServer>;
export type WireHandler = LibWireHandler<ClientToServer>;
export type TmuxBridge = LibTmuxBridge<ClientToServer>;
