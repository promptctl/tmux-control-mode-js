// packages/pane-terminal/src/stream/index.ts
//
// Public subpath: `@promptctl/pane-terminal/stream`. The data carrier — no
// DOM, no xterm. Consumers pair this with a sink (BufferingSink in 8w9.5,
// XtermSink in 8w9.6, or a custom one).

export { PaneStream } from "./pane-stream.js";
export type {
  PaneStreamState,
  PaneStreamOptions,
  TmuxConnection,
  PaneActivity,
} from "./pane-stream.js";
export { ReseedScheduler, getScheduler } from "./reseed-scheduler.js";
export type { ReseedPriority, ReseedTarget } from "./reseed-scheduler.js";
