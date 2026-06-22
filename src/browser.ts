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
} from "./pane-output.js";
export type {
  BytesSink,
  ChunkPayload,
  AttachOptions,
  PaneScope,
  PaneMeta,
} from "./pane-output.js";

export { isTmuxMessage } from "./emitter.js";
export type {
  TmuxEventMap,
  EmitterMessage,
  EmitterTmuxMessage,
} from "./emitter.js";

export type { CommandResponse, TmuxMessage } from "./protocol/types.js";
export type { ConnectionState } from "./connection-state.js";
export type { TmuxConnection } from "./client.js";

// [LAW:one-type-per-behavior] The free command functions are one family — pure
//   builders over `TmuxConnection` with no transport coupling — so the whole
//   set ships on the browser surface, identical to the root entry's view.
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
} from "./commands/index.js";
