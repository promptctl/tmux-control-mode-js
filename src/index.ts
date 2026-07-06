// tmux-control-mode-js — public API
// [LAW:one-source-of-truth] All consumer-facing exports are declared here only.

export { TmuxClient } from "./client.js";
export type {
  TmuxConnection,
  SplitOptions,
  TmuxClientOptions,
} from "./client.js";
export type { ConnectionState } from "./connection-state.js";
export {
  TmuxCommandError,
  TmuxProtocolError,
  TransportClosedError,
  TransportSendError,
  UnsupportedTmuxVersionError,
} from "./errors.js";

// [LAW:one-source-of-truth] tmux version-compatibility contract. These are the
// machine-readable form of the support floors the README Compatibility table
// mirrors — library surface, consumed by requestReport's version gate and
// available to consumers that want to pre-check before issuing a command.
export type { TmuxVersion } from "./tmux-compat.js";
export {
  MIN_TMUX_VERSION,
  REQUEST_REPORT_MIN_VERSION,
  parseTmuxVersion,
  meetsTmuxVersion,
} from "./tmux-compat.js";

export { PaneAction } from "./protocol/types.js";
export type { CommandResponse, TmuxMessage } from "./protocol/types.js";
export { latin1ToBytes } from "./protocol/byte-codec.js";

export type {
  TmuxEventMap,
  EmitterMessage,
  EmitterTmuxMessage,
} from "./emitter.js";
export { isTmuxMessage } from "./emitter.js";

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

export { TopologyRouter } from "./topology-router.js";

export { createTextStreamSink } from "./sinks/text-stream.js";

export { attachLineSink } from "./line-sink.js";
export type { LineEvent, LineHandler } from "./line-sink.js";

export { spawnTmux } from "./transport/spawn.js";
export type {
  TmuxTransport,
  SendResult,
  SpawnOptions,
} from "./transport/types.js";
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
  queryTmuxVersion,
} from "./commands/index.js";
