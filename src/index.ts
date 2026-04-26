// tmux-control-mode-js — public API
// [LAW:one-source-of-truth] All consumer-facing exports are declared here only.

export { TmuxClient } from "./client.js";
export type { SplitOptions } from "./client.js";
export { TmuxCommandError } from "./errors.js";

export { PaneAction } from "./protocol/types.js";
export type { CommandResponse, TmuxMessage } from "./protocol/types.js";

export type { TmuxEventMap } from "./emitter.js";

export { spawnTmux } from "./transport/spawn.js";
export type { TmuxTransport, SpawnOptions } from "./transport/types.js";
