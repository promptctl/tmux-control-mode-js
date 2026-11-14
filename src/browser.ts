// tmux-control-mode-js/browser — browser-safe runtime surface
//
// The pane-output consumer primitives (sinks, scopes, topology) plus the
// shared types, with ZERO Node.js coupling. The Node-only transport, client,
// and command modules live behind the root entry (`.`); a browser / Deno / Bun
// consumer imports from here and never pulls `node:*` into its bundle.
//
// [LAW:decomposition] The real seam is between the pure pane-output core and
//   the Node transport. This entry exposes only the former, so a bundler never
//   has to resolve `node:child_process` to build a browser graph.
// [LAW:one-way-deps] Browser consumers depend on pure modules only; nothing
//   re-exported here transitively reaches the transport layer.
// [LAW:one-source-of-truth] Re-exports only — every symbol's definition lives
//   in its owning module, identical to the root entry's view of it.

export {
  serverScope,
  sessionScope,
  windowScope,
  paneScope,
  SinkRegistry,
  PaneTopologyManager,
  TopologyEpochTracker,
  parsePaneListLine,
  PANE_LIST_FORMAT,
} from "./pane-output.js";
export type {
  BytesSink,
  ChunkPayload,
  AttachOptions,
  PaneScope,
  PaneMeta,
  PaneListEntry,
} from "./pane-output.js";

export { isTmuxMessage } from "./emitter.js";
export type {
  TmuxEventMap,
  EmitterMessage,
  EmitterTmuxMessage,
} from "./emitter.js";

export type {
  CommandResponse,
  PaneCapture,
  NewWindowResult,
  PaneGeometry,
  PaneProcessState,
  PaneRecord,
  SessionRecord,
  TmuxMessage,
  WindowLayout,
  WindowLayoutFields,
  WindowRecord,
} from "./protocol/types.js";
export { parseWindowLayout } from "./protocol/layout.js";
export type { ConnectionState } from "./connection-state.js";
export type { TmuxConnection } from "./client.js";

// [LAW:one-source-of-truth] The tmux version-compatibility contract is pure
//   (zero Node coupling), so it ships identically on the browser surface. A
//   browser consumer issuing requestReport over a TmuxConnection must be able
//   to catch its version-precondition failure and pre-check the floor itself.
export { UnsupportedTmuxVersionError } from "./errors.js";
// [LAW:one-source-of-truth] The whole typed-error taxonomy is pure (each class
//   extends Error over type-only imports). A browser consumer driving commands
//   over a TmuxConnection — e.g. pane-terminal's subscribe/seed seam — must be
//   able to classify a rejection by CLASS (surface-vs-quiet) rather than by
//   parsing tmux's English. `isConnectionGone` is the shared quiet-vs-surface
//   predicate; the classes back consumer-side `instanceof` checks and tests.
export {
  TmuxCommandError,
  TmuxProtocolError,
  TmuxInvalidCommandError,
  TmuxReplyFormatError,
  PaneCwdUnavailableError,
  TransportClosedError,
  TransportSendError,
  UnrecognizedTmuxVersionError,
  isConnectionGone,
} from "./errors.js";
export type { TmuxVersion } from "./tmux-compat.js";
export {
  MIN_TMUX_VERSION,
  QUERY_CLIPBOARD_MIN_VERSION,
  PASTE_BUFFER_NOTIFY_MIN_VERSION,
  MESSAGE_NOTIFY_MIN_VERSION,
  REQUEST_REPORT_MIN_VERSION,
  PANE_CWD_MIN_VERSION,
  EMPTY_WINDOW_MIN_VERSION,
  RESPAWN_PANE_MIN_VERSION,
  missingCwdFallback,
  parseTmuxVersion,
  meetsTmuxVersion,
} from "./tmux-compat.js";

// [LAW:one-type-per-behavior] The free command functions are one family — pure
//   builders over `TmuxConnection` with no transport coupling — so the whole
//   set ships on the browser surface, identical to the root entry's view.
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
  newEmptyWindow,
  respawnPane,
  paneCwd,
  getOwnClient,
} from "./commands/index.js";
export type {
  NewWindowPlacement,
  OwnClient,
  PaneProcess,
} from "./commands/index.js";
