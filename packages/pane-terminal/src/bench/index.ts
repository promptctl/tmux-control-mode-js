// packages/pane-terminal/src/bench/index.ts
//
// Bench/test fixtures — internal to this package, NOT a published subpath
// export. Importable from `tests/` only via the in-tree path.
//
// This module hosts the deterministic FakeTmuxClient that gates and benches
// exercise without a live tmux — the real implementation surfaces
// (PaneStream, TerminalSink, XtermSink) drive it in place of a spawned
// `tmux -C`.

export {
  FakeTmuxClient,
  type FakeMessage,
  type FakeMessageType,
  type FakeOutputMessage,
  type FakeExtendedOutputMessage,
  type FakeConnectionStateMessage,
  type FakeReconnectedMessage,
} from "./fake-tmux-client.js";
