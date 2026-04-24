// src/keymap/index.ts
// Public API for the keymap subpath export.
// [LAW:one-source-of-truth] Consumer-facing exports declared here only.

export type { Action } from "./actions.js";
export type { KeyEvent } from "./key-event.js";
export { keysEqual, parseChord } from "./key-event.js";
export type {
  ChordBinding,
  Keymap,
  KeymapState,
  HandleResult,
} from "./engine.js";
export { INITIAL_STATE, handleKey } from "./engine.js";
export { defaultTmuxKeymap } from "./default-keymap.js";
export type { KeymapBinding, TmuxCommander } from "./bind.js";
export { bindKeymap } from "./bind.js";
