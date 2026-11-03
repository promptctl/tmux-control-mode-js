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
  TmuxInvalidCommandError,
  TmuxReplyFormatError,
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
  QUERY_CLIPBOARD_MIN_VERSION,
  PASTE_BUFFER_NOTIFY_MIN_VERSION,
  MESSAGE_NOTIFY_MIN_VERSION,
  REQUEST_REPORT_MIN_VERSION,
  parseTmuxVersion,
  meetsTmuxVersion,
} from "./tmux-compat.js";

export { PaneAction } from "./protocol/types.js";
export type {
  CommandResponse,
  PaneCapture,
  NewWindowResult,
  PaneGeometry,
  PaneRecord,
  SessionRecord,
  TmuxMessage,
  WindowLayout,
  WindowLayoutFields,
  WindowRecord,
} from "./protocol/types.js";
export { latin1ToBytes } from "./protocol/byte-codec.js";
export { parseWindowLayout } from "./protocol/layout.js";

export type {
  TmuxEventMap,
  EmitterMessage,
  EmitterTmuxMessage,
} from "./emitter.js";
export { isTmuxMessage } from "./emitter.js";

export type {
  CrossSessionLayoutChangeMessage,
  CrossSessionLayoutDecodeErrorMessage,
  CrossSessionLayoutFetchFailedMessage,
  CrossSessionLayoutHookRestoredMessage,
  CrossSessionLayoutMessage,
  CrossSessionLayoutOverrunMessage,
  CrossSessionLayoutRepairFailedMessage,
  CrossSessionLayoutUncoveredMessage,
} from "./cross-session-layout.js";

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
  listSessions,
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
  capturePane,
  newWindow,
  getOwnClient,
} from "./commands/index.js";
export type { OwnClient } from "./commands/index.js";
export { watchServerArgs } from "./watch-server.js";
