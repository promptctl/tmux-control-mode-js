// tmux-control-mode-js — public API
// [LAW:one-source-of-truth] All consumer-facing exports are declared here only.

export { TmuxClient } from "./client.js";
export type { TmuxConnection, SplitOptions, TmuxClientLike } from "./client.js";
export type { ConnectionState } from "./connection-state.js";
export { TmuxCommandError } from "./errors.js";

export { PaneAction } from "./protocol/types.js";
export type { CommandResponse, TmuxMessage } from "./protocol/types.js";
export { latin1ToBytes } from "./protocol/byte-codec.js";

export type { TmuxEventMap } from "./emitter.js";

export type {
  BytesSink,
  ChunkPayload,
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

// [LAW:types-are-the-program] Free-function command surface — all tmux
// commands are functions over TmuxConnection, not methods on TmuxClient.
export {
  listWindows,
  listPanes,
  sendKeys,
  splitWindow,
  setSize,
  setPaneAction,
  subscribeRaw,
  unsubscribe,
  setFlags,
  clearFlags,
  requestReport,
  queryClipboard,
} from "./commands/index.js";
