// src/transport/index.ts
// Barrel export for the transport layer.
// Node.js-only — uses child_process.spawn.

// [LAW:one-source-of-truth] Re-exports only; no logic lives here.

export type { TmuxTransport, SpawnOptions } from "./types.js";

export { spawnTmux } from "./spawn.js";
