// src/model/index.ts
// Barrel re-exports for the TmuxModel surface.
//
// [LAW:one-source-of-truth] Public exports declared at one boundary
// (./index.ts at the package root) re-export from here. Internal modules
// import from the specific submodule, never the barrel — keeps cycles out.

export { TmuxModel } from "./tmux-model.js";
export type {
  TmuxModelClient,
  TmuxModelOptions,
  TmuxModelEventMap,
} from "./tmux-model.js";
export {
  EMPTY_SNAPSHOT,
  type PaneSnapshot,
  type WindowSnapshot,
  type SessionSnapshot,
  type TmuxSnapshot,
  type RenamePayload,
  type SessionsDiff,
  type WindowsDiff,
  type PanesDiff,
  type TmuxDiff,
  type TmuxModelError,
  type TmuxModelErrorPhase,
} from "./types.js";
export {
  activeSessionId,
  activeWindowId,
  activePaneId,
  currentSession,
  currentWindow,
  paneLabels,
  findPane,
} from "./selectors.js";
export { computeDiff, isEmptyDiff } from "./diff.js";
