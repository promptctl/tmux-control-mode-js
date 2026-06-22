// src/transport/index.ts
// Node.js-only — uses child_process.spawn.

// [LAW:decomposition] This is the layer's public seam, kept a pure re-export so
// the boundary carries no behavior; adding logic here would couple the layer's
// face to its internals.

export type { TmuxTransport, SpawnOptions } from "./types.js";

export { spawnTmux } from "./spawn.js";

export {
  tmuxSocketDir,
  listTmuxSocketNames,
  isTmuxServerAlive,
} from "./sockets.js";
