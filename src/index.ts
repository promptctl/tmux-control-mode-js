// tmux-control-mode-js — public API
// [LAW:one-source-of-truth] All consumer-facing exports are declared here only.

export { TmuxClient } from "./client.js";
export type { SplitOptions, SubscriptionHandle } from "./client.js";
export { TmuxCommandError } from "./errors.js";

export {
  buildScopedFormat,
  parseRows,
  FIELD_SEP,
  ROW_SEP,
} from "./subscriptions.js";
export type { Scope } from "./subscriptions.js";

export { PaneAction } from "./protocol/types.js";
export type { CommandResponse, TmuxMessage } from "./protocol/types.js";

export type { TmuxEventMap } from "./emitter.js";

export { spawnTmux } from "./transport/spawn.js";
export type { TmuxTransport, SpawnOptions } from "./transport/types.js";
export {
  tmuxSocketDir,
  listTmuxSocketNames,
  isTmuxServerAlive,
} from "./transport/sockets.js";

export { PaneSession } from "./pane-session.js";
export type {
  TerminalSink,
  PaneSessionClient,
  PaneSessionOptions,
  PaneSessionState,
  PaneSessionEventMap,
  PauseReason,
} from "./pane-session.js";

export {
  TmuxModel,
  EMPTY_SNAPSHOT,
  computeDiff,
  isEmptyDiff,
  activeSessionId,
  activeWindowId,
  activePaneId,
  currentSession,
  currentWindow,
  paneLabels,
  findPane,
} from "./model/index.js";
export type {
  TmuxModelClient,
  TmuxModelOptions,
  TmuxModelEventMap,
  TmuxModelError,
  TmuxModelErrorPhase,
  TmuxSnapshot,
  SessionSnapshot,
  WindowSnapshot,
  PaneSnapshot,
  TmuxDiff,
  SessionsDiff,
  WindowsDiff,
  PanesDiff,
  RenamePayload,
} from "./model/index.js";
