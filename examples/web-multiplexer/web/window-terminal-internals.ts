// examples/web-multiplexer/web/window-terminal-internals.ts
//
// REPOSITORY-INTERNAL. Everything re-exported here is engine internals of the
// window-terminal subpath, NOT published API: the package exports none of it,
// and it may change shape without a release. The demo's byte/pane-level views
// (recorder, time machine, sync scroll, collab, mirror, WebGL sink, stress
// store) need these pieces directly, so this one file is the only place the
// demo reaches past the package's exports.
//
// [LAW:one-source-of-truth] Imported from the built dist/, not src/: dist's
// window-terminal modules import the same dist/browser.js the demo's
// `@promptctl/tmux-control-mode-js/browser` resolves to, so there is one module
// instance of `browser` (and of `isConnectionGone` / `getScheduler()` state).
// A src/ alias would bundle a second copy and split that state.
// [LAW:single-enforcer] One shim: every demo file imports engine pieces from
// here, so the internal reach is visible in one place.

export { PaneStream } from "../../../dist/window-terminal/engine/pane-stream.js";
export type {
  PaneActivity,
  PaneStreamOptions,
  PaneStreamState,
} from "../../../dist/window-terminal/engine/pane-stream.js";
export type {
  SeedCursor,
  TerminalSink,
} from "../../../dist/window-terminal/engine/terminal-sink.js";
export { XtermSink } from "../../../dist/window-terminal/render/xterm-sink.js";
