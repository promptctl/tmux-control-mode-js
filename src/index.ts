// tmux-control-mode-js — public API
// [LAW:one-source-of-truth] All consumer-facing exports are declared here only.

export { TmuxClient } from "./client.js";
export type { SplitOptions, TmuxClientLike } from "./client.js";
export type { ConnectionState } from "./connection-state.js";
export { TmuxCommandError } from "./errors.js";

export { PaneAction } from "./protocol/types.js";
export type { CommandResponse, TmuxMessage } from "./protocol/types.js";

export type { TmuxEventMap } from "./emitter.js";

export type { PaneByteSink, PaneByteEmitter } from "./pane-sink.js";
export { attachPaneSinkViaEmitter } from "./pane-sink.js";
export { createTextStreamSink } from "./sinks/text-stream.js";

export { spawnTmux } from "./transport/spawn.js";
export type { TmuxTransport, SpawnOptions } from "./transport/types.js";
export {
  tmuxSocketDir,
  listTmuxSocketNames,
  isTmuxServerAlive,
} from "./transport/sockets.js";
