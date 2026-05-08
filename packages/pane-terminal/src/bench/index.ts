// packages/pane-terminal/src/bench/index.ts
//
// Bench/test fixtures — internal to this package, NOT a published subpath
// export. Importable from `tests/` only via the in-tree path.
//
// Real implementation surfaces (PaneStream, TerminalSink, XtermSink) land in
// later steps of the tmux-pane-terminal-8w9 epic. This module hosts the
// deterministic FakeTmuxClient that gates can use without a live tmux.

export {
  FakeTmuxClient,
  type FakeMessage,
  type FakeMessageType,
  type FakeOutputMessage,
  type FakeExtendedOutputMessage,
  type FakeConnectionStateMessage,
  type FakeReconnectedMessage,
} from "./fake-tmux-client.js";
