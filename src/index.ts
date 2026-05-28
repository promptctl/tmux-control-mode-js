// tmux-control-mode-js — public API
// [LAW:one-source-of-truth] All consumer-facing exports are declared here only.

export { TmuxClient } from "./client.js";
export type { SplitOptions, TmuxClientLike } from "./client.js";
export type { ConnectionState } from "./connection-state.js";
export { TmuxCommandError } from "./errors.js";

export { PaneAction } from "./protocol/types.js";
export type { CommandResponse, TmuxMessage } from "./protocol/types.js";
export { latin1ToBytes } from "./protocol/byte-codec.js";

export type { TmuxEventMap } from "./emitter.js";

export type {
  BytesSink,
  AttachOptions,
  PaneScope,
  PaneMeta,
} from "./pane-output.js";
export {
  serverScope,
  sessionScope,
  windowScope,
  paneScope,
  SinkRegistry,
  PaneTopologyManager,
  TopologyEpochTracker,
  parsePaneListLine,
} from "./pane-output.js";

export { createTextStreamSink } from "./sinks/text-stream.js";

export { attachLineSink } from "./line-sink.js";
export type { LineEvent, LineHandler } from "./line-sink.js";

export { spawnTmux } from "./transport/spawn.js";
export type { TmuxTransport, SpawnOptions } from "./transport/types.js";
export {
  tmuxSocketDir,
  listTmuxSocketNames,
  isTmuxServerAlive,
} from "./transport/sockets.js";
