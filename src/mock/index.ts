// src/mock/index.ts
// Public entry for the in-process tmux control-mode mock.
//
// [LAW:one-source-of-truth] Re-exports only. Pure (no Node deps) — usable from
// Node integration tests and the browser tutorial alike.

export { MockTmuxServer } from "./server.js";
export type {
  MockScenario,
  CommandReply,
  MockServerOptions,
} from "./server.js";

// The serializer + octal encoder are the primitives a scenario author reaches
// for when hand-building wire payloads; surfaced here so the mock entry is
// self-sufficient without importing the protocol subpath separately.
export { serializeMessage } from "../protocol/serializer.js";
export { encodeOctalEscapes } from "../protocol/decode.js";
